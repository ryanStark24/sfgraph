import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../index.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Audit corecorr-07: two EXECUTES_SOQL facts with the same (src,dst,rel) key
 * are merged last-wins, so a SOQL inside a loop followed by one outside the
 * loop on the same object is stored without inLoop.
 */
describe("audit corecorr-07: duplicate SOQL facts keep inLoop", () => {
  it("stores inLoop=true when any SOQL on the object runs inside a loop", async () => {
    const result = await new ApexClassParser().parse(
      {
        className: "Gov",
        metaXml: "<ApexClass/>",
        body: `
        public class Gov {
          public void run(List<Id> ids) {
            for (Id i : ids) {
              Account a = [SELECT Id FROM Account WHERE Id = :i];
            }
            List<Account> after = [SELECT Id FROM Account LIMIT 1];
          }
        }
      `,
      },
      makeTestCtx(),
    );
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    const orgId = asOrgId("org_test");
    store.upsertOrg({
      id: orgId,
      alias: "test",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    store.mergeNodes(result.nodes);
    store.mergeEdges(result.edges);
    const src = result.edges.find(
      (e) => e.relType === "EXECUTES_SOQL" && String(e.dstQualifiedName) === "CustomObject:Account",
    )?.srcQualifiedName;
    expect(src).toBeDefined();
    const stored = store
      .listEdgesFrom(orgId, asQualifiedName(String(src)))
      .filter(
        (e) =>
          e.relType === "EXECUTES_SOQL" && String(e.dstQualifiedName) === "CustomObject:Account",
      );
    expect(stored).toHaveLength(1);
    expect((stored[0]?.attributes as { inLoop?: boolean }).inLoop).toBe(true);
  });

  it("keeps inLoop on a trigger whose in-loop DML is followed by an out-of-loop DML", async () => {
    const result = await new ApexTriggerParser().parse(
      {
        triggerName: "TxnTrigger",
        metaXml: "<ApexTrigger/>",
        body: `trigger TxnTrigger on Account (after update) {
          for (Account a : Trigger.new) {
            insert new Contact(LastName = 'x');
          }
          insert new List<Contact>();
        }`,
      },
      makeTestCtx(),
    );
    const dml = result.edges.filter(
      (e) => e.relType === "EXECUTES_DML" && String(e.dstQualifiedName) === "DML:insert",
    );
    expect(dml).toHaveLength(1);
    expect((dml[0]?.attributes as { inLoop?: boolean }).inLoop).toBe(true);
  });
});
