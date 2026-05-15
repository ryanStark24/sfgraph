import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { auditDanglingEdges, deleteDanglingEdges } from "../audit-graph.js";

async function seed() {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  const orgId = asOrgId("org_audit");
  store.upsertOrg({
    id: orgId,
    alias: "test",
    instanceUrl: "https://example.test",
    apiVersion: "59.0",
    createdAt: Date.now(),
  });
  const ts = Date.now();
  // Two real nodes
  store.mergeNodes([
    {
      orgId,
      qualifiedName: asQualifiedName("ApexClass:Foo"),
      label: "ApexClass",
      attributes: {},
      sourceHash: asSha256("foo"),
      firstSeenAt: ts,
      lastSeenAt: ts,
      lastModifiedAt: ts,
    },
    {
      orgId,
      qualifiedName: asQualifiedName("ApexMethod:Foo.bar(2)"),
      label: "ApexMethod",
      attributes: {},
      sourceHash: asSha256("foobar"),
      firstSeenAt: ts,
      lastSeenAt: ts,
      lastModifiedAt: ts,
    },
  ]);
  // Three edges: one good, two dangling
  store.mergeEdges([
    {
      orgId,
      srcQualifiedName: asQualifiedName("ApexClass:Foo"),
      dstQualifiedName: asQualifiedName("ApexMethod:Foo.bar(2)"),
      relType: REL_TYPES.CONTAINS_METHOD,
      attributes: {},
      firstSeenAt: ts,
      lastSeenAt: ts,
    },
    {
      orgId,
      srcQualifiedName: asQualifiedName("ApexMethod:Foo.bar(2)"),
      dstQualifiedName: asQualifiedName("ApexMethod:Ghost.notReal(?)"),
      relType: REL_TYPES.CALLS,
      attributes: {},
      firstSeenAt: ts,
      lastSeenAt: ts,
    },
    {
      orgId,
      srcQualifiedName: asQualifiedName("ApexMethod:Foo.bar(2)"),
      dstQualifiedName: asQualifiedName("CustomField:Account.Phantom__c"),
      relType: REL_TYPES.READS_FIELD,
      attributes: {},
      firstSeenAt: ts,
      lastSeenAt: ts,
    },
  ]);
  return { store, orgId };
}

describe("auditDanglingEdges", () => {
  it("reports dangling edges grouped by relType and dst prefix", async () => {
    const { store, orgId } = await seed();
    const result = auditDanglingEdges(store, orgId);

    expect(result.totalEdges).toBe(3);
    expect(result.danglingCount).toBe(2);
    expect(result.byRel).toMatchObject({ CALLS: 1, READS_FIELD: 1 });
    expect(result.byDstPrefix).toMatchObject({ ApexMethod: 1, CustomField: 1 });
    expect(result.sample).toHaveLength(2);
    await store.close();
  });

  it("respects sampleSize", async () => {
    const { store, orgId } = await seed();
    const result = auditDanglingEdges(store, orgId, { sampleSize: 1 });
    expect(result.danglingCount).toBe(2);
    expect(result.sample).toHaveLength(1);
    await store.close();
  });

  it("returns empty histograms when there are no dangling edges", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    const orgId = asOrgId("org_empty");
    store.upsertOrg({
      id: orgId,
      alias: "test",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    const result = auditDanglingEdges(store, orgId);
    expect(result.totalEdges).toBe(0);
    expect(result.danglingCount).toBe(0);
    expect(result.sample).toHaveLength(0);
    await store.close();
  });
});

describe("deleteDanglingEdges", () => {
  it("removes dangling edges and leaves good ones intact", async () => {
    const { store, orgId } = await seed();
    const before = auditDanglingEdges(store, orgId);
    expect(before.danglingCount).toBe(2);

    const { deleted } = deleteDanglingEdges(store, orgId);
    expect(deleted).toBe(2);

    const after = auditDanglingEdges(store, orgId);
    expect(after.danglingCount).toBe(0);
    expect(after.totalEdges).toBe(1); // good edge survives
    await store.close();
  });
});
