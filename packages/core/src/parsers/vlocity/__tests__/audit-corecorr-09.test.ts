import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { REL_TYPES, type RelType } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { resolveVlocityApex } from "../apex-resolver.js";
import { resolveVlocityNameMatches } from "../name-match-resolver.js";

/**
 * Audit corecorr-09: resolver-produced edges (resolvedBy) are exempt from
 * member reconcile and resolvers only insert, so a name-match edge survives
 * after the source stops naming the target.
 */
const orgId = asOrgId("org_test");
const node = (qn: string, label: string, attrs: Record<string, unknown> = {}) => {
  const ts = Date.now();
  return {
    orgId,
    qualifiedName: asQualifiedName(qn),
    label,
    attributes: attrs,
    sourceHash: asSha256(`${qn}:${JSON.stringify(attrs)}`),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
};

describe("audit corecorr-09: stale resolver edges are pruned on re-run", () => {
  it("drops the name-match edge once the candidate is removed from the source", async () => {
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
    resolveVlocityNameMatches(store, orgId, makeTestCtx());
    const before = store.listEdgesFrom(
      orgId,
      asQualifiedName("VlocityAction:Act"),
      REL_TYPES.REFERENCES,
    );
    expect(before.map((e) => String(e.dstQualifiedName))).toEqual(["IntegrationProcedure:IP_One"]);

    // Re-sync: the action no longer names IP_One and the resolver re-runs.
    store.mergeNodes([node("VlocityAction:Act", "VlocityAction", { nameMatchCandidates: [] })]);
    expect(
      (
        store.getNode(orgId, asQualifiedName("VlocityAction:Act"))?.attributes as {
          nameMatchCandidates?: unknown[];
        }
      ).nameMatchCandidates,
    ).toEqual([]);
    resolveVlocityNameMatches(store, orgId, makeTestCtx());
    const after = store.listEdgesFrom(
      orgId,
      asQualifiedName("VlocityAction:Act"),
      REL_TYPES.REFERENCES,
    );
    expect(after).toEqual([]);
  });

  it("drops vlocity-apex edges once the Remote: action is gone, keeping explicit edges", async () => {
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
      node("ApexClass:Plain", "ApexClass"),
      node("ApexMethod:Plain.run(1)", "ApexMethod"),
    ]);
    const ts = Date.now();
    const e = (src: string, rel: RelType, dst: string, attributes: Record<string, unknown>) => ({
      orgId,
      srcQualifiedName: asQualifiedName(src),
      dstQualifiedName: asQualifiedName(dst),
      relType: rel,
      attributes,
      firstSeenAt: ts,
      lastSeenAt: ts,
    });
    store.mergeEdges([
      e("IntegrationProcedure:A_B", REL_TYPES.IP_INVOKES_REMOTE, "Remote:Plain", {
        remoteClass: "Plain",
        remoteMethod: "run",
      }),
      // An explicit (parser-emitted) edge of the same rel must survive pruning.
      e("OmniScript:O_S_English", REL_TYPES.VLOCITY_INVOKES_APEX, "ApexClass:Plain", {}),
    ]);
    resolveVlocityApex(store, orgId, makeTestCtx());
    const ipQn = asQualifiedName("IntegrationProcedure:A_B");
    expect(store.listEdgesFrom(orgId, ipQn, REL_TYPES.VLOCITY_INVOKES_APEX)).toHaveLength(1);
    expect(store.listEdgesFrom(orgId, ipQn, REL_TYPES.VLOCITY_INVOKES_APEX_METHOD)).toHaveLength(1);

    // Re-sync: the IP's Remote Action is removed (member reconcile drops it).
    store.deleteEdge(orgId, ipQn, asQualifiedName("Remote:Plain"), REL_TYPES.IP_INVOKES_REMOTE);
    resolveVlocityApex(store, orgId, makeTestCtx());
    expect(store.listEdgesFrom(orgId, ipQn, REL_TYPES.VLOCITY_INVOKES_APEX)).toEqual([]);
    expect(store.listEdgesFrom(orgId, ipQn, REL_TYPES.VLOCITY_INVOKES_APEX_METHOD)).toEqual([]);
    expect(
      store.listEdgesFrom(
        orgId,
        asQualifiedName("OmniScript:O_S_English"),
        REL_TYPES.VLOCITY_INVOKES_APEX,
      ),
    ).toHaveLength(1);
  });
});
