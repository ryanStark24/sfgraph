import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SqliteGraphStore,
  SqliteSnapshotStore,
  type VectorStore,
} from "@ryanstark24/sfgraph-core";
import { type OrgId, asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
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

afterEach(async () => {
  setToolContextFactory(null);
  await graphStore?.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("find_similar", () => {
  it("returns reason=vector_index_unavailable when no VectorStore on context", async () => {
    await makeCtx(null);
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
    // similarity = 1 - distance/2
    expect(data.hits[0]?.similarity).toBeCloseTo(0.95, 2);
    expect(data.hits[2]?.similarity).toBeCloseTo(0.55, 2);
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
    await expect(
      callTool("find_similar", { org: "00DFINDSIM00000XYZ" }),
    ).rejects.toThrow(/Provide exactly one|Invalid input/);
  });
});
