import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * DML linked to the object it changes: besides the `DML:<op>` operation
 * marker (kept for governor checks), a DML statement or `Database.<op>(…)`
 * call whose record expression has a known sObject type emits EXECUTES_DML
 * to `CustomObject:<type>`, like EXECUTES_SOQL, with the operations in `ops`.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

const dmlObjects = (edges: Edge[], src: string) =>
  edges
    .filter(
      (e) =>
        e.relType === "EXECUTES_DML" &&
        String(e.srcQualifiedName) === src &&
        String(e.dstQualifiedName).startsWith("CustomObject:"),
    )
    .map((e) => ({ dst: String(e.dstQualifiedName), ops: e.attributes.ops }))
    .sort((a, b) => a.dst.localeCompare(b.dst));

async function parse(body: string): Promise<Edge[]> {
  const r = await new ApexClassParser().parse({ className: "Svc", body }, makeTestCtx());
  return r.edges as unknown as Edge[];
}

describe("DML -> object (regex path)", () => {
  it("resolves List<T>, Set<T>, T[], T, new T(…), inline SOQL and Database.<op>", async () => {
    const edges = await parse(`public class Svc {
      private List<Lead> leads;
      public void run(List<Opportunity> opps, Widget__c w) {
        List<Account> accts = new List<Account>();
        update accts;
        insert new Contact(LastName = 'x');
        delete [SELECT Id FROM Case WHERE Id = :w.Id];
        Database.update(opps, false);
        upsert w Ext_Id__c;
        Task[] tasks = new Task[]{};
        insert tasks;
        Set<Asset> assets = new Set<Asset>();
        undelete assets;
        update leads;
        Map<Id, Product2> prods = new Map<Id, Product2>();
        update prods.values();
        insert new List<Order>();
      }
    }`);
    expect(dmlObjects(edges, "ApexMethod:Svc.run(2)")).toEqual([
      { dst: "CustomObject:Account", ops: ["update"] },
      { dst: "CustomObject:Asset", ops: ["undelete"] },
      { dst: "CustomObject:Case", ops: ["delete"] },
      { dst: "CustomObject:Contact", ops: ["insert"] },
      { dst: "CustomObject:Lead", ops: ["update"] },
      { dst: "CustomObject:Opportunity", ops: ["update"] },
      { dst: "CustomObject:Order", ops: ["insert"] },
      { dst: "CustomObject:Product2", ops: ["update"] },
      { dst: "CustomObject:Task", ops: ["insert"] },
      { dst: "CustomObject:Widget__c", ops: ["upsert"] },
    ]);
  });

  it("keeps the DML:<op> markers, with `delete [SELECT …]` now counted too", async () => {
    const edges = await parse(`public class Svc {
      public void run() {
        delete [SELECT Id FROM Case];
        insert new Contact(LastName = 'x');
      }
    }`);
    const markers = edges
      .filter((e) => e.relType === "EXECUTES_DML" && String(e.dstQualifiedName).startsWith("DML:"))
      .map((e) => ({ dst: String(e.dstQualifiedName), target: e.attributes.target }))
      .sort((a, b) => a.dst.localeCompare(b.dst));
    // `new` is not a record name: no `target` on the insert marker.
    expect(markers).toEqual([
      { dst: "DML:delete", target: undefined },
      { dst: "DML:insert", target: undefined },
    ]);
  });

  it("merges several operations on one object into one edge, without inLoop", async () => {
    const edges = await parse(`public class Svc {
      public void run(List<Account> accts) {
        insert accts;
        for (Integer i = 0; i < 3; i++) {
          update accts;
        }
      }
    }`);
    const objs = edges.filter(
      (e) => e.relType === "EXECUTES_DML" && String(e.dstQualifiedName) === "CustomObject:Account",
    );
    expect(objs).toHaveLength(1);
    expect(objs[0]?.attributes.ops).toEqual(["insert", "update"]);
    // In-loop detection stays on the DML:<op> marker (one governor finding per statement kind).
    expect(objs[0]?.attributes.inLoop).toBeUndefined();
    const marker = edges.find((e) => String(e.dstQualifiedName) === "DML:update");
    expect(marker?.attributes.inLoop).toBe(true);
  });

  it("emits no object edge for SObject-typed, undeclared or non-record targets", async () => {
    const edges = await parse(`public class Svc {
      public void run(List<SObject> recs, SObject one, Map<Id, Account> byId) {
        update recs;
        insert one;
        delete undeclaredThing;
        Database.insert(buildRecords());
        insert (List<Account>) recs;
      }
    }`);
    expect(dmlObjects(edges, "ApexMethod:Svc.run(3)")).toEqual([]);
  });

  it("does not type a record by a declaration that comes after the statement", async () => {
    const edges = await parse(`public class Svc {
      public void run() {
        update accts;
        List<Account> accts = new List<Account>();
      }
    }`);
    expect(dmlObjects(edges, "ApexMethod:Svc.run(0)")).toEqual([]);
  });
});

describe("DML -> object in triggers", () => {
  it("resolves typed locals and Trigger.new / Trigger.old", async () => {
    const r = await new ApexTriggerParser().parse(
      {
        triggerName: "AccTrg",
        body: `trigger AccTrg on Account (after update) {
          List<Contact> cs = new List<Contact>();
          update cs;
          delete Trigger.old;
          Database.insert(new Case(Subject = 'x'));
        }`,
      },
      makeTestCtx(),
    );
    expect(dmlObjects(r.edges as unknown as Edge[], "ApexTrigger:AccTrg")).toEqual([
      { dst: "CustomObject:Account", ops: ["delete"] },
      { dst: "CustomObject:Case", ops: ["insert"] },
      { dst: "CustomObject:Contact", ops: ["update"] },
    ]);
  });
});
