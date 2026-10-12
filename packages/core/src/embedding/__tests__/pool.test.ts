import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingPool } from "../pool.js";
import { EmbeddingQueue, type VectorSink } from "../queue.js";

/**
 * EmbeddingPool runs inference in a worker_thread. These tests drive it with
 * small fake worker scripts that speak the same protocol as worker.ts
 * ({id, texts} in; {id, vectors} or {id, error} out), so they need neither the
 * model nor a build.
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-pool-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeWorker(body: string): string {
  const file = path.join(dir, `w-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    file,
    `import { parentPort, workerData } from "node:worker_threads";\n${body}\n`,
    "utf8",
  );
  return file;
}

const ECHO = `
parentPort.on("message", ({ id, texts }) => {
  const vectors = texts.map((t) => { const v = new Float32Array(4); v[0] = t.length; v[1] = workerData?.tag ?? 0; return v; });
  parentPort.postMessage({ id, vectors }, vectors.map((v) => v.buffer));
});`;

describe("EmbeddingPool", () => {
  it("m-1: a worker that never replies is treated as hung: pending calls reject, later calls fail fast", async () => {
    const pool = new EmbeddingPool({
      workerUrl: fakeWorker(`parentPort.on("message", () => { /* never reply */ });`),
      requestTimeoutMs: 150,
    });
    try {
      const t0 = Date.now();
      const p1 = pool.embed(["x"]);
      const p2 = pool.embed(["y"]);
      const r1 = expect(p1).rejects.toThrow(/unresponsive/);
      const r2 = expect(p2).rejects.toThrow(/unresponsive/);
      await r1;
      await r2;
      expect(Date.now() - t0).toBeLessThan(5_000);
      await expect(pool.embed(["z"])).rejects.toThrow(/unresponsive/);
      expect(pool.inFlight).toBe(0);
    } finally {
      await pool.close();
    }
  });

  it("m-1: the timeout measures lack of progress, not queueing behind earlier requests", async () => {
    // Each request takes 100 ms; four queued requests take 400 ms in total,
    // well over the 250 ms timeout, yet none is unresponsive.
    const pool = new EmbeddingPool({
      workerUrl: fakeWorker(`
const q = []; let busy = false;
const next = () => { if (busy || q.length === 0) return; busy = true; const { id, texts } = q.shift();
  setTimeout(() => { parentPort.postMessage({ id, vectors: texts.map(() => new Float32Array(4).fill(1)) }); busy = false; next(); }, 100); };
parentPort.on("message", (m) => { q.push(m); next(); });`),
      requestTimeoutMs: 250,
    });
    try {
      const rs = await Promise.all([0, 1, 2, 3].map((i) => pool.embed([`t${i}`])));
      expect(rs.length).toBe(4);
    } finally {
      await pool.close();
    }
  });

  it("embeds in a worker thread and maps results back to each request", async () => {
    const pool = new EmbeddingPool({ workerUrl: fakeWorker(ECHO), workerData: { tag: 7 } });
    try {
      const [a, b] = await Promise.all([pool.embed(["a", "bbb"]), pool.embed(["cc"])]);
      expect(a.map((v) => [v[0], v[1]])).toEqual([
        [1, 7],
        [3, 7],
      ]);
      expect(b.map((v) => v[0])).toEqual([2]);
      expect(a[0]).toBeInstanceOf(Float32Array);
    } finally {
      await pool.close();
    }
  });

  it("a worker that exits mid-request rejects every pending call and fails fast afterwards (no hang)", async () => {
    const pool = new EmbeddingPool({
      workerUrl: fakeWorker(`parentPort.on("message", () => process.exit(3));`),
    });
    try {
      const p1 = pool.embed(["x"]);
      const p2 = pool.embed(["y"]);
      await expect(p1).rejects.toThrow(/embedding worker exited.*3/);
      await expect(p2).rejects.toThrow(/embedding worker exited/);
      await expect(pool.embed(["z"])).rejects.toThrow(/embedding worker exited/);
    } finally {
      await pool.close();
    }
  });

  it("an uncaught error in the worker surfaces as the rejection reason", async () => {
    const pool = new EmbeddingPool({
      workerUrl: fakeWorker(
        `parentPort.on("message", () => { throw new Error("onnx exploded"); });`,
      ),
    });
    try {
      await expect(pool.embed(["x"])).rejects.toThrow(/onnx exploded/);
    } finally {
      await pool.close();
    }
  });

  it("a per-request error rejects only that request", async () => {
    const pool = new EmbeddingPool({
      workerUrl: fakeWorker(`
parentPort.on("message", ({ id, texts }) => {
  if (texts[0] === "bad") return parentPort.postMessage({ id, error: "bad input" });
  parentPort.postMessage({ id, vectors: texts.map(() => new Float32Array([1, 0, 0, 0])) });
});`),
    });
    try {
      await expect(pool.embed(["bad"])).rejects.toThrow(/bad input/);
      expect((await pool.embed(["ok"])).length).toBe(1);
    } finally {
      await pool.close();
    }
  });

  it("close() rejects outstanding requests", async () => {
    const pool = new EmbeddingPool({
      workerUrl: fakeWorker(`parentPort.on("message", () => {});`),
    });
    const p = expect(pool.embed(["never answered"])).rejects.toThrow(/closed/);
    await pool.close();
    await p;
  });

  it("through EmbeddingQueue, a crash is reported via onError and drain() completes", async () => {
    const pool = new EmbeddingPool({
      workerUrl: fakeWorker(`parentPort.on("message", () => process.exit(1));`),
    });
    const errors: string[] = [];
    const writes: string[] = [];
    const sink: VectorSink = {
      upsertNodeVector(_o, q) {
        writes.push(String(q));
        return {};
      },
    };
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 2,
      maxInFlight: 2,
      embed: (t) => pool.embed(t),
      onError: (e) => errors.push(e.message),
    });
    for (let i = 0; i < 7; i++) q.push({ qname: `A:${i}`, text: `t${i}`, orgId: "o", label: "A" });
    await q.drain();
    await pool.close();
    expect(writes).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/embedding worker exited/);
    expect(q.stats.failed).toBe(7);
  });
});
