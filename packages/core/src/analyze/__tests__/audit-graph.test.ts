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

describe("platform-builtin reference classification", () => {
  function edge(orgId: ReturnType<typeof asOrgId>, src: string, rel: string, dst: string) {
    const ts = Date.now();
    return {
      orgId,
      srcQualifiedName: asQualifiedName(src),
      dstQualifiedName: asQualifiedName(dst),
      relType: rel as (typeof REL_TYPES)[keyof typeof REL_TYPES],
      attributes: {},
      firstSeenAt: ts,
      lastSeenAt: ts,
    };
  }

  async function seedPlatform() {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    const orgId = asOrgId("org_platform");
    store.upsertOrg({
      id: orgId,
      alias: "test",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    const ts = Date.now();
    store.mergeNodes([
      {
        orgId,
        qualifiedName: asQualifiedName("Profile:Admin"),
        label: "Profile",
        attributes: {},
        sourceHash: asSha256("p"),
        firstSeenAt: ts,
        lastSeenAt: ts,
        lastModifiedAt: ts,
      },
    ]);
    store.mergeEdges([
      // Platform built-ins: standard tab + standard-schema field.
      edge(orgId, "Profile:Admin", REL_TYPES.GRANTS_TAB_ACCESS, "CustomTab:standard-Account"),
      edge(orgId, "Profile:Admin", REL_TYPES.GRANTS_FIELD_ACCESS, "CustomField:Incident.Status"),
      // Unexpected: custom-suffixed targets that SHOULD have nodes.
      edge(orgId, "Profile:Admin", REL_TYPES.GRANTS_TAB_ACCESS, "CustomTab:Booking__c"),
      edge(orgId, "Profile:Admin", REL_TYPES.GRANTS_FIELD_ACCESS, "CustomField:Account.Active__c"),
    ]);
    return { store, orgId };
  }

  it("splits danglingCount into platformRefCount and unexpectedCount", async () => {
    const { store, orgId } = await seedPlatform();
    const result = auditDanglingEdges(store, orgId);
    expect(result.danglingCount).toBe(4);
    expect(result.platformRefCount).toBe(2);
    expect(result.unexpectedCount).toBe(2);
    // Unexpected edges are sampled first.
    expect(
      result.sample
        .slice(0, 2)
        .map((s) => s.dst)
        .sort(),
    ).toEqual(["CustomField:Account.Active__c", "CustomTab:Booking__c"]);
    await store.close();
  });

  it("deleteDanglingEdges keeps platform refs by default and reports them", async () => {
    const { store, orgId } = await seedPlatform();
    const result = deleteDanglingEdges(store, orgId);
    expect(result.deleted).toBe(2);
    expect(result.keptPlatformRefs).toBe(2);
    const after = auditDanglingEdges(store, orgId);
    expect(after.danglingCount).toBe(2);
    expect(after.platformRefCount).toBe(2);
    await store.close();
  });

  it("deleteDanglingEdges includePlatformRefs:true deletes everything", async () => {
    const { store, orgId } = await seedPlatform();
    const result = deleteDanglingEdges(store, orgId, { includePlatformRefs: true });
    expect(result.deleted).toBe(4);
    expect(result.keptPlatformRefs).toBe(0);
    expect(auditDanglingEdges(store, orgId).danglingCount).toBe(0);
    await store.close();
  });
});
