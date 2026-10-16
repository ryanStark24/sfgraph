import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveDataRaptorRelationships } from "../dr-relationship-resolver.js";

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

const READ = REL_TYPES.DR_READS_FIELD;

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
    node("DataRaptor:Sample", "DataRaptor", { drRelationshipPaths: paths }),
    node("CustomObject:Widget__c", "CustomObject"),
    node("CustomObject:Maker__c", "CustomObject"),
    // Lookup whose relationship name differs from its field name.
    node("CustomField:Widget__c.Built_By__c", "CustomField", {
      referenceTo: ["Maker__c"],
      relationshipName: "Builder",
    }),
    node("CustomField:Widget__c.Maker__c", "CustomField", {
      referenceTo: ["Maker__c"],
      relationshipName: "Maker",
    }),
    node("CustomField:Widget__c.Either__c", "CustomField", {
      referenceTo: ["Maker__c", "Account"],
      relationshipName: "Either",
    }),
    // A plain (non-lookup) field whose name matches another lookup's relationship.
    node("CustomField:Widget__c.Builder__c", "CustomField", { type: "Text" }),
    node("CustomField:Maker__c.Region__c", "CustomField"),
    node("CustomField:Maker__c.Account__c", "CustomField", {
      referenceTo: ["Account"],
      relationshipName: "Account",
    }),
  ]);
  store.mergeEdges([
    defines("Widget__c", "Built_By__c"),
    defines("Widget__c", "Maker__c"),
    defines("Widget__c", "Builder__c"),
    defines("Widget__c", "Either__c"),
    defines("Maker__c", "Region__c"),
    defines("Maker__c", "Account__c"),
  ]);
  return store;
}

const dsts = (store: SqliteGraphStore) =>
  store
    .listEdgesFrom(orgId, asQualifiedName("DataRaptor:Sample"))
    .map((e) => `${e.relType}->${e.dstQualifiedName}`)
    .sort();

describe("resolveDataRaptorRelationships", () => {
  it("resolves X__r hops through field referenceTo (field name or relationshipName)", async () => {
    const store = await seed([
      { object: "Widget__c", path: "Maker__r.Region__c", rel: READ },
      { object: "Widget__c", path: "Builder__r.Account__r.Name", rel: READ },
    ]);
    resolveDataRaptorRelationships(store, orgId, makeTestCtx());
    expect(dsts(store)).toEqual([
      "DR_READS_FIELD->CustomField:Account.Name",
      "DR_READS_FIELD->CustomField:Maker__c.Account__c",
      "DR_READS_FIELD->CustomField:Maker__c.Region__c",
      "DR_READS_FIELD->CustomField:Widget__c.Built_By__c",
      "DR_READS_FIELD->CustomField:Widget__c.Maker__c",
    ]);
  });

  it("resolves standard relationship names that are standard objects", async () => {
    const store = await seed([
      { object: "Widget__c", path: "RecordType.DeveloperName", rel: READ },
    ]);
    resolveDataRaptorRelationships(store, orgId, makeTestCtx());
    expect(dsts(store)).toEqual(["DR_READS_FIELD->CustomField:RecordType.DeveloperName"]);
  });

  it("emits nothing past a hop it cannot resolve (unknown, polymorphic, non-object)", async () => {
    const store = await seed([
      { object: "Widget__c", path: "Ghost__r.Region__c", rel: READ },
      { object: "Widget__c", path: "Either__r.Name", rel: READ },
      { object: "Widget__c", path: "CreatedBy.Name", rel: READ },
      { object: "Widget__c", path: "Maker__r.Nowhere__r.Name", rel: READ },
    ]);
    const res = resolveDataRaptorRelationships(store, orgId, makeTestCtx());
    // Only the resolvable first hops (real lookup fields) are emitted.
    expect(dsts(store)).toEqual([
      "DR_READS_FIELD->CustomField:Widget__c.Either__c",
      "DR_READS_FIELD->CustomField:Widget__c.Maker__c",
    ]);
    expect(res).toMatchObject({ scanned: 4, resolved: 0, unresolved: 4 });
  });

  it("is idempotent", async () => {
    const store = await seed([{ object: "Widget__c", path: "Maker__r.Region__c", rel: READ }]);
    resolveDataRaptorRelationships(store, orgId, makeTestCtx());
    const before = dsts(store);
    resolveDataRaptorRelationships(store, orgId, makeTestCtx());
    expect(dsts(store)).toEqual(before);
    const e = store
      .listEdgesFrom(orgId, asQualifiedName("DataRaptor:Sample"))
      .find((x) => x.dstQualifiedName === "CustomField:Maker__c.Region__c");
    expect(e?.attributes).toMatchObject({
      resolvedBy: "dr-relationship-resolver",
      path: "Maker__r.Region__c",
    });
  });

  it("prefers the unique relationshipName lookup over a non-lookup X__c field", async () => {
    const store = await seed([{ object: "Widget__c", path: "Builder__r.Region__c", rel: READ }]);
    const res = resolveDataRaptorRelationships(store, orgId, makeTestCtx());
    expect(dsts(store)).toEqual([
      "DR_READS_FIELD->CustomField:Maker__c.Region__c",
      "DR_READS_FIELD->CustomField:Widget__c.Built_By__c",
    ]);
    expect(res).toMatchObject({ resolved: 1, unresolved: 0 });
  });
});
