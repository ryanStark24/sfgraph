import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore, type VectorStore } from "@ryanstark24/sfgraph-core";
import { type OrgId, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ToolContext, setToolContextFactory } from "../../context.js";
import { callTool } from "./_runner.js";

/**
 * find_similar tests. The tool requires a VectorStore; we inject a
 * stub implementation that exposes only the two methods find_similar
 * touches — `getNodeVector` and `searchNodes`. Everything else throws.
 *
 * Coverage targets:
 *   - qname mode: focal lookup → searchNodes → self-filter → ranked table
 *   - text mode: pulled in but skipped here because it requires the
 *     real embedder runtime; covered in embed.test.ts contract tests
 *   - graceful-degradation reasons: vector_index_unavailable,
 *     no_focal_vector, no_neighbours
 */

let workDir: string;
let graphStore: SqliteGraphStore;

function makeStubVectorStore(opts: {
  vectors?: Map<string, Float32Array>;
  results?: Array<{ qname: string; label: string; distance: number }>;
}): VectorStore {
  return {
    init: async () => {},
    close: async () => {},
    upsertNodeVector: () => ({ inserted: true, deduped: false }),
    upsertBundleVector: () => ({ inserted: true, deduped: false }),
    countNodeVectors: () => opts.vectors?.size ?? 0,
    searchBundles: () => [],
    getNodeVector: (_orgId, qname) => opts.vectors?.get(qname) ?? null,
    deleteNodeVector: (_orgId, qname) => opts.vectors?.delete(qname) ?? false,
    getContentHash: () => null,
    searchNodes: () =>
      (opts.results ?? []).map((r) => ({
        qname: asQualifiedName(r.qname),
        label: r.label,
        distance: r.distance,
      })),
  };
}

async function makeCtx(vectorStore: VectorStore | null): Promise<ToolContext> {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-find-sim-"));
  const dbPath = path.join(workDir, "g.sqlite");
  graphStore = new SqliteGraphStore({
    dbPath,
    backupDir: path.join(workDir, "bkp"),
  });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  const orgId: OrgId = asOrgId("00DFINDSIM00000XYZ");
  const ctx: ToolContext = { graphStore, snapshotStore, orgId, vectorStore };
  setToolContextFactory(async () => ctx);
  return ctx;
}

/** The focal must exist in the graph (audit tools-13: a missing focal is
 *  reported as not found); these cases test the vector-side reasons. */
function addGraphNode(qname: string, label = "ApexClass"): void {
  graphStore.mergeNodes([
    {
      orgId: asOrgId("00DFINDSIM00000XYZ"),
      qualifiedName: asQualifiedName(qname),
      label,
      attributes: {},
      sourceHash: asSha256(`h-${qname}`),
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastModifiedAt: 1,
    },
  ]);
}

afterEach(async () => {
  setToolContextFactory(null);
  await graphStore?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("find_similar", () => {
  it("returns reason=vector_index_unavailable when no VectorStore on context", async () => {
    await makeCtx(null);
    addGraphNode("ApexClass:Foo");
    const res = await callTool("find_similar", {
      org: "00DFINDSIM00000XYZ",
      qname: "ApexClass:Foo",
    });
    expect(res.summary).toMatch(/unavailable/i);
    expect((res.data as { reason: string }).reason).toBe("vector_index_unavailable");
    expect((res.data as { hits: unknown[] }).hits).toEqual([]);
  });

  it("returns reason=no_focal_vector when qname has no stored embedding", async () => {
    await makeCtx(makeStubVectorStore({ vectors: new Map() }));
    addGraphNode("ApexClass:Missing");
    const res = await callTool("find_similar", {
      org: "00DFINDSIM00000XYZ",
      qname: "ApexClass:Missing",
    });
    expect(res.summary).toMatch(/no embedding/i);
    expect((res.data as { reason: string }).reason).toBe("no_focal_vector");
  });

  it("returns reason=no_neighbours when search returns 0 hits", async () => {
    const focal = new Float32Array(384);
    focal[0] = 1;
    await makeCtx(
      makeStubVectorStore({
        vectors: new Map([[asQualifiedName("ApexClass:Lonely"), focal]]),
        results: [],
      }),
    );
    const res = await callTool("find_similar", {
      org: "00DFINDSIM00000XYZ",
      qname: "ApexClass:Lonely",
    });
    expect(res.summary).toMatch(/no neighbours/i);
    expect((res.data as { reason: string }).reason).toBe("no_neighbours");
  });

  it("returns ranked hits in qname mode and strips the focal itself", async () => {
    const focal = new Float32Array(384);
    focal[0] = 1;
    await makeCtx(
      makeStubVectorStore({
        vectors: new Map([[asQualifiedName("ApexClass:Focal"), focal]]),
        // searchNodes returns the focal + 3 neighbours; the tool should
        // strip the focal (distance 0) and surface the rest.
        results: [
          { qname: "ApexClass:Focal", label: "ApexClass", distance: 0 },
          { qname: "ApexClass:NearA", label: "ApexClass", distance: 0.1 },
          { qname: "ApexClass:NearB", label: "ApexClass", distance: 0.25 },
          { qname: "ApexClass:FarC", label: "ApexClass", distance: 0.9 },
        ],
      }),
    );
    const res = await callTool("find_similar", {
      org: "00DFINDSIM00000XYZ",
      qname: "ApexClass:Focal",
      k: 3,
    });
    const data = res.data as {
      hits: Array<{ qname: string; similarity: number; distance: number }>;
    };
    expect(data.hits).toHaveLength(3);
    expect(data.hits.map((h) => h.qname)).toEqual([
      "ApexClass:NearA",
      "ApexClass:NearB",
      "ApexClass:FarC",
    ]);
    // L2 distance → cosine similarity for normalized vectors: 1 - d²/2.
    // (Tables use default L2; embedder normalizes, so this is the true cosine.)
    expect(data.hits[0]?.similarity).toBeCloseTo(1 - (0.1 * 0.1) / 2, 4); // d=0.1 → 0.995
    expect(data.hits[2]?.similarity).toBeCloseTo(1 - (0.9 * 0.9) / 2, 4); // d=0.9 → 0.595
    expect(res.markdown).toContain("Top 3 nearest neighbours");
  });

  it("rejects when both qname AND text are provided", async () => {
    await makeCtx(makeStubVectorStore({ vectors: new Map() }));
    await expect(
      callTool("find_similar", {
        org: "00DFINDSIM00000XYZ",
        qname: "ApexClass:Foo",
        text: "find code",
      }),
    ).rejects.toThrow(/Provide exactly one|Invalid input/);
  });

  it("rejects when neither qname nor text is provided", async () => {
    await makeCtx(makeStubVectorStore({ vectors: new Map() }));
    await expect(callTool("find_similar", { org: "00DFINDSIM00000XYZ" })).rejects.toThrow(
      /Provide exactly one|Invalid input/,
    );
  });

  it("drops matches below the similarity floor and reports how many were hidden", async () => {
    const focal = new Float32Array(384);
    focal[0] = 1;
    await makeCtx(
      makeStubVectorStore({
        vectors: new Map([[asQualifiedName("ApexClass:Focal"), focal]]),
        results: [
          { qname: "ApexClass:Focal", label: "ApexClass", distance: 0 },
          { qname: "ApexClass:Near", label: "ApexClass", distance: 0.2 }, // cos ≈ 0.98
          { qname: "ApexClass:Far", label: "ApexClass", distance: 1.5 }, // cos clamps to 0 < 0.4
        ],
      }),
    );
    const res = await callTool("find_similar", {
      org: "00DFINDSIM00000XYZ",
      qname: "ApexClass:Focal",
    });
    const data = res.data as { hits: Array<{ qname: string }>; cutByFloor: number };
    expect(data.hits.map((h) => h.qname)).toEqual(["ApexClass:Near"]);
    expect(data.cutByFloor).toBe(1);
    expect(res.markdown).toMatch(/hidden below the .* similarity floor/);
  });

  it("min_similarity:0 disables the floor and returns the far match too", async () => {
    const focal = new Float32Array(384);
    focal[0] = 1;
    await makeCtx(
      makeStubVectorStore({
        vectors: new Map([[asQualifiedName("ApexClass:Focal"), focal]]),
        results: [
          { qname: "ApexClass:Focal", label: "ApexClass", distance: 0 },
          { qname: "ApexClass:Far", label: "ApexClass", distance: 1.5 },
        ],
      }),
    );
    const res = await callTool("find_similar", {
      org: "00DFINDSIM00000XYZ",
      qname: "ApexClass:Focal",
      min_similarity: 0,
    });
    expect((res.data as { hits: Array<{ qname: string }> }).hits.map((h) => h.qname)).toEqual([
      "ApexClass:Far",
    ]);
  });

  it("fuses a keyword-only hit (in FTS, not in the vector results) via RRF", async () => {
    const focal = new Float32Array(384);
    focal[0] = 1;
    const ctx = await makeCtx(
      makeStubVectorStore({
        vectors: new Map([[asQualifiedName("ApexClass:OrderHandler"), focal]]),
        results: [
          { qname: "ApexClass:OrderHandler", label: "ApexClass", distance: 0 },
          { qname: "ApexClass:NearVec", label: "ApexClass", distance: 0.2 },
        ],
      }),
    );
    // A node the vector leg never returns, but whose FTS body matches the focal
    // name's words ("order"). The keyword leg should surface it.
    ctx.graphStore.upsertNodeFts(
      ctx.orgId,
      asQualifiedName("ApexClass:OrderKeywordOnly"),
      "ApexClass",
      "ApexClass: ApexClass:OrderKeywordOnly\norder keyword only",
    );
    const res = await callTool("find_similar", {
      org: "00DFINDSIM00000XYZ",
      qname: "ApexClass:OrderHandler",
    });
    const data = res.data as { hits: Array<{ qname: string; via: string }> };
    const byQ = new Map(data.hits.map((h) => [h.qname, h.via]));
    expect(byQ.get("ApexClass:NearVec")).toBe("vector");
    expect(byQ.get("ApexClass:OrderKeywordOnly")).toBe("keyword");
  });

  it("returns reason=below_similarity_floor when every match is below the floor", async () => {
    const focal = new Float32Array(384);
    focal[0] = 1;
    await makeCtx(
      makeStubVectorStore({
        vectors: new Map([[asQualifiedName("ApexClass:Focal"), focal]]),
        results: [
          { qname: "ApexClass:Focal", label: "ApexClass", distance: 0 },
          { qname: "ApexClass:Far", label: "ApexClass", distance: 1.5 },
        ],
      }),
    );
    const res = await callTool("find_similar", {
      org: "00DFINDSIM00000XYZ",
      qname: "ApexClass:Focal",
    });
    expect((res.data as { reason: string }).reason).toBe("below_similarity_floor");
  });
});

describe("find_similar while embeddings are pending (task 11a)", () => {
  const ORG = asOrgId("00DFINDSIM00000XYZ");
  function pendingOrg(): void {
    graphStore.upsertOrg({
      id: ORG,
      alias: "a",
      instanceUrl: "https://x",
      apiVersion: "60.0",
      createdAt: 1,
    });
    graphStore.upsertNodeFts(
      ORG,
      asQualifiedName("ApexClass:OrderCancel"),
      "ApexClass",
      "order cancel",
    );
    graphStore.upsertNodeFts(
      ORG,
      asQualifiedName("ApexClass:OrderCreate"),
      "ApexClass",
      "order create",
    );
    graphStore.upsertNodeFts(ORG, asQualifiedName("ApexClass:Billing"), "ApexClass", "billing run");
    graphStore.setEmbeddingsPending(ORG, true);
  }

  it("skips the vector leg, answers from text search, and says the index is warming", async () => {
    let searched = 0;
    const vs = makeStubVectorStore({
      vectors: new Map([["ApexClass:OrderCancel", new Float32Array(384).fill(0.05)]]),
      results: [{ qname: "ApexClass:Billing", label: "ApexClass", distance: 0.1 }],
    });
    const wrapped: VectorStore = {
      ...vs,
      searchNodes: (...a) => {
        searched += 1;
        return vs.searchNodes(...a);
      },
    };
    await makeCtx(wrapped);
    addGraphNode("ApexClass:OrderCancel");
    pendingOrg();
    const res = await callTool("find_similar", { org: String(ORG), text: "order" });
    expect(searched).toBe(0);
    expect(res.markdown).toContain("vector index warming: 1/3 embedded; using text search");
    const data = res.data as {
      hits: Array<{ qname: string; via: string }>;
      vectorIndexWarming?: { embedded: number; total: number };
    };
    expect(data.vectorIndexWarming).toEqual({ embedded: 1, total: 3 });
    expect(data.hits.length).toBeGreaterThan(0);
    expect(data.hits.every((h) => h.via === "keyword")).toBe(true);
    expect(data.hits.map((h) => h.qname)).not.toContain("ApexClass:Billing");
  });

  it("says the index is warming when the text search also finds nothing", async () => {
    await makeCtx(makeStubVectorStore({ vectors: new Map() }));
    pendingOrg();
    const res = await callTool("find_similar", { org: String(ORG), text: "zzzunmatched" });
    expect(res.markdown).toContain("vector index warming: 0/3 embedded; using text search");
    expect((res.data as { reason: string }).reason).toBe("vector_index_warming");
  });

  it("uses the vector leg once embeddings are done", async () => {
    let searched = 0;
    const vs = makeStubVectorStore({
      vectors: new Map([["ApexClass:OrderCancel", new Float32Array(384).fill(0.05)]]),
      results: [{ qname: "ApexClass:Billing", label: "ApexClass", distance: 0.1 }],
    });
    await makeCtx({
      ...vs,
      searchNodes: (...a) => {
        searched += 1;
        return vs.searchNodes(...a);
      },
    });
    addGraphNode("ApexClass:OrderCancel");
    pendingOrg();
    graphStore.setEmbeddingsPending(ORG, false);
    const res = await callTool("find_similar", {
      org: String(ORG),
      qname: "ApexClass:OrderCancel",
    });
    expect(searched).toBe(1);
    expect(res.markdown).not.toContain("warming");
  });
});
