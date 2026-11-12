import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";

/**
 * Data Cloud objects (`__dlm`, `__dll`, `__cio`), custom change events
 * (`__ChangeEvent`) and the FinServ managed namespace must be treated as
 * SObjects / managed code, not as user Apex classes.
 */
type Edge = { relType: string; srcQualifiedName: unknown; dstQualifiedName: unknown };

async function parseEdges(body: string) {
  const r = await new ApexClassParser().parse({ className: "DcService", body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return r.edges as unknown as Edge[];
}

const dsts = (edges: Edge[], rel: string) =>
  edges
    .filter((e) => e.relType === rel)
    .map((e) => String(e.dstQualifiedName))
    .sort();

describe("Apex: Data Cloud and change-event suffixes", () => {
  it.each(["__dlm", "__dll", "__cio", "__ChangeEvent"])(
    "member access on a %s-typed variable yields field reads and writes",
    async (suffix) => {
      const obj = `Thing${suffix}`;
      const body = `public class DcService {
        public void run(${obj} rec) {
          rec.Score__c = 1;
          Integer x = rec.Rank__c;
        }
      }`;
      const edges = await parseEdges(body);
      expect(dsts(edges, "WRITES_FIELD")).toContain(`CustomField:${obj}.Score__c`);
      expect(dsts(edges, "READS_FIELD")).toContain(`CustomField:${obj}.Rank__c`);
    },
  );

  it("SOQL on a __dlm object reads the object's fields", async () => {
    const body = `public class DcService {
      public void run() {
        List<Individual__dlm> rows = [SELECT Id, Email__c FROM Individual__dlm];
      }
    }`;
    const edges = await parseEdges(body);
    expect(dsts(edges, "READS_FIELD")).toContain("CustomField:Individual__dlm.Email__c");
  });

  it("does not treat a FinServ managed-package call as a user class reference", async () => {
    const body = `public class DcService {
      public void run() { FinServ.SomeHelper.doIt(); }
    }`;
    const edges = await parseEdges(body);
    const classRefs = edges.filter((e) =>
      String(e.dstQualifiedName).toLowerCase().includes("finserv"),
    );
    expect(classRefs).toEqual([]);
  });
});
