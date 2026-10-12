import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Reference completeness in the default (regex) Apex path: `new Foo(…)`
 * → INSTANCE_OF ApexClass:Foo, `Foo.IDENT` (constant / enum value / inner type)
 * → REFERENCES ApexClass:Foo, and the static-call / constructor / member rules
 * also run on trigger bodies. System types, SObjects, local variables, local
 * types, comments and strings never yield an edge.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

function dsts(edges: Edge[], rel: string, src?: string): string[] {
  return edges
    .filter((e) => e.relType === rel && (src === undefined || String(e.srcQualifiedName) === src))
    .map((e) => String(e.dstQualifiedName))
    .sort();
}

async function parseClass(className: string, body: string): Promise<Edge[]> {
  const r = await new ApexClassParser().parse({ className, body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return r.edges as unknown as Edge[];
}

async function parseTrigger(triggerName: string, body: string): Promise<Edge[]> {
  const r = await new ApexTriggerParser().parse({ triggerName, body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return r.edges as unknown as Edge[];
}

describe("ApexClassParser: constructor and static-member references", () => {
  it("emits INSTANCE_OF for `new Foo(` on user classes only", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets {
        public void run() {
          WidgetService svc = new WidgetService(1, 'a');
          Account a = new Account(Name = 'x');
          Gadget__c g = new Gadget__c();
          HttpRequest req = new HttpRequest();
          List<String> xs = new List<String>();
          Widgets self = new Widgets();
          Helper h = new Helper();
          // new CommentedOut();
          String s = 'new InString()';
        }
        private class Helper {}
      }`,
    );
    const m = "ApexMethod:Widgets.run(0)";
    expect(dsts(edges, "INSTANCE_OF", m)).toEqual(["ApexClass:WidgetService"]);
    const e = edges.find((x) => x.relType === "INSTANCE_OF");
    expect(e?.attributes.arity).toBe(2);
  });

  it("emits REFERENCES for `Foo.IDENT` on class-like names", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets {
        public String run(Integer Count) {
          String a = WidgetConstants.STATUS_OPEN;
          WidgetKind k = WidgetKind.LARGE;
          Outer.Inner inner = null;
          Integer n = Count.intValue();
          Integer v = Count.MAX_VALUE;
          String lbl = System.Label.Foo;
          Boolean t = Trigger.isExecuting;
          Schema.SObjectField f = Account.Name;
          Object o = Gadget__c.Size__c;
          String me = Widgets.LOCAL_CONST;
          Helper.Mode md = Helper.Mode.A;
          Integer r = WidgetMath.square(2);
          // String c = CommentedConstants.X;
          String q = 'StringConstants.X';
          return a;
        }
        public class Helper { public enum Mode { A } }
      }`,
    );
    expect(dsts(edges, "REFERENCES", "ApexMethod:Widgets.run(1)")).toEqual([
      "ApexClass:Outer",
      "ApexClass:WidgetConstants",
      "ApexClass:WidgetKind",
    ]);
  });

  it("skips relationship paths in inline SOQL but keeps bind expressions", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets {
        public void run() {
          List<Contact> cs = [SELECT Owner.Name, Parent__r.Name FROM Contact WHERE Status__c = :WidgetConstants.OPEN];
        }
      }`,
    );
    expect(dsts(edges, "REFERENCES", "ApexMethod:Widgets.run(0)")).toEqual([
      "ApexClass:WidgetConstants",
    ]);
  });

  it("attributes class-level initializers and constructor bodies to the class", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets {
        private static final String MODE = WidgetConstants.MODE;
        private WidgetService svc = new WidgetService();
        public Widgets() {
          WidgetRegistry.register(this);
        }
        public void run() {}
      }`,
    );
    expect(dsts(edges, "REFERENCES", "ApexClass:Widgets")).toEqual(["ApexClass:WidgetConstants"]);
    expect(dsts(edges, "INSTANCE_OF", "ApexClass:Widgets")).toEqual(["ApexClass:WidgetService"]);
    expect(dsts(edges, "CALLS", "ApexClass:Widgets")).toEqual([
      "ApexMethod:WidgetRegistry.register(1)",
    ]);
  });
});

describe("ApexClassParser: static-call arity with string arguments", () => {
  it("counts a string-literal argument toward the call's arity", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets {
        public void run() {
          WidgetLog.write('started');
          WidgetLog.pair('a, b', 'c');
        }
      }`,
    );
    expect(dsts(edges, "CALLS", "ApexMethod:Widgets.run(0)")).toEqual([
      "ApexMethod:WidgetLog.pair(2)",
      "ApexMethod:WidgetLog.write(1)",
    ]);
  });
});

describe("ApexTriggerParser: static calls, constructors and static members", () => {
  it("emits CALLS, INSTANCE_OF and REFERENCES from the trigger body", async () => {
    const edges = await parseTrigger(
      "WidgetTrigger",
      `trigger WidgetTrigger on Widget__c (before insert, after update) {
        if (RecursionGuard.runOnce()) {
          new WidgetTriggerHandler().run();
          WidgetHelper.apply(Trigger.new, WidgetConstants.MODE);
        }
        // LegacyHandler.run();
        System.debug('WidgetNoise.X');
      }`,
    );
    const t = "ApexTrigger:WidgetTrigger";
    expect(dsts(edges, "CALLS", t)).toEqual([
      "ApexMethod:RecursionGuard.runOnce(0)",
      "ApexMethod:System.debug(1)",
      "ApexMethod:WidgetHelper.apply(2)",
    ]);
    expect(dsts(edges, "INSTANCE_OF", t)).toEqual(["ApexClass:WidgetTriggerHandler"]);
    expect(dsts(edges, "REFERENCES", t)).toEqual(["ApexClass:WidgetConstants"]);
  });
});

describe("round-3 fix 1: skip lists, case-insensitive variables, dotted chains", () => {
  it("skips system interfaces/enums, *Share/*History/*Feed objects and managed namespaces", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets {
        public void run() {
          Test.setMock(HttpCalloutMock.class, null);
          Decimal d = x.setScale(2, RoundingMode.HALF_UP);
          AccountShare s = new AccountShare();
          Object h = OpportunityHistory.Field;
          Object f = CaseFeed.Body;
          Object v = Vlocity_cmt.Foo;
          ContentDistribution cd = new ContentDistribution();
          String k = WidgetConstants.KIND;
        }
      }`,
    );
    expect(dsts(edges, "REFERENCES", "ApexMethod:Widgets.run(0)")).toEqual([
      "ApexClass:WidgetConstants",
    ]);
    expect(dsts(edges, "INSTANCE_OF", "ApexMethod:Widgets.run(0)")).toEqual([]);
  });

  it("treats a variable as declared regardless of case, unless the name is also a type", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets {
        public void run() {
          Opportunity opp = new Opportunity();
          Opp.StageName = 'x';
          WidgetService widgetService = null;
          String m = WidgetService.MODE;
        }
      }`,
    );
    expect(dsts(edges, "REFERENCES", "ApexMethod:Widgets.run(0)")).toEqual([
      "ApexClass:WidgetService",
    ]);
  });

  it("does not read a static call out of a dotted chain", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets {
        public void run() {
          Integer i = WidgetKind.LARGE.ordinal();
        }
      }`,
    );
    expect(dsts(edges, "CALLS", "ApexMethod:Widgets.run(0)")).toEqual([]);
  });
});

describe("round-3 fix 1: static-call edges are ordinary parser edges", () => {
  it("carries no resolvedBy attribute", async () => {
    const edges = await parseClass(
      "Widgets",
      `public class Widgets { public void run() { WidgetLog.write('x'); } }`,
    );
    const c = edges.find((e) => e.relType === "CALLS");
    expect(c?.attributes.resolvedBy).toBeUndefined();
    expect(c?.attributes.callResolution).toBe("regex-arg-count");
  });

  it("a re-parse with changed arity prunes the old CALLS edge in the store", async () => {
    const ctx = makeTestCtx();
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: asOrgId(ctx.orgId),
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: 1,
    });
    const parse = (call: string) =>
      new ApexClassParser().parse(
        { className: "Widgets", body: `public class Widgets { public void run() { ${call}; } }` },
        ctx,
      );
    const v1 = await parse("WidgetLog.write()");
    store.mergeNodes(v1.nodes);
    store.mergeEdges(v1.edges, { reconcileSources: true });
    const v2 = await parse("WidgetLog.write('x')");
    store.mergeNodes(v2.nodes);
    store.mergeEdges(v2.edges, { reconcileSources: true });
    const calls = store
      .listEdgesFrom(asOrgId(ctx.orgId), asQualifiedName("ApexMethod:Widgets.run(0)"))
      .filter((e) => e.relType === "CALLS")
      .map((e) => String(e.dstQualifiedName));
    expect(calls).toEqual(["ApexMethod:WidgetLog.write(1)"]);
  });
});
