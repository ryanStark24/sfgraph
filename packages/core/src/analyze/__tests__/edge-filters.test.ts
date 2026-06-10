import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDependents } from "../dependents.js";
import { isReflectionEdge, keepEdge } from "../edge-filters.js";

const ORG = asOrgId("orgFilter");
let store: SqliteGraphStore;

function edge(src: string, dst: string, rel: string, attrs: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as never,
    attributes: attrs,
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({ id: ORG, alias: "a", instanceUrl: "x", apiVersion: "59.0", createdAt: 1 });
  store.mergeNodes(
    ["ApexClass:Target", "ApexClass:TargetTest", "Profile:Admin", "Profile:Sales"].map((q) => ({
      orgId: ORG,
      label: q.split(":")[0] as string,
      qualifiedName: asQualifiedName(q),
      attributes: {},
      sourceHash: asSha256("h"),
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastModifiedAt: 1,
    })),
  );
  store.mergeEdges([
    edge("ApexClass:TargetTest", "ApexClass:Target", "IS_TEST_FOR"),
    edge("Profile:Admin", "ApexClass:Target", "GRANTS_APEX_ACCESS"),
    edge("Profile:Sales", "ApexClass:Target", "GRANTS_APEX_ACCESS"),
  ]);
});

describe("edge-filters", () => {
  it("keepEdge drops security grants and reflection edges by default", () => {
    const grant = edge("Profile:Admin", "ApexClass:Target", "GRANTS_APEX_ACCESS");
    const refl = edge("DataRaptor:Foo", "CustomApplication:DataRaptor", "REFERENCES", {
      source: "reflection",
    });
    const real = edge("ApexClass:TargetTest", "ApexClass:Target", "IS_TEST_FOR");
    expect(keepEdge(grant, {})).toBe(false);
    expect(keepEdge(refl, {})).toBe(false);
    expect(keepEdge(real, {})).toBe(true);
    expect(isReflectionEdge(refl)).toBe(true);
    expect(keepEdge(grant, { excludeSecurity: false })).toBe(true);
    expect(keepEdge(refl, { excludeReflection: false })).toBe(true);
  });

  it("findDependents hides grant edges and reports filtered count", () => {
    const r = findDependents(store, ORG, asQualifiedName("ApexClass:Target"), 3);
    expect(r.nodes.map((node) => String(node.qualifiedName))).toEqual(["ApexClass:TargetTest"]);
    expect(r.filtered).toBe(2);
  });

  it("findDependents includes grants when excludeSecurity:false", () => {
    const r = findDependents(store, ORG, asQualifiedName("ApexClass:Target"), 3, {
      excludeSecurity: false,
    });
    expect(r.nodes.length).toBe(3);
    expect(r.filtered).toBe(0);
  });
});
