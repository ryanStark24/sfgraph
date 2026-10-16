import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { FlowParser } from "../parser.js";
import { resolveFlowRelationshipPaths } from "../relationship-resolver.js";

const orgId = asOrgId("00Dxx0000000ABCEAA");

function node(qn: string, label: string, attrs: Record<string, unknown> = {}) {
  const ts = Date.now();
  return {
    orgId,
    qualifiedName: asQualifiedName(qn),
    label,
    attributes: attrs,
    sourceHash: asSha256(qn),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}

function defines(obj: string, field: string) {
  const ts = Date.now();
  return {
    orgId,
    srcQualifiedName: asQualifiedName(`CustomObject:${obj}`),
    dstQualifiedName: asQualifiedName(`CustomField:${obj}.${field}`),
    relType: REL_TYPES.DEFINES_FIELD,
    attributes: {},
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

const R = "READS_FIELD";
const W = "WRITES_FIELD";

async function seed(paths: Array<{ object: string; path: string; rel: string }>) {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({
    id: orgId,
    alias: "test",
    instanceUrl: "https://example.test",
    apiVersion: "59.0",
    createdAt: Date.now(),
  });
  store.mergeNodes([
    node("Flow:Sample", "Flow", { flowRelationshipPaths: paths }),
    node("CustomObject:Order", "CustomObject"),
    node("CustomObject:Region__c", "CustomObject"),
    // Lookup whose relationship name differs from its field name.
    node("CustomField:Order.Sales_Region__c", "CustomField", {
      referenceTo: ["Region__c"],
      relationshipName: "Territory",
    }),
    node("CustomField:Region__c.Lead__c", "CustomField", {}),
    node("CustomField:Task.WhatId", "CustomField", { referenceTo: ["Account", "Opportunity"] }),
  ]);
  store.mergeEdges([
    defines("Order", "Sales_Region__c"),
    defines("Region__c", "Lead__c"),
    defines("Task", "WhatId"),
  ]);
  return store;
}

const dsts = (store: SqliteGraphStore) =>
  store
    .listEdgesFrom(orgId, asQualifiedName("Flow:Sample"))
    .map((e) => `${e.relType}->${e.dstQualifiedName}`)
    .sort();

describe("resolveFlowRelationshipPaths", () => {
  it("standard relationships: the lookup on the start object and the field on the related one", async () => {
    const store = await seed([
      { object: "Order", path: "Account.Region__c", rel: R },
      { object: "Order", path: "Owner.Email", rel: R },
      { object: "Case", path: "Parent.Account.Name", rel: R },
    ]);
    resolveFlowRelationshipPaths(store, orgId, makeTestCtx());
    expect(dsts(store)).toEqual([
      "READS_FIELD->CustomField:Account.Name",
      "READS_FIELD->CustomField:Account.Region__c",
      "READS_FIELD->CustomField:Case.AccountId",
      "READS_FIELD->CustomField:Case.ParentId",
      "READS_FIELD->CustomField:Order.AccountId",
      "READS_FIELD->CustomField:Order.OwnerId",
      "READS_FIELD->CustomField:User.Email",
    ]);
  });

  it("custom relationships resolve through relationshipName / referenceTo; writes keep their rel", async () => {
    const store = await seed([
      { object: "Order", path: "Territory__r.Lead__c", rel: R },
      { object: "Order", path: "Territory__r.Code__c", rel: W },
      { object: "Order", path: "Territory__r", rel: R },
    ]);
    resolveFlowRelationshipPaths(store, orgId, makeTestCtx());
    expect(dsts(store)).toEqual([
      "READS_FIELD->CustomField:Order.Sales_Region__c",
      "READS_FIELD->CustomField:Region__c.Lead__c",
      "WRITES_FIELD->CustomField:Region__c.Code__c",
    ]);
  });

  it("negative: an unresolvable hop emits nothing for the tail", async () => {
    const store = await seed([
      { object: "Order", path: "Mystery__r.Name", rel: R },
      { object: "Order", path: "Gadget.Name", rel: R },
      { object: "Task", path: "What.Name", rel: R },
      { object: "Order", path: "Account.Owner", rel: R },
    ]);
    const res = resolveFlowRelationshipPaths(store, orgId, makeTestCtx());
    // The polymorphic lookup itself is read; nothing past it.
    expect(dsts(store)).toEqual([
      "READS_FIELD->CustomField:Order.AccountId",
      "READS_FIELD->CustomField:Task.WhatId",
    ]);
    expect(res.unresolved).toBe(4);
  });

  it("is idempotent, prunes stale output and leaves parser edges alone", async () => {
    const store = await seed([{ object: "Order", path: "Account.Region__c", rel: R }]);
    const ts = Date.now();
    store.mergeEdges([
      {
        orgId,
        srcQualifiedName: asQualifiedName("Flow:Sample"),
        dstQualifiedName: asQualifiedName("CustomField:Order.AccountId"),
        relType: REL_TYPES.READS_FIELD,
        attributes: { via: "reference" },
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);
    resolveFlowRelationshipPaths(store, orgId, makeTestCtx());
    resolveFlowRelationshipPaths(store, orgId, makeTestCtx());
    const edges = store.listEdgesFrom(orgId, asQualifiedName("Flow:Sample"));
    expect(edges).toHaveLength(2);
    const parserEdge = edges.find((e) => String(e.dstQualifiedName).endsWith("AccountId"));
    expect(parserEdge?.attributes).toEqual({ via: "reference" });

    // A re-parse drops the path (new hash, so the merge rewrites attributes).
    store.mergeNodes([
      { ...node("Flow:Sample", "Flow", {}), sourceHash: asSha256("Flow:Sample:v2") },
    ]);
    resolveFlowRelationshipPaths(store, orgId, makeTestCtx());
    expect(dsts(store)).toEqual(["READS_FIELD->CustomField:Order.AccountId"]);
  });

  it("end to end: a parsed $Record.Account.Region__c reaches Account.Region__c", async () => {
    const r = await new FlowParser().parse(
      {
        fullName: "Sample",
        xml: `<?xml version="1.0" encoding="UTF-8"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion>
          <formulas><name>F</name><dataType>String</dataType><expression>{!$Record.Account.Region__c}</expression></formulas>
          <recordUpdates><name>U</name>
            <inputAssignments><field>Tier__c</field><value><stringValue>Gold</stringValue></value></inputAssignments>
            <inputReference>$Record.Account</inputReference>
          </recordUpdates>
          <start><object>Order</object><triggerType>RecordAfterSave</triggerType></start></Flow>`,
      },
      makeTestCtx(),
    );
    const store = await seed([]);
    const flowNode = r.nodes.find((n) => n.label === "Flow");
    if (!flowNode) throw new Error("no Flow node");
    store.mergeNodes([{ ...flowNode, orgId }]);
    store.mergeEdges(r.edges.map((e) => ({ ...e, orgId })));
    resolveFlowRelationshipPaths(store, orgId, makeTestCtx());
    expect(dsts(store).filter((d) => d.startsWith(`${R}->`) || d.startsWith(`${W}->`))).toEqual([
      "READS_FIELD->CustomField:Account.Region__c",
      "READS_FIELD->CustomField:Order.AccountId",
      "WRITES_FIELD->CustomField:Account.Tier__c",
    ]);
  });
});
