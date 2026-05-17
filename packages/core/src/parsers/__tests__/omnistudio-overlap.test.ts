import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { resolveCrossFlavor } from "../cross-flavor-resolver.js";
import { detectOmnistudioOverlap } from "../omnistudio/overlap-detector.js";
import { makeTestCtx } from "./_harness.js";

const ORG = asOrgId("org_test");

function setupStore() {
  const store = new SqliteGraphStore({ dbPath: ":memory:" });
  return store.init().then(() => {
    store.upsertOrg({
      id: ORG,
      alias: "test",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    return store;
  });
}

function node(label: string, qname: string): NodeFact {
  const ts = Date.now();
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(qname),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}

function edge(src: string, rel: string, dst: string): EdgeFact {
  const ts = Date.now();
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

describe("W2-01: OmniStudio overlap detector", () => {
  it("annotates a matched CANONICAL_OF pair when both sides have identical signatures", async () => {
    const store = await setupStore();

    // Pair: DataRaptor:GetAccount ↔ OmniDataTransform:GetAccount, both with
    // identical outbound calls (one read-field, one calls-method) so the
    // signature multiset matches exactly.
    store.mergeNodes([
      node("DataRaptor", "DataRaptor:GetAccount"),
      node("OmniDataTransform", "OmniDataTransform:GetAccount"),
      node("CustomField", "CustomField:Account.Name"),
      node("ApexMethod", "ApexMethod:Util.format(1)"),
    ]);
    store.mergeEdges([
      edge("DataRaptor:GetAccount", REL_TYPES.READS_FIELD, "CustomField:Account.Name"),
      edge("DataRaptor:GetAccount", REL_TYPES.CALLS, "ApexMethod:Util.format(1)"),
      edge("OmniDataTransform:GetAccount", REL_TYPES.READS_FIELD, "CustomField:Account.Name"),
      edge("OmniDataTransform:GetAccount", REL_TYPES.CALLS, "ApexMethod:Util.format(1)"),
    ]);

    const ctx = makeTestCtx();
    resolveCrossFlavor(store, { orgId: ORG, ctx, namespace: null });

    const result = detectOmnistudioOverlap(store, { orgId: ORG, ctx });
    expect(result.matched).toBe(1);
    expect(result.diverged).toBe(0);
    expect(result.empty).toBe(0);
    // Two CANONICAL_OF edges (one per direction) get annotated.
    expect(result.annotated).toBe(2);

    const canon = store
      .listEdgesFrom(ORG, asQualifiedName("DataRaptor:GetAccount"), REL_TYPES.CANONICAL_OF)
      .find((e) => String(e.dstQualifiedName) === "OmniDataTransform:GetAccount");
    expect(canon?.attributes.signaturesMatch).toBe(true);
    expect(canon?.attributes.divergencePoints).toEqual([]);

    await store.close();
  });

  it("flags a diverged pair when the two sides have different outbound signatures", async () => {
    const store = await setupStore();

    // OmniDataTransform has one extra READS_FIELD edge — the signature
    // multisets differ on that key.
    store.mergeNodes([
      node("DataRaptor", "DataRaptor:GetAccount"),
      node("OmniDataTransform", "OmniDataTransform:GetAccount"),
      node("CustomField", "CustomField:Account.Name"),
      node("CustomField", "CustomField:Account.Phone"),
    ]);
    store.mergeEdges([
      edge("DataRaptor:GetAccount", REL_TYPES.READS_FIELD, "CustomField:Account.Name"),
      edge("OmniDataTransform:GetAccount", REL_TYPES.READS_FIELD, "CustomField:Account.Name"),
      edge("OmniDataTransform:GetAccount", REL_TYPES.READS_FIELD, "CustomField:Account.Phone"),
    ]);

    const ctx = makeTestCtx();
    resolveCrossFlavor(store, { orgId: ORG, ctx, namespace: null });

    const result = detectOmnistudioOverlap(store, { orgId: ORG, ctx });
    expect(result.matched).toBe(0);
    expect(result.diverged).toBe(1);

    const canon = store
      .listEdgesFrom(ORG, asQualifiedName("DataRaptor:GetAccount"), REL_TYPES.CANONICAL_OF)
      .find((e) => String(e.dstQualifiedName) === "OmniDataTransform:GetAccount");
    expect(canon?.attributes.signaturesMatch).toBe(false);
    const points = canon?.attributes.divergencePoints as string[];
    expect(points.length).toBe(1);
    expect(points[0]).toMatch(/READS_FIELD/);
    // Difference: DataRaptor=1, OmniDataTransform=2 (alphabetical order
    // puts DataRaptor:Foo before OmniDataTransform:Foo in pairKey but the
    // diff is symmetric, both 1-vs-2 or 2-vs-1 are valid expressions of
    // the same divergence — accept either ordering).
    expect(points[0]).toMatch(/(1 vs 2|2 vs 1)/);

    await store.close();
  });

  it("ignores CANONICAL_OF self-edges when computing signatures (no spurious matching)", async () => {
    const store = await setupStore();

    // A pair whose ONLY outbound edges are the CANONICAL_OF links the
    // resolver emits. Without the filter, both sides' signature multisets
    // would each contain one CANONICAL_OF entry — vacuously "matched". The
    // detector must exclude these to surface the pair as `empty` instead.
    store.mergeNodes([
      node("DataRaptor", "DataRaptor:Bare"),
      node("OmniDataTransform", "OmniDataTransform:Bare"),
    ]);

    const ctx = makeTestCtx();
    resolveCrossFlavor(store, { orgId: ORG, ctx, namespace: null });

    const result = detectOmnistudioOverlap(store, { orgId: ORG, ctx });
    expect(result.empty).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.diverged).toBe(0);

    await store.close();
  });

  it("dryRun mode computes results without writing annotations", async () => {
    const store = await setupStore();

    store.mergeNodes([
      node("DataRaptor", "DataRaptor:X"),
      node("OmniDataTransform", "OmniDataTransform:X"),
      node("CustomField", "CustomField:Account.Name"),
    ]);
    store.mergeEdges([
      edge("DataRaptor:X", REL_TYPES.READS_FIELD, "CustomField:Account.Name"),
      edge("OmniDataTransform:X", REL_TYPES.READS_FIELD, "CustomField:Account.Name"),
    ]);

    const ctx = makeTestCtx();
    resolveCrossFlavor(store, { orgId: ORG, ctx, namespace: null });

    const result = detectOmnistudioOverlap(store, { orgId: ORG, ctx, dryRun: true });
    expect(result.matched).toBe(1);

    // Annotation NOT present in store
    const canon = store
      .listEdgesFrom(ORG, asQualifiedName("DataRaptor:X"), REL_TYPES.CANONICAL_OF)
      .find((e) => String(e.dstQualifiedName) === "OmniDataTransform:X");
    expect(canon?.attributes.signaturesMatch).toBeUndefined();

    await store.close();
  });

  it("returns zero counts when no CANONICAL_OF edges exist (no canonical pairs in the org)", async () => {
    const store = await setupStore();

    store.mergeNodes([node("DataRaptor", "DataRaptor:Lonely")]);

    const ctx = makeTestCtx();
    const result = detectOmnistudioOverlap(store, { orgId: ORG, ctx });
    expect(result).toEqual({ matched: 0, diverged: 0, empty: 0, annotated: 0 });

    await store.close();
  });
});
