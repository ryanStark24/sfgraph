import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveApexMethodArity } from "../arity-resolver.js";

async function seedStore(_orgIdStr: string) {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  // Must align with makeTestCtx().orgId so resolver-emitted edges land in
  // the same org row. The arg is kept for human-readable test naming only.
  const orgId = asOrgId("org_test");
  store.upsertOrg({
    id: orgId,
    alias: "test",
    instanceUrl: "https://example.test",
    apiVersion: "59.0",
    createdAt: Date.now(),
  });
  return { store, orgId };
}

function node(orgId: ReturnType<typeof asOrgId>, qname: string, label: string) {
  const ts = Date.now();
  return {
    orgId,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: { name: qname },
    sourceHash: asSha256(qname),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}

function edge(orgId: ReturnType<typeof asOrgId>, src: string, dst: string) {
  const ts = Date.now();
  return {
    orgId,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: REL_TYPES.CALLS,
    attributes: { unresolvedArity: true },
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

describe("resolveApexMethodArity", () => {
  it("rewrites a stranded CALLS edge to the single matching ApexMethod overload", async () => {
    const { store, orgId } = await seedStore("org_arity_single");
    const caller = "ApexMethod:Caller.run(0)";
    const target = "ApexMethod:Foo.bar(2)";
    store.mergeNodes([
      node(orgId, "ApexClass:Caller", "ApexClass"),
      node(orgId, caller, "ApexMethod"),
      node(orgId, "ApexClass:Foo", "ApexClass"),
      node(orgId, target, "ApexMethod"),
    ]);
    store.mergeEdges([edge(orgId, caller, "ApexMethod:Foo.bar(?)")]);

    const result = resolveApexMethodArity(store, { orgId, ctx: makeTestCtx() });

    expect(result).toMatchObject({
      scanned: 1,
      resolved: 1,
      ambiguous: 0,
      unresolved: 0,
      edgesEmitted: 1,
    });

    const edges = store.listEdgesFrom(orgId, asQualifiedName(caller), REL_TYPES.CALLS);
    expect(edges.map((e) => e.dstQualifiedName)).toEqual([target]);
    expect(edges[0]?.attributes.resolvedBy).toBe("arity-resolver");
    expect(edges[0]?.attributes.ambiguous).toBe(false);

    await store.close();
  });

  it("emits one edge per overload and marks them ambiguous when multiple match", async () => {
    const { store, orgId } = await seedStore("org_arity_overload");
    const caller = "ApexMethod:Caller.run(0)";
    store.mergeNodes([
      node(orgId, caller, "ApexMethod"),
      node(orgId, "ApexMethod:Foo.bar(1)", "ApexMethod"),
      node(orgId, "ApexMethod:Foo.bar(2)", "ApexMethod"),
      node(orgId, "ApexMethod:Foo.bar(3)", "ApexMethod"),
    ]);
    store.mergeEdges([edge(orgId, caller, "ApexMethod:Foo.bar(?)")]);

    const result = resolveApexMethodArity(store, { orgId, ctx: makeTestCtx() });

    expect(result.resolved).toBe(1);
    expect(result.ambiguous).toBe(1);
    expect(result.edgesEmitted).toBe(3);

    const edges = store.listEdgesFrom(orgId, asQualifiedName(caller), REL_TYPES.CALLS);
    expect(edges.map((e) => String(e.dstQualifiedName)).sort()).toEqual([
      "ApexMethod:Foo.bar(1)",
      "ApexMethod:Foo.bar(2)",
      "ApexMethod:Foo.bar(3)",
    ]);
    for (const e of edges) {
      expect(e.attributes.ambiguous).toBe(true);
      expect(e.attributes.overloadCount).toBe(3);
    }
    // Original stranded edge is gone.
    expect(edges.find((e) => String(e.dstQualifiedName).endsWith("(?)"))).toBeUndefined();

    await store.close();
  });

  it("leaves the edge untouched when no candidate method exists (dangling)", async () => {
    const { store, orgId } = await seedStore("org_arity_missing");
    const caller = "ApexMethod:Caller.run(0)";
    store.mergeNodes([node(orgId, caller, "ApexMethod")]);
    store.mergeEdges([edge(orgId, caller, "ApexMethod:Ghost.notReal(?)")]);

    const result = resolveApexMethodArity(store, { orgId, ctx: makeTestCtx() });

    expect(result).toMatchObject({ scanned: 1, resolved: 0, unresolved: 1, edgesEmitted: 0 });

    const edges = store.listEdgesFrom(orgId, asQualifiedName(caller), REL_TYPES.CALLS);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.dstQualifiedName).toBe("ApexMethod:Ghost.notReal(?)");

    await store.close();
  });

  it("dryRun reports counts without mutating the graph", async () => {
    const { store, orgId } = await seedStore("org_arity_dryrun");
    const caller = "ApexMethod:Caller.run(0)";
    store.mergeNodes([
      node(orgId, caller, "ApexMethod"),
      node(orgId, "ApexMethod:Foo.bar(2)", "ApexMethod"),
    ]);
    store.mergeEdges([edge(orgId, caller, "ApexMethod:Foo.bar(?)")]);

    const result = resolveApexMethodArity(store, {
      orgId,
      ctx: makeTestCtx(),
      dryRun: true,
    });

    expect(result.resolved).toBe(1);
    expect(result.edgesEmitted).toBe(1);

    // Graph still has only the stranded edge.
    const edges = store.listEdgesFrom(orgId, asQualifiedName(caller), REL_TYPES.CALLS);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.dstQualifiedName).toBe("ApexMethod:Foo.bar(?)");

    await store.close();
  });
});
