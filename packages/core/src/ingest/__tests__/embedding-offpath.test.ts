import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbedPipeline } from "../../embedding/embed.js";
import { EmbeddingPool } from "../../embedding/pool.js";
import { FilesystemMetadataSource } from "../../extractors/filesystem/index.js";
import type { MetadataSource } from "../../extractors/interfaces/metadata-source.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { SqliteVectorStore } from "../../storage/sqlite/vector-store.js";
import { type LiveIngestOpts, type LiveIngestResult, liveIngest } from "../live-ingest.js";
import { offlineResolvedOrg } from "../offline-org.js";

/**
 * Task 11a: embedding runs off the graph-ready path. These tests drive a real
 * offline ingest of a small SFDX fixture into a real graph + vector store
 * (shared connection, as the CLI wires it), with fake embedders where timing
 * or failure has to be controlled.
 */

let dir: string;
let proj: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-embed-offpath-"));
  proj = path.join(dir, "proj");
  writeFixture(proj);
});
afterEach(() => {
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: env var must be truly unset
  delete process.env.SFGRAPH_INGEST_PROFILE;
  rmSync(dir, { recursive: true, force: true });
});

function w(root: string, rel: string, c: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, c, "utf8");
}

function writeFixture(root: string): void {
  const md = "force-app/main/default";
  w(root, "sfdx-project.json", JSON.stringify({ packageDirectories: [{ path: "force-app" }] }));
  w(
    root,
    `${md}/classes/AccountService.cls`,
    `public with sharing class AccountService {
       public static List<Account> load(Set<Id> ids) {
         return [SELECT Id, Name, Tier__c FROM Account WHERE Id IN :ids];
       }
       public static void save(List<Account> accts) { update accts; OrderHelper.touch(accts); }
     }`,
  );
  w(
    root,
    `${md}/classes/OrderHelper.cls`,
    `public class OrderHelper {
       public static void touch(List<Account> a) { insert new Order__c(Account__c = a[0].Id); }
     }`,
  );
  w(
    root,
    `${md}/triggers/AccountTrigger.trigger`,
    "trigger AccountTrigger on Account (before update) { AccountService.save(Trigger.new); }",
  );
  w(
    root,
    `${md}/objects/Account/fields/Tier__c.field-meta.xml`,
    "<CustomField><fullName>Tier__c</fullName><type>Text</type></CustomField>",
  );
  w(
    root,
    `${md}/labels/CustomLabels.labels-meta.xml`,
    "<CustomLabels><labels><fullName>Greeting</fullName><value>Hi</value></labels></CustomLabels>",
  );
}

/** Deterministic, non-zero fake vector derived from the text. */
function fakeVec(text: string): Float32Array {
  const h = createHash("sha256").update(text).digest();
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = ((h[i % 32] as number) - 127.5) / 128;
  return v;
}

interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  close?(): Promise<void> | void;
}

function countingEmbedder(delayMs = 0): Embedder & { texts: number; calls: number } {
  const e = {
    texts: 0,
    calls: 0,
    async embed(texts: string[]) {
      e.calls += 1;
      e.texts += texts.length;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return texts.map(fakeVec);
    },
  };
  return e;
}

interface Stores {
  graph: SqliteGraphStore;
  vectors: SqliteVectorStore;
  dbPath: string;
}

async function openStores(name: string): Promise<Stores> {
  const dbPath = path.join(dir, `${name}.sqlite`);
  const graph = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
  await graph.init();
  const vectors = new SqliteVectorStore({ dbPath, db: graph.db, skipMigrations: true });
  await vectors.init();
  return { graph, vectors, dbPath };
}

const resolved = () => offlineResolvedOrg(proj, "fixture");

async function ingest(s: Stores, extra: Partial<LiveIngestOpts> = {}): Promise<LiveIngestResult> {
  return liveIngest({
    alias: "fixture",
    graphStore: s.graph,
    vectorStore: s.vectors,
    mode: "full",
    rebuild: true,
    preResolved: resolved(),
    metadataSource: await FilesystemMetadataSource.fromProjectRoot(proj),
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
    analysisDb: s.graph.db,
    ...extra,
  });
}

/** qname → hex of the stored vector bytes. */
function vectorBytes(s: Stores): Map<string, string> {
  const rows = s.graph.db
    .prepare(
      `SELECT m.qualified_name AS q, v.embedding AS e
         FROM _sfgraph_node_vector_meta m JOIN _sfgraph_node_vectors v ON v.rowid = m.vec_rowid
        ORDER BY m.qualified_name`,
    )
    .all() as Array<{ q: string; e: Buffer }>;
  return new Map(rows.map((r) => [r.q, Buffer.from(r.e).toString("hex")]));
}

const orgId = () => resolved().orgId;

describe("(a) persistent embedding cache across --rebuild", () => {
  it("a warm-cache rebuild computes 0 texts and its vectors are byte-equal to the cold run", async () => {
    const cacheFile = path.join(dir, "data", "embedding-cache", "m.sqlite");
    const coldStores = await openStores("cold");
    const coldEmbedder = countingEmbedder();
    const cold = await ingest(coldStores, {
      embedder: coldEmbedder,
      embeddingCacheFile: cacheFile,
    });
    expect(coldEmbedder.texts).toBeGreaterThan(5);
    expect(cold.embeddings).toMatchObject({ cached: 0, computed: coldEmbedder.texts, failed: 0 });
    const coldBytes = vectorBytes(coldStores);
    const total = coldStores.graph.getEmbeddingStatus(orgId())?.total ?? -1;
    expect(coldBytes.size).toBe(total);
    await coldStores.graph.close();

    // --rebuild wipes the graph DB; the cache lives outside it.
    const warmStores = await openStores("warm");
    const warmEmbedder = countingEmbedder();
    const warm = await ingest(warmStores, {
      embedder: warmEmbedder,
      embeddingCacheFile: cacheFile,
    });
    expect(warmEmbedder.calls).toBe(0);
    expect(warm.embeddings).toMatchObject({ computed: 0, failed: 0 });
    expect(warm.embeddings?.cached).toBe(coldEmbedder.texts);
    expect(vectorBytes(warmStores)).toEqual(coldBytes);
    await warmStores.graph.close();
  });

  it("with the real MiniLM embedder, cached vectors equal the computed ones byte-for-byte", async () => {
    if (!(await getEmbedPipeline())) return; // optional runtime absent
    const cacheFile = path.join(dir, "real-cache.sqlite");
    const a = await openStores("real-cold");
    const cold = await ingest(a, { embeddingCacheFile: cacheFile });
    expect(cold.embeddings?.computed).toBeGreaterThan(0);
    const coldBytes = vectorBytes(a);
    await a.graph.close();
    const b = await openStores("real-warm");
    const warm = await ingest(b, { embeddingCacheFile: cacheFile });
    expect(warm.embeddings?.computed).toBe(0);
    expect(vectorBytes(b)).toEqual(coldBytes);
    await b.graph.close();
  }, 60_000);
});

describe("(b) graph ready before embeddings", () => {
  it("prints `graph ready` (and profiles it) before the slow embeddings complete", async () => {
    const profile = path.join(dir, "profile.jsonl");
    process.env.SFGRAPH_INGEST_PROFILE = profile;
    const s = await openStores("slow");
    const lines: string[] = [];
    let atGraphReady: { vectors: number; pending: boolean | undefined; total: number } | null =
      null;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      lines.push(line);
      if (line.startsWith("graph ready in ")) {
        const st = s.graph.getEmbeddingStatus(orgId());
        atGraphReady = {
          vectors: s.vectors.countNodeVectors(orgId()),
          pending: st?.pending,
          total: st?.total ?? 0,
        };
      }
    });
    // The flag is set lazily (m-2), at the first dispatch with real work, so
    // it must already be on when the first vector lands.
    let pendingAtFirstWrite: boolean | undefined;
    const upsert = s.vectors.upsertNodeVector.bind(s.vectors);
    vi.spyOn(s.vectors, "upsertNodeVector").mockImplementation((...a) => {
      pendingAtFirstWrite ??= s.graph.getEmbeddingStatus(orgId())?.pending;
      return upsert(...a);
    });
    const slow = countingEmbedder(150);
    const res = await ingest(s, { embedder: slow });

    const ready = lines.findIndex((l) => /^graph ready in \d+(\.\d+)?s$/.test(l));
    const done = lines.findIndex((l) =>
      /^embeddings done in \d+(\.\d+)?s \(cached 0 \/ computed \d+\)$/.test(l),
    );
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(done).toBeGreaterThan(ready);
    expect(atGraphReady).not.toBeNull();
    const snap = atGraphReady as unknown as { vectors: number; pending: boolean; total: number };
    expect(snap.vectors).toBeLessThan(snap.total);
    expect(pendingAtFirstWrite).toBe(true);
    // After the run: everything embedded, flag cleared.
    expect(s.vectors.countNodeVectors(orgId())).toBe(snap.total);
    expect(s.graph.getEmbeddingStatus(orgId())?.pending).toBe(false);
    expect(res.embeddings?.computed).toBe(slow.texts);
    expect(res.graphReadyMs).toBeLessThanOrEqual(res.embeddings?.doneMs ?? -1);

    const phases = readFileSync(profile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { t: string; name?: string; ms?: number; sinceStart?: boolean })
      .filter((r) => r.t === "phase");
    const gr = phases.find((p) => p.name === "graph-ready");
    const em = phases.find((p) => p.name === "embeddings");
    expect(gr?.ms).toBeGreaterThan(0);
    expect(em?.ms).toBeGreaterThanOrEqual(gr?.ms ?? Number.POSITIVE_INFINITY);
    // m-10: these two are timestamps since ingest start, not durations, and
    // say so; every other phase is a duration.
    expect(gr?.sinceStart).toBe(true);
    expect(em?.sinceStart).toBe(true);
    expect(phases.filter((p) => p.sinceStart).map((p) => p.name)).toEqual([
      "graph-ready",
      "embeddings",
    ]);
    await s.graph.close();
  });

  it("waitEmbeddings:false returns at graph ready; the next ingest fills the pending vectors", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await openStores("nowait");
    const res = await ingest(s, { embedder: countingEmbedder(300), waitEmbeddings: false });
    expect(res.embeddings?.pending).toBeGreaterThan(0);
    const total = s.graph.getEmbeddingStatus(orgId())?.total ?? 0;
    expect(s.vectors.countNodeVectors(orgId())).toBeLessThan(total);
    expect(s.graph.getEmbeddingStatus(orgId())?.pending).toBe(true);

    // Next ingest touches nothing (empty source), yet backfills every pending vector.
    const empty: MetadataSource = {
      async *iter() {
        /* no members */
      },
    };
    const next = await ingest(s, {
      embedder: countingEmbedder(),
      metadataSource: empty,
      rebuild: false,
    });
    expect(next.embeddings?.backfilled).toBeGreaterThan(0);
    expect(s.vectors.countNodeVectors(orgId())).toBe(total);
    expect(s.graph.getEmbeddingStatus(orgId())?.pending).toBe(false);
    await s.graph.close();
  });
});

describe("(d) embedding worker crash", () => {
  it("surfaces as an error on the result and stderr, does not hang, and leaves vectors pending", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(" "));
    });
    const workerFile = path.join(dir, "crash-worker.mjs");
    writeFileSync(
      workerFile,
      `import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => process.exit(7));\n`,
    );
    const pool = new EmbeddingPool({ workerUrl: workerFile });
    const s = await openStores("crash");
    const res = await ingest(s, { embedder: pool });
    expect(res.embeddings?.error).toMatch(/embedding worker exited with code 7/);
    expect(res.embeddings?.failed).toBeGreaterThan(0);
    expect(errs.some((l) => /^embeddings failed: .*exited with code 7/.test(l))).toBe(true);
    expect(s.graph.getEmbeddingStatus(orgId())?.pending).toBe(true);
    // The graph itself is complete.
    expect(res.membersProcessed).toBeGreaterThan(0);
    await s.graph.close();
  }, 20_000);
});

describe("I-1: last writer wins on a re-ingest without --rebuild", () => {
  it("a qname emitted twice (different texts, different batches) keeps the LAST text's vector and hash", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Two package dirs both define custom label Dup with different values, with
    // filler labels so the two emissions fall in different 64-item batches
    // that are in flight together (maxInFlight 4).
    const root = path.join(dir, "dup");
    w(
      root,
      "sfdx-project.json",
      JSON.stringify({ packageDirectories: [{ path: "a" }, { path: "b" }] }),
    );
    const label = (name: string, value: string) =>
      `<labels><fullName>${name}</fullName><value>${value}</value></labels>`;
    const fill = Array.from({ length: 80 }, (_, i) => label(`Fill${i}`, `filler ${i}`)).join("");
    w(
      root,
      "a/labels/CustomLabels.labels-meta.xml",
      `<CustomLabels>${label("Dup", "the first value")}${fill}</CustomLabels>`,
    );
    w(
      root,
      "b/labels/CustomLabels.labels-meta.xml",
      `<CustomLabels>${label("Dup", "the second, different value")}</CustomLabels>`,
    );
    const dupOrg = offlineResolvedOrg(root, "fixture").orgId;
    const s = await openStores("lww");
    const seen: string[] = [];
    const recording: Embedder = {
      async embed(texts) {
        seen.push(...texts);
        return texts.map(fakeVec);
      },
    };
    const run = async (rebuild: boolean) =>
      ingest(s, {
        embedder: recording,
        rebuild,
        preResolved: offlineResolvedOrg(root, "fixture"),
        metadataSource: await FilesystemMetadataSource.fromProjectRoot(root),
      });

    const finalDup = () => {
      const fts = [...s.graph.listFtsDocs(dupOrg)].find((d) => d.qname === "CustomLabel:Dup");
      return {
        body: fts?.body ?? "",
        stored: s.vectors.getContentHash(dupOrg, "CustomLabel:Dup" as never),
      };
    };
    const sha = (t: string) => createHash("sha256").update(t).digest("hex");

    await run(true);
    // Both Dup texts were embedded in the cold run (two emissions).
    const coldSeen = [...seen];
    let d = finalDup();
    expect(d.body).toMatch(/value/);
    expect(d.stored).toBe(sha(d.body));

    // Re-ingest the same source without --rebuild: the stored hash already
    // matches the LAST text, the first text differs.
    await run(false);
    d = finalDup();
    expect(d.stored).toBe(sha(d.body));
    expect(vectorBytes(s).get("CustomLabel:Dup")).toBe(
      Buffer.from(fakeVec(d.body).buffer).toString("hex"),
    );

    // And it is stable: a third run does not flip it back.
    await run(false);
    d = finalDup();
    expect(d.stored).toBe(sha(d.body));
    expect(d.body).toBe("CustomLabel: CustomLabel:Dup\nthe second, different value");
    // The superseded first emission was never sent to the model.
    expect(coldSeen.filter((t) => t.includes("CustomLabel:Dup"))).toEqual([d.body]);
    await s.graph.close();
  }, 30_000);
});

describe("fix round 1: pending flag and no-wait", () => {
  it("m-2: a re-sync with nothing to embed never flags the org pending", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await openStores("lazyflag");
    await ingest(s, { embedder: countingEmbedder() });
    expect(s.graph.getEmbeddingStatus(orgId())?.pending).toBe(false);
    const flags: boolean[] = [];
    const orig = s.graph.setEmbeddingsPending.bind(s.graph);
    vi.spyOn(s.graph, "setEmbeddingsPending").mockImplementation((o, p) => {
      flags.push(p);
      return orig(o, p);
    });
    const e = countingEmbedder();
    const res = await ingest(s, { embedder: e, rebuild: false });
    expect(e.calls).toBe(0);
    expect(res.embeddings?.unchanged).toBeGreaterThan(0);
    expect(flags).not.toContain(true);
    expect(s.graph.getEmbeddingStatus(orgId())?.pending).toBe(false);
    await s.graph.close();
  });

  it("m-7: no-wait keeps the flag when force-dispatched batches failed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.SFGRAPH_EMBED_MAX_PENDING_CHARS = "1";
    try {
      const s = await openStores("nowait-fail");
      const failing: Embedder = {
        async embed() {
          throw new Error("worker down");
        },
      };
      const res = await ingest(s, { embedder: failing, waitEmbeddings: false });
      expect(res.embeddings?.failed).toBeGreaterThan(0);
      expect(res.embeddings?.error).toMatch(/worker down/);
      expect(s.graph.getEmbeddingStatus(orgId())?.pending).toBe(true);
      await s.graph.close();
    } finally {
      // biome-ignore lint/performance/noDelete: env var must be truly unset
      delete process.env.SFGRAPH_EMBED_MAX_PENDING_CHARS;
    }
  });

  it("m-8: no-wait writes cache hits before returning, so a warm no-wait run completes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cacheFile = path.join(dir, "nw-cache.sqlite");
    const a = await openStores("nw-cold");
    await ingest(a, { embedder: countingEmbedder(), embeddingCacheFile: cacheFile });
    const total = a.graph.getEmbeddingStatus(orgId())?.total ?? -1;
    await a.graph.close();

    const b = await openStores("nw-warm");
    const e = countingEmbedder();
    const res = await ingest(b, {
      embedder: e,
      embeddingCacheFile: cacheFile,
      waitEmbeddings: false,
    });
    expect(e.calls).toBe(0);
    expect(res.embeddings).toMatchObject({ cached: total, pending: 0 });
    expect(b.vectors.countNodeVectors(orgId())).toBe(total);
    expect(b.graph.getEmbeddingStatus(orgId())?.pending).toBe(false);
    await b.graph.close();
  });
});

describe("Task 11c N-1: pending flag is durable before sync complete", () => {
  it("with unflushed embed work, embeddings_pending is set when markSyncComplete lands", async () => {
    const s = await openStores("n1");
    let pendingAtSyncComplete: boolean | undefined;
    await ingest(s, {
      embedder: countingEmbedder(50),
      onPhase: (name: string) => {
        if (name === "sync-complete") {
          pendingAtSyncComplete = s.graph.getEmbeddingStatus(orgId())?.pending;
        }
      },
    });
    expect(pendingAtSyncComplete).toBe(true);
    // The run itself finishes the vectors and clears the flag.
    expect(s.graph.getEmbeddingStatus(orgId())?.pending).toBe(false);
    await s.graph.close();
  });
});

describe("Task 11c M-8: the pending flag is committed before markSyncComplete runs", () => {
  it("a second connection sees embeddings_pending=1 at the moment markSyncComplete is called", async () => {
    const s = await openStores("n1-durable");
    const seen: number[] = [];
    const orig = s.graph.markSyncComplete.bind(s.graph);
    vi.spyOn(s.graph, "markSyncComplete").mockImplementation((...a) => {
      // What a process killed right here would leave on disk.
      const other = new Database(s.dbPath, { readonly: true });
      try {
        const row = other
          .prepare("SELECT embeddings_pending AS p FROM _sfgraph_orgs WHERE id = ?")
          .get(String(orgId())) as { p: number } | undefined;
        seen.push(row?.p ?? -1);
      } finally {
        other.close();
      }
      return orig(...a);
    });
    await ingest(s, { embedder: countingEmbedder(50) });
    expect(seen).toEqual([1]);
    await s.graph.close();
  });
});
