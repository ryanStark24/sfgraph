import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveVlocityNameMatches } from "../name-match-resolver.js";

const orgId = asOrgId("00Dxx0000000ABCEAA");
const node = (qn: string, label: string, attrs: Record<string, unknown> = {}) => {
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
};

async function run(candidates: string[], extra: ReturnType<typeof node>[] = []) {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({
    id: orgId,
    alias: "t",
    instanceUrl: "https://example.test",
    apiVersion: "59.0",
    createdAt: Date.now(),
  });
  store.mergeNodes([
    node("VlocityAction:Act", "VlocityAction", { nameMatchCandidates: candidates }),
    node("IntegrationProcedure:IP_One", "IntegrationProcedure"),
    node("DataRaptor:DR_One", "DataRaptor"),
    node("DataRaptor:Dup", "DataRaptor"),
    node("IntegrationProcedure:Dup", "IntegrationProcedure"),
    ...extra,
  ]);
  const res = resolveVlocityNameMatches(store, orgId, makeTestCtx());
  const edges = store.listEdgesFrom(
    orgId,
    asQualifiedName("VlocityAction:Act"),
    REL_TYPES.REFERENCES,
  );
  return { res, edges };
}

describe("resolveVlocityNameMatches", () => {
  it("emits an inferred REFERENCES edge for an exact unique match", async () => {
    const { edges } = await run(["IP_One", "DR_One"]);
    expect(edges.map((e) => String(e.dstQualifiedName)).sort()).toEqual([
      "DataRaptor:DR_One",
      "IntegrationProcedure:IP_One",
    ]);
    expect(edges[0]?.attributes).toMatchObject({ inferred: "name-match" });
  });
  it("skips ambiguous, case-different and unknown names", async () => {
    const { edges, res } = await run(["Dup", "ip_one", "Nope"]);
    expect(edges).toEqual([]);
    expect(res.edgesEmitted).toBe(0);
  });
  it("never overwrites an explicit edge with the same key", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    store.mergeNodes([
      node("VlocityAction:Act", "VlocityAction", { nameMatchCandidates: ["DR_One"] }),
      node("DataRaptor:DR_One", "DataRaptor"),
    ]);
    const ts = Date.now();
    store.mergeEdges([
      {
        orgId,
        srcQualifiedName: asQualifiedName("VlocityAction:Act"),
        dstQualifiedName: asQualifiedName("DataRaptor:DR_One"),
        relType: REL_TYPES.REFERENCES,
        attributes: { via: "TokenDRBundleName" },
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);
    resolveVlocityNameMatches(store, orgId, makeTestCtx());
    const e = store.listEdgesFrom(
      orgId,
      asQualifiedName("VlocityAction:Act"),
      REL_TYPES.REFERENCES,
    );
    expect(e).toHaveLength(1);
    expect(e[0]?.attributes).toEqual({ via: "TokenDRBundleName" });
  });
  it("review M-8: never overwrites an explicit edge whose dst differs only in case", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    store.mergeNodes([
      node("VlocityAction:Act", "VlocityAction", { nameMatchCandidates: ["DR_One"] }),
      node("DataRaptor:DR_One", "DataRaptor"),
    ]);
    const ts = Date.now();
    store.mergeEdges([
      {
        orgId,
        srcQualifiedName: asQualifiedName("VlocityAction:Act"),
        dstQualifiedName: asQualifiedName("DataRaptor:dr_one"),
        relType: REL_TYPES.REFERENCES,
        attributes: { via: "TokenDRBundleName" },
        firstSeenAt: ts,
        lastSeenAt: ts,
      },
    ]);
    const res = resolveVlocityNameMatches(store, orgId, makeTestCtx());
    const e = store.listEdgesFrom(
      orgId,
      asQualifiedName("VlocityAction:Act"),
      REL_TYPES.REFERENCES,
    );
    expect(e).toHaveLength(1);
    expect(e[0]?.attributes).toEqual({ via: "TokenDRBundleName" });
    expect(res.matched).toBe(0);
  });
  it("repeat runs do not duplicate edges", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    store.mergeNodes([
      node("VlocityAction:Act", "VlocityAction", { nameMatchCandidates: ["IP_One"] }),
      node("IntegrationProcedure:IP_One", "IntegrationProcedure"),
    ]);
    for (let i = 0; i < 3; i++) resolveVlocityNameMatches(store, orgId, makeTestCtx());
    expect(
      store.listEdgesFrom(orgId, asQualifiedName("VlocityAction:Act"), REL_TYPES.REFERENCES),
    ).toHaveLength(1);
  });
  it("is idempotent", async () => {
    const { edges } = await run(["IP_One", "IP_One"]);
    expect(edges).toHaveLength(1);
  });
});
