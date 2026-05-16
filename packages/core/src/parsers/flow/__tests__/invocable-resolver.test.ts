import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveFlowApexMethods } from "../invocable-resolver.js";

async function seed() {
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
  return { store, orgId };
}

function node(orgId: ReturnType<typeof asOrgId>, qn: string, label: string, attrs: Record<string, unknown> = {}) {
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

describe("resolveFlowApexMethods", () => {
  it("emits FLOW_INVOKES_APEX_METHOD when the class has exactly one @InvocableMethod", async () => {
    const { store, orgId } = await seed();
    const ts = Date.now();
    store.mergeNodes([
      node(orgId, "FlowVersion:DoStuff/1", "FlowVersion"),
      node(orgId, "ApexClass:DoStuffHandler", "ApexClass"),
      node(orgId, "ApexMethod:DoStuffHandler.run(1)", "ApexMethod", { isInvocable: true }),
      node(orgId, "ApexMethod:DoStuffHandler.helper(0)", "ApexMethod", { isInvocable: false }),
    ]);
    store.mergeEdges([
      {
        orgId,
        srcQualifiedName: asQualifiedName("FlowVersion:DoStuff/1"),
        dstQualifiedName: asQualifiedName("ApexClass:DoStuffHandler"),
        relType: REL_TYPES.FLOW_INVOKES_APEX,
        attributes: { actionName: "DoStuffHandler" },
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);

    const result = resolveFlowApexMethods(store, orgId, makeTestCtx());
    expect(result).toMatchObject({ scanned: 1, resolved: 1, ambiguous: 0, missing: 0 });

    const edges = store.listEdgesFrom(
      orgId,
      asQualifiedName("FlowVersion:DoStuff/1"),
      REL_TYPES.FLOW_INVOKES_APEX_METHOD,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]?.dstQualifiedName).toBe("ApexMethod:DoStuffHandler.run(1)");
    expect(edges[0]?.attributes.resolvedBy).toBe("flow-invocable-resolver");

    // Class-level edge is left in place — additive resolution.
    const classEdges = store.listEdgesFrom(
      orgId,
      asQualifiedName("FlowVersion:DoStuff/1"),
      REL_TYPES.FLOW_INVOKES_APEX,
    );
    expect(classEdges).toHaveLength(1);

    await store.close();
  });

  it("reports missing when the target class has no invocable method", async () => {
    const { store, orgId } = await seed();
    const ts = Date.now();
    store.mergeNodes([
      node(orgId, "FlowVersion:Stale/1", "FlowVersion"),
      node(orgId, "ApexClass:NotInvocable", "ApexClass"),
      node(orgId, "ApexMethod:NotInvocable.run(0)", "ApexMethod", { isInvocable: false }),
    ]);
    store.mergeEdges([
      {
        orgId,
        srcQualifiedName: asQualifiedName("FlowVersion:Stale/1"),
        dstQualifiedName: asQualifiedName("ApexClass:NotInvocable"),
        relType: REL_TYPES.FLOW_INVOKES_APEX,
        attributes: {},
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);
    const result = resolveFlowApexMethods(store, orgId, makeTestCtx());
    expect(result).toMatchObject({ scanned: 1, resolved: 0, missing: 1 });

    const edges = store.listEdgesFrom(
      orgId,
      asQualifiedName("FlowVersion:Stale/1"),
      REL_TYPES.FLOW_INVOKES_APEX_METHOD,
    );
    expect(edges).toHaveLength(0);
    await store.close();
  });
});
