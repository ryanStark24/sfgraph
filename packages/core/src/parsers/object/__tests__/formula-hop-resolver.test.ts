import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { resolveFormulaRelationshipHops } from "../formula-hop-resolver.js";

const orgId = asOrgId("org_test");
const ts = Date.now();
const node = (qn: string, label: string, attributes: Record<string, unknown> = {}) => ({
  orgId,
  qualifiedName: asQualifiedName(qn),
  label,
  attributes,
  sourceHash: asSha256(qn),
  firstSeenAt: ts,
  lastSeenAt: ts,
  lastModifiedAt: ts,
});
const read = (src: string, dst: string, attributes: Record<string, unknown>) => ({
  orgId,
  srcQualifiedName: asQualifiedName(src),
  dstQualifiedName: asQualifiedName(dst),
  relType: REL_TYPES.READS_FIELD,
  attributes,
  firstSeenAt: ts,
  lastSeenAt: ts,
});

describe("review N-6: formula second-hop resolver", () => {
  it("moves a guessed X__c hop onto the field that declares relationship X", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: 1,
    });
    store.mergeNodes([
      node("CustomField:Patch__c.F__c", "CustomField", { formula: "x" }),
      node("CustomField:Region__c.Lead_Contact__c", "CustomField", {
        object: "Region__c",
        relationshipName: "Area_Lead",
        referenceTo: ["Contact"],
      }),
    ]);
    store.mergeEdges([
      read("CustomField:Patch__c.F__c", "CustomField:Region__c.Area_Lead__c", {
        via: "formula",
        hopRelationship: "Area_Lead__r",
      }),
      read("CustomField:Patch__c.F__c", "CustomField:Region__c.Other__c", {
        via: "formula",
        hopRelationship: "Other__r",
      }),
    ]);
    const res = resolveFormulaRelationshipHops(store, orgId);
    expect(res).toMatchObject({ scanned: 2, moved: 1 });
    const dsts = store
      .listEdgesFrom(orgId, asQualifiedName("CustomField:Patch__c.F__c"), REL_TYPES.READS_FIELD)
      .map((e) => String(e.dstQualifiedName))
      .sort();
    // No field declares `Other`: the X__c fallback stays.
    expect(dsts).toEqual([
      "CustomField:Region__c.Lead_Contact__c",
      "CustomField:Region__c.Other__c",
    ]);
    expect(resolveFormulaRelationshipHops(store, orgId).moved).toBe(0);
  });
  it("skips the move when two fields on one object declare the same relationshipName", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: 1,
    });
    store.mergeNodes([
      node("CustomField:Patch__c.F__c", "CustomField", { formula: "x" }),
      node("CustomField:Region__c.Lead_A__c", "CustomField", {
        object: "Region__c",
        relationshipName: "Area_Lead",
      }),
      node("CustomField:Region__c.Lead_B__c", "CustomField", {
        object: "Region__c",
        relationshipName: "Area_Lead",
      }),
    ]);
    store.mergeEdges([
      read("CustomField:Patch__c.F__c", "CustomField:Region__c.Area_Lead__c", {
        via: "formula",
        hopRelationship: "Area_Lead__r",
      }),
    ]);
    const res = resolveFormulaRelationshipHops(store, orgId);
    expect(res.moved).toBe(0);
    expect(
      store
        .listEdgesFrom(orgId, asQualifiedName("CustomField:Patch__c.F__c"), REL_TYPES.READS_FIELD)
        .map((e) => String(e.dstQualifiedName)),
    ).toEqual(["CustomField:Region__c.Area_Lead__c"]);
  });

  it("the sources option limits the scan to the given formula/VR nodes", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: 1,
    });
    store.mergeNodes([
      node("CustomField:Patch__c.F__c", "CustomField", { formula: "x" }),
      node("CustomField:Patch__c.G__c", "CustomField", { formula: "y" }),
      node("CustomField:Region__c.Lead_Contact__c", "CustomField", {
        object: "Region__c",
        relationshipName: "Area_Lead",
      }),
    ]);
    store.mergeEdges([
      read("CustomField:Patch__c.F__c", "CustomField:Region__c.Area_Lead__c", {
        hopRelationship: "Area_Lead__r",
      }),
      read("CustomField:Patch__c.G__c", "CustomField:Region__c.Area_Lead__c", {
        hopRelationship: "Area_Lead__r",
      }),
    ]);
    const res = resolveFormulaRelationshipHops(store, orgId, {
      sources: new Set(["CustomField:Patch__c.G__c"]),
    });
    expect(res).toMatchObject({ scanned: 1, moved: 1 });
    expect(
      store
        .listEdgesFrom(orgId, asQualifiedName("CustomField:Patch__c.F__c"), REL_TYPES.READS_FIELD)
        .map((e) => String(e.dstQualifiedName)),
    ).toEqual(["CustomField:Region__c.Area_Lead__c"]);
  });
});
