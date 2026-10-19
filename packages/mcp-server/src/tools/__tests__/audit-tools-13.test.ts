import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type NodeFact,
  SqliteGraphStore,
  SqliteSnapshotStore,
  type VectorStore,
} from "@ryanstark24/sfgraph-core";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type ToolContext, setToolContextFactory } from "../../context.js";
import { callTool } from "./_runner.js";

/**
 * Audit tools-13: find_similar (a) answers "10 neighbours" for a focal qname
 * that does not exist, (b) lists the focal itself as #1 when the qname is
 * given in a different case, and (c) filters `label` case-sensitively.
 */
const ORG = "00DAUDIT1300000XYZ";
const FOCAL = "ApexClass:OrderHandler";
let workDir = "";
let graphStore: SqliteGraphStore;

function stubVectors(opts: {
  vectors: Map<string, Float32Array>;
  results: Array<{ qname: string; label: string; distance: number }>;
}): VectorStore {
  const lc = (q: string) => q.toLowerCase();
  return {
    init: async () => {},
    close: async () => {},
    upsertNodeVector: () => ({ inserted: true, deduped: false }),
    upsertBundleVector: () => ({ inserted: true, deduped: false }),
    countNodeVectors: () => opts.vectors.size,
    searchBundles: () => [],
    // Case-insensitive, like the real NOCASE store.
    getNodeVector: (_o, q) => {
      for (const [k, v] of opts.vectors) if (lc(k) === lc(String(q))) return v;
      return null;
    },
    deleteNodeVector: () => false,
    getContentHash: () => null,
    searchNodes: () =>
      opts.results.map((r) => ({
        qname: asQualifiedName(r.qname),
        label: r.label,
        distance: r.distance,
      })),
  };
}

async function setup(vectorStore: VectorStore): Promise<ToolContext> {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-audit-t13-"));
  const dbPath = path.join(workDir, "g.sqlite");
  graphStore = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  const ctx: ToolContext = { graphStore, snapshotStore, orgId: asOrgId(ORG), vectorStore };
  setToolContextFactory(async () => ctx);
  return ctx;
}

function node(qname: string, label: string): NodeFact {
  return {
    orgId: asOrgId(ORG),
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(`h-${qname}`),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

afterEach(async () => {
  setToolContextFactory(null);
  await graphStore?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = "";
});

describe("audit tools-13: find_similar focal handling", () => {
  it("does not return neighbours for a focal qname that does not exist", async () => {
    const ctx = await setup(stubVectors({ vectors: new Map(), results: [] }));
    // Unrelated node whose FTS body happens to share words with the typo'd name.
    ctx.graphStore.upsertNodeFts(
      ctx.orgId,
      asQualifiedName("ValidationRule:Quote.Status_Mismatch"),
      "ValidationRule",
      "ValidationRule: does not match",
    );
    let hits: unknown[] = [];
    try {
      const r = await callTool("find_similar", { org: ORG, qname: "ApexClass:DoesNotExist" });
      hits = (r.data as { hits: unknown[] }).hits;
    } catch {
      // Throwing a clear "not found" error is an acceptable fix.
    }
    expect(hits).toEqual([]);
  });

  it("never lists the focal node itself, even when qname case differs", async () => {
    const focalVec = new Float32Array(384);
    focalVec[0] = 1;
    const ctx = await setup(
      stubVectors({
        vectors: new Map([[FOCAL, focalVec]]),
        results: [
          { qname: FOCAL, label: "ApexClass", distance: 0 },
          { qname: "ApexClass:Other", label: "ApexClass", distance: 0.2 },
        ],
      }),
    );
    graphStore.mergeNodes([node(FOCAL, "ApexClass"), node("ApexClass:Other", "ApexClass")]);
    ctx.graphStore.upsertNodeFts(ctx.orgId, asQualifiedName(FOCAL), "ApexClass", "order handler");
    const r = await callTool("find_similar", { org: ORG, qname: "apexclass:orderhandler" });
    const hits = (r.data as { hits: Array<{ qname: string }> }).hits;
    expect(hits.map((h) => h.qname.toLowerCase())).not.toContain(FOCAL.toLowerCase());
  });

  it("matches the `label` filter case-insensitively", async () => {
    const focalVec = new Float32Array(384);
    focalVec[0] = 1;
    const ctx = await setup(
      stubVectors({
        vectors: new Map([[FOCAL, focalVec]]),
        results: [], // keyword leg only: it is the one that applies the label filter
      }),
    );
    graphStore.mergeNodes([node(FOCAL, "ApexClass")]);
    ctx.graphStore.upsertNodeFts(
      ctx.orgId,
      asQualifiedName("ApexClass:OrderKeyword"),
      "ApexClass",
      "order keyword",
    );
    const r = await callTool("find_similar", { org: ORG, qname: FOCAL, label: "apexclass" });
    const hits = (r.data as { hits: Array<{ qname: string }> }).hits;
    expect(hits.length).toBeGreaterThan(0);
  });
});
