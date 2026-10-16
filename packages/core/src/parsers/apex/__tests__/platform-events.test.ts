import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Platform events: `EventBus.publish(x)` with an `X__e`-typed argument
 * (record, list, `new X__e(…)`) -> PUBLISHES_EVENT `CustomObject:X__e` (the
 * object parser's PlatformEvent node); a trigger on an `X__e` object ->
 * SUBSCRIBES_TO_EVENT to it.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

const dsts = (edges: Edge[], rel: string, src: string): string[] =>
  edges
    .filter((e) => e.relType === rel && String(e.srcQualifiedName) === src)
    .map((e) => String(e.dstQualifiedName))
    .sort();

describe("EventBus.publish", () => {
  it("links a typed record, a typed list and an inline new", async () => {
    const body = `public class Pub {
      public void run(Order_Event__e one) {
        List<Invoice_Event__e> evts = new List<Invoice_Event__e>();
        EventBus.publish(one);
        EventBus.publish(evts);
        Database.SaveResult sr = EventBus.publish(new Ship_Event__e(Code__c = 'x'));
        eventbus.PUBLISH(new List<Audit_Event__e>{ new Audit_Event__e() });
      }
    }`;
    const r = await new ApexClassParser().parse({ className: "Pub", body }, makeTestCtx());
    expect(dsts(r.edges as unknown as Edge[], "PUBLISHES_EVENT", "ApexMethod:Pub.run(1)")).toEqual([
      "CustomObject:Audit_Event__e",
      "CustomObject:Invoice_Event__e",
      "CustomObject:Order_Event__e",
      "CustomObject:Ship_Event__e",
    ]);
  });

  it("emits nothing for a non-event or unresolvable argument", async () => {
    const body = `public class Pub {
      public void run(List<SObject> recs, Account acc) {
        EventBus.publish(recs);
        EventBus.publish(acc);
        EventBus.publish(build());
        EventBus.publish(undeclared);
      }
    }`;
    const r = await new ApexClassParser().parse({ className: "Pub", body }, makeTestCtx());
    expect(dsts(r.edges as unknown as Edge[], "PUBLISHES_EVENT", "ApexMethod:Pub.run(2)")).toEqual(
      [],
    );
  });

  it("links a publish in a trigger body", async () => {
    const r = await new ApexTriggerParser().parse(
      {
        triggerName: "AccTrg",
        body: `trigger AccTrg on Account (after insert) {
          EventBus.publish(new Account_Changed__e());
        }`,
      },
      makeTestCtx(),
    );
    expect(dsts(r.edges as unknown as Edge[], "PUBLISHES_EVENT", "ApexTrigger:AccTrg")).toEqual([
      "CustomObject:Account_Changed__e",
    ]);
  });
});

describe("platform event triggers", () => {
  it("a trigger on an __e object subscribes to it", async () => {
    const r = await new ApexTriggerParser().parse(
      {
        triggerName: "OrderEvtTrg",
        body: "trigger OrderEvtTrg on Order_Event__e (after insert) { }",
      },
      makeTestCtx(),
    );
    const edges = r.edges as unknown as Edge[];
    expect(dsts(edges, "SUBSCRIBES_TO_EVENT", "ApexTrigger:OrderEvtTrg")).toEqual([
      "CustomObject:Order_Event__e",
    ]);
    expect(dsts(edges, "TRIGGERS_ON", "ApexTrigger:OrderEvtTrg")).toEqual([
      "CustomObject:Order_Event__e",
    ]);
  });

  it("a trigger on a data object does not subscribe", async () => {
    const r = await new ApexTriggerParser().parse(
      { triggerName: "AccTrg", body: "trigger AccTrg on Account (after insert) { }" },
      makeTestCtx(),
    );
    expect(dsts(r.edges as unknown as Edge[], "SUBSCRIBES_TO_EVENT", "ApexTrigger:AccTrg")).toEqual(
      [],
    );
  });
});
