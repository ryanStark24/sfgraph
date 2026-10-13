import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { SqliteVectorStore, offlineResolvedOrg } from "@ryanstark24/sfgraph-core";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type IngestOpts,
  buildProjectIngestOpts as buildProjectIngestOptsRaw,
  ingestCmd,
  ingestLocks,
  reportEmbeddingOutcome,
  shareEmbedder,
} from "../ingest.js";

/** sqlite-vec loads on this platform (else the CLI runs without vectors). */
const vecAvailable = await (async () => {
  try {
    const vs = new SqliteVectorStore({ dbPath: ":memory:" });
    await vs.init();
    return true;
  } catch {
    return false;
  }
})();

let proj: string;
let data: string;
/**
 * Stores opened by buildProjectIngestOpts, closed before the temp dirs are
 * removed: Windows cannot delete an open SQLite file (EBUSY).
 */
const opened: Array<{ close(): Promise<void> }> = [];
const buildProjectIngestOpts: typeof buildProjectIngestOptsRaw = async (...args) => {
  const o = await buildProjectIngestOptsRaw(...args);
  if (o.vectorStore) opened.push(o.vectorStore as unknown as { close(): Promise<void> });
  if (o.graphStore) opened.push(o.graphStore as { close(): Promise<void> });
  return o;
};
beforeEach(() => {
  proj = mkdtempSync(path.join(tmpdir(), "sfg-proj-"));
  data = mkdtempSync(path.join(tmpdir(), "sfg-data-"));
  process.env.SFGRAPH_DATA_DIR = data;
  mkdirSync(path.join(proj, "force-app/main/default/classes"), { recursive: true });
  writeFileSync(
    path.join(proj, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
  );
  writeFileSync(path.join(proj, "force-app/main/default/classes/Foo.cls"), "public class Foo {}");
});
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close().catch(() => {});
  vi.restoreAllMocks();
  // biome-ignore lint/performance/noDelete: env var must be truly unset
  delete process.env.SFGRAPH_EMBED_MODEL_PATH;
  rmSync(proj, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  // biome-ignore lint/performance/noDelete: env var must be truly unset
  delete process.env.SFGRAPH_DATA_DIR;
});

it("builds offline opts writing <orgId>.sqlite inside SFGRAPH_DATA_DIR", async () => {
  const o = await buildProjectIngestOpts(
    { project: proj, org: "acme-repo" },
    new ConsoleLogger("error"),
  );
  expect(o.metadataSource).toBeDefined();
  expect(o.alias).toBe("acme-repo");
  expect(String(o.preResolved?.orgId)).toMatch(/^00DFS/);
  expect(existsSync(path.join(data, `${o.preResolved?.orgId}.sqlite`))).toBe(true);
});

it("rejects a directory without sfdx-project.json", async () => {
  rmSync(path.join(proj, "sfdx-project.json"));
  await expect(
    buildProjectIngestOpts({ project: proj }, new ConsoleLogger("error")),
  ).rejects.toThrow(/sfdx-project.json/);
});

it.skipIf(!vecAvailable)(
  "wires the persistent embedding cache under the data dir and waits for embeddings by default",
  async () => {
    const o = await buildProjectIngestOpts(
      { project: proj, org: "acme-repo" },
      new ConsoleLogger("error"),
    );
    expect(o.vectorStore).toBeDefined();
    // Keyed by model id AND the model file's sha256 (ruling b).
    expect(path.dirname(String(o.embeddingCacheFile))).toBe(path.join(data, "embedding-cache"));
    expect(path.basename(String(o.embeddingCacheFile))).toMatch(
      /^Xenova_all-MiniLM-L6-v2@[0-9a-f]{16}\.sqlite$/,
    );
    expect(o.waitEmbeddings).toBe(true);
  },
);

it.skipIf(!vecAvailable)("--no-wait-embeddings returns at graph ready", async () => {
  const o = await buildProjectIngestOpts(
    { project: proj, org: "acme-repo", noWaitEmbeddings: true },
    new ConsoleLogger("error"),
  );
  expect(o.vectorStore).toBeDefined();
  expect(o.waitEmbeddings).toBe(false);
});

it.skipIf(!vecAvailable)(
  "ruling (b): the cache file changes when the model weights change under the same model id",
  async () => {
    const models = mkdtempSync(path.join(tmpdir(), "sfg-models-"));
    try {
      process.env.SFGRAPH_EMBED_MODEL_PATH = models;
      const onnx = path.join(models, "Xenova", "all-MiniLM-L6-v2", "onnx");
      mkdirSync(onnx, { recursive: true });
      const sha16 = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
      const build = async () =>
        (await buildProjectIngestOpts({ project: proj, org: "p" }, new ConsoleLogger("error")))
          .embeddingCacheFile;

      writeFileSync(path.join(onnx, "model_quantized.onnx"), "weights v1");
      const a = await build();
      expect(path.basename(String(a))).toBe(
        `Xenova_all-MiniLM-L6-v2@${sha16("weights v1")}.sqlite`,
      );

      writeFileSync(path.join(onnx, "model_quantized.onnx"), "weights v2, retrained");
      const b = await build();
      expect(path.basename(String(b))).toBe(
        `Xenova_all-MiniLM-L6-v2@${sha16("weights v2, retrained")}.sqlite`,
      );
      expect(b).not.toBe(a);

      // No model file: no cache (nothing trustworthy to key it by).
      rmSync(path.join(onnx, "model_quantized.onnx"));
      expect(await build()).toBeUndefined();
    } finally {
      rmSync(models, { recursive: true, force: true });
    }
  },
);

it("ruling (a): an embedding failure after graph ready warns and keeps exit code 0", () => {
  const warns: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(" "));
  });
  const before = process.exitCode;
  try {
    reportEmbeddingOutcome({
      embeddings: { error: "embedding worker exited with code 7", failed: 12, pending: 12 },
    });
    expect(process.exitCode).toBe(before);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^warning: .*12 texts .*pending.*next ingest/);
    // Nothing to say when embeddings succeeded.
    reportEmbeddingOutcome({ embeddings: { failed: 0, pending: 0 } });
    reportEmbeddingOutcome({});
    expect(warns).toHaveLength(1);
  } finally {
    process.exitCode = before;
  }
});

it("m-6: multi-org ingests share one embedder", async () => {
  const pool = { embed: async (t: string[]) => t.map(() => new Float32Array(384)) };
  const build = shareEmbedder(
    async (alias: string) =>
      ({
        alias,
        vectorStore: {} as never,
      }) as never,
    pool,
  );
  const a = await build("a");
  const b = await build("b");
  expect(a.embedder).toBe(pool);
  expect(b.embedder).toBe(pool);
  // Without a vector store there is nothing to embed: left untouched.
  const none = await shareEmbedder(async (alias: string) => ({ alias }) as never, pool)("c");
  expect(none.embedder).toBeUndefined();
});

describe("Task 11c: ingest --project --delta and the ingest lock", () => {
  const run = async (o: Partial<IngestOpts>): Promise<string[]> => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await ingestCmd({ project: proj, org: "p", noWaitEmbeddings: true, ...o });
    } finally {
      vi.restoreAllMocks();
    }
    return lines;
  };
  let models: string;
  let exitBefore: typeof process.exitCode;
  beforeEach(() => {
    // No model file: structural ingest only (no inference in this test).
    models = mkdtempSync(path.join(tmpdir(), "sfg-nomodel-"));
    process.env.SFGRAPH_EMBED_MODEL_PATH = models;
    exitBefore = process.exitCode;
  });
  afterEach(() => {
    process.exitCode = exitBefore;
    rmSync(models, { recursive: true, force: true });
  });

  it("a graph without member rows rebuilds, then a delta reports +A ~C -D", async () => {
    const first = await run({ delta: true });
    expect(first).toContain(
      "delta: graph has no member hashes (built by an older sfgraph); running full rebuild",
    );
    writeFileSync(path.join(proj, "force-app/main/default/classes/Bar.cls"), "public class Bar {}");
    const second = await run({ delta: true });
    expect(second.some((l) => /^delta: \+1 ~0 -0 \(=1 unchanged\) in \d+\.\ds$/.test(l))).toBe(
      true,
    );
    const lockFiles = readdirSync(data).filter((f) => f.endsWith(".ingest.lock"));
    expect(lockFiles).toEqual([]);
  });

  it("refuses while another live ingest holds the org's lock", async () => {
    const orgId = String(offlineResolvedOrg(proj, "p").orgId);
    // Taken after the holder started (an older stamp reads as pid reuse, I-3).
    const startedAt = new Date().toISOString();
    writeFileSync(
      path.join(data, `${orgId}.ingest.lock`),
      JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt }),
    );
    const out = await run({ delta: true });
    expect(out).toContain(
      `ingest already running for p (pid ${process.ppid} since ${startedAt}); retry later`,
    );
    expect(process.exitCode).toBe(1);
    // Not ours: left in place.
    expect(existsSync(path.join(data, `${orgId}.ingest.lock`))).toBe(true);
  });
});

describe("Task 11c M-5: ingest locks and signals", () => {
  it("SIGINT / SIGTERM release held locks, and handlers go away on release", () => {
    const before = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const got: string[] = [];
    const locks = ingestLocks({ dir: data, onSignal: (s) => got.push(s) });
    locks.take("00DSIG000000001", "sig");
    const lockFile = path.join(data, "00DSIG000000001.ingest.lock");
    expect(existsSync(lockFile)).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    process.emit("SIGINT", "SIGINT");
    expect(got).toEqual(["SIGINT"]);
    expect(existsSync(lockFile)).toBe(false);
    expect(process.listenerCount("SIGINT")).toBe(before);

    const again = ingestLocks({ dir: data, onSignal: (s) => got.push(s) });
    again.take("00DSIG000000001", "sig");
    process.emit("SIGTERM", "SIGTERM");
    expect(got).toEqual(["SIGINT", "SIGTERM"]);
    expect(existsSync(lockFile)).toBe(false);
    again.releaseAll();
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });

  it("N-3: by default a signal exits explicitly (128 + signo) after releasing, even with other listeners", () => {
    const other = (): void => {};
    process.on("SIGINT", other);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const locks = ingestLocks({ dir: data });
      locks.take("00DSIG000000002", "sig");
      process.emit("SIGINT", "SIGINT");
      expect(existsSync(path.join(data, "00DSIG000000002.ingest.lock"))).toBe(false);
      expect(exit).toHaveBeenCalledWith(130);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      kill.mockRestore();
      process.off("SIGINT", other);
    }
  });
});
