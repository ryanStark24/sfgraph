import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { EmbeddingCacheLike } from "../cache.js";
import { EmbeddingQueue, type VectorSink } from "../queue.js";

/** Records every upsert in call order. */
function makeSink(): VectorSink & {
  writes: Array<{ qname: string; v0: number; hash: string }>;
} {
  const writes: Array<{ qname: string; v0: number; hash: string }> = [];
  return {
    writes,
    upsertNodeVector(_o, qname, _l, vector, hash) {
      writes.push({ qname: String(qname), v0: vector[0] as number, hash: String(hash) });
      return {};
    },
  };
}

/** Deterministic non-zero vector from the text (first component = text length). */
function vecFor(text: string): Float32Array {
  const v = new Float32Array(4);
  v[0] = text.length;
  v[1] = 1;
  return v;
}

function memCache(): EmbeddingCacheLike & { map: Map<string, Float32Array> } {
  const map = new Map<string, Float32Array>();
  return {
    map,
    getMany(hashes, dim) {
      const out = new Map<string, Float32Array>();
      for (const h of hashes) {
        const v = map.get(h);
        if (v && v.length === dim) out.set(h, new Float32Array(v));
      }
      return out;
    },
    putMany(entries) {
      for (const e of entries) if (!map.has(e.hash)) map.set(e.hash, new Float32Array(e.vector));
    },
  };
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const item = (qname: string, text: string) => ({ qname, text, orgId: "o", label: "L" });

describe("EmbeddingQueue — persistent cache", () => {
  it("serves cache hits without the model, computes misses, and stores computed vectors", async () => {
    const cache = memCache();
    cache.putMany([{ hash: sha("aa"), vector: vecFor("cached-aa") }]);
    const seen: string[] = [];
    const sink = makeSink();
    const q = new EmbeddingQueue({
      vectorStore: sink,
      cache,
      dim: 4,
      embed: async (texts) => {
        seen.push(...texts);
        return texts.map(vecFor);
      },
    });
    q.push(item("A:1", "aa"));
    q.push(item("A:2", "bbb"));
    await q.drain();
    expect(seen).toEqual(["bbb"]);
    expect(q.stats).toMatchObject({ cached: 1, computed: 1 });
    // Cached vector is the stored bytes, not a recompute.
    expect(sink.writes.map((w) => [w.qname, w.v0])).toEqual([
      ["A:1", "cached-aa".length],
      ["A:2", 3],
    ]);
    expect(cache.map.has(sha("bbb"))).toBe(true);
  });

  it("a warm run computes 0 texts and writes byte-identical vectors to the cold run", async () => {
    const cache = memCache();
    const texts = Array.from({ length: 150 }, (_, i) => `text number ${i} ${"x".repeat(i % 17)}`);
    const run = async (embed: (t: string[]) => Promise<Float32Array[]>) => {
      const bytes = new Map<string, string>();
      const sink: VectorSink = {
        upsertNodeVector(_o, qname, _l, v) {
          bytes.set(
            String(qname),
            Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex"),
          );
          return {};
        },
      };
      const q = new EmbeddingQueue({ vectorStore: sink, cache, dim: 4, embed });
      texts.forEach((t, i) => q.push(item(`Q:${i}`, t)));
      await q.drain();
      return { bytes, stats: q.stats };
    };
    const cold = await run(async (t) => t.map((s) => vecFor(`${s}!`)));
    expect(cold.stats.computed).toBe(150);
    const warm = await run(async () => {
      throw new Error("model must not run on a warm cache");
    });
    expect(warm.stats).toMatchObject({ cached: 150, computed: 0, failed: 0 });
    expect(warm.bytes).toEqual(cold.bytes);
  });

  it("never caches all-zero (failure-fallback) vectors", async () => {
    const cache = memCache();
    const q = new EmbeddingQueue({
      vectorStore: makeSink(),
      cache,
      dim: 4,
      embed: async (t) => t.map(() => new Float32Array(4)),
    });
    q.push(item("A:1", "zz"));
    await q.drain();
    expect(cache.map.size).toBe(0);
  });
});

describe("EmbeddingQueue — pipelining", () => {
  it("keeps up to maxInFlight batches in flight and writes in dispatch order (last writer wins)", async () => {
    const calls: Array<{ texts: string[]; d: ReturnType<typeof deferred<Float32Array[]>> }> = [];
    const sink = makeSink();
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 2,
      maxInFlight: 2,
      embed: (texts) => {
        const d = deferred<Float32Array[]>();
        calls.push({ texts, d });
        return d.promise;
      },
    });
    q.push(item("X", "first"));
    q.push(item("Y", "y"));
    q.push(item("X", "second-text"));
    q.push(item("Z", "z"));
    q.push(item("W", "w"));
    q.push(item("V", "v"));
    // Two batches dispatched, the third waits for a slot.
    expect(calls.length).toBe(2);
    // Resolve the SECOND batch first: its writes must still land after batch 1.
    calls[1]?.d.resolve((calls[1]?.texts ?? []).map(vecFor));
    await new Promise((r) => setTimeout(r, 5));
    expect(sink.writes.length).toBe(0);
    calls[0]?.d.resolve((calls[0]?.texts ?? []).map(vecFor));
    await new Promise((r) => setTimeout(r, 5));
    // Slot freed: the third batch was dispatched without another push().
    expect(calls.length).toBe(3);
    calls[2]?.d.resolve((calls[2]?.texts ?? []).map(vecFor));
    await q.drain();
    const xs = sink.writes.filter((w) => w.qname === "X");
    // The superseded first emission of X is never written (last writer wins).
    expect(xs.map((w) => w.v0)).toEqual(["second-text".length]);
    expect(xs.at(-1)?.hash).toBe(sha("second-text"));
    expect(sink.writes.map((w) => w.qname)).toEqual(["Y", "X", "Z", "W", "V"]);
    expect(q.stats.superseded).toBe(1);
  });

  it("startDrain() flushes a partial batch in the background", async () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 64,
      embed: async (t) => t.map(vecFor),
    });
    q.push(item("A:1", "a"));
    q.startDrain();
    await new Promise((r) => setTimeout(r, 5));
    expect(sink.writes.length).toBe(1);
    await q.drain();
  });

  it("abandon() drops pending work, reports how much, and drain resolves", async () => {
    const d = deferred<Float32Array[]>();
    const q = new EmbeddingQueue({
      vectorStore: makeSink(),
      batchSize: 2,
      embed: () => d.promise,
    });
    for (let i = 0; i < 5; i++) q.push(item(`A:${i}`, `t${i}`));
    expect(q.abandon()).toBe(5); // 2 in flight + 3 buffered
    d.resolve([vecFor("a"), vecFor("b")]);
    await q.drain();
    expect(q.pending).toBe(0);
  });

  it("a failing embed counts the batch as failed, calls onError and does not stall later batches", async () => {
    const errors: string[] = [];
    let n = 0;
    const sink = makeSink();
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 1,
      maxInFlight: 2,
      onError: (e) => errors.push(e.message),
      embed: async (t) => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return t.map(vecFor);
      },
    });
    q.push(item("A:1", "a"));
    q.push(item("A:2", "b"));
    await q.drain();
    expect(errors).toEqual(["boom"]);
    expect(q.stats.failed).toBe(1);
    expect(sink.writes.map((w) => w.qname)).toEqual(["A:2"]);
  });
});

describe("EmbeddingQueue — backpressure", () => {
  it("reports overCapacity above maxPendingChars and waitForCapacity resolves once it drains below", async () => {
    const d = deferred<Float32Array[]>();
    let first = true;
    const q = new EmbeddingQueue({
      vectorStore: makeSink(),
      batchSize: 2,
      maxPendingChars: 10,
      embed: (t) => {
        if (first) {
          first = false;
          return d.promise;
        }
        return Promise.resolve(t.map(vecFor));
      },
    });
    q.push(item("A:1", "aaaa"));
    q.push(item("A:2", "bbbb")); // dispatched (in flight)
    q.push(item("A:3", "cccccc"));
    q.push(item("A:4", "dddddd")); // dispatch blocked behind the in-flight batch
    expect(q.overCapacity).toBe(true);
    let released = false;
    const wait = q.waitForCapacity().then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(released).toBe(false);
    d.resolve([vecFor("a"), vecFor("b")]);
    await wait;
    expect(released).toBe(true);
    await q.drain();
    expect(q.overCapacity).toBe(false);
  });
});

describe("EmbeddingQueue — hold until graph ready", () => {
  it("held, it buffers full batches without calling the model; release() runs them", async () => {
    const sink = makeSink();
    let calls = 0;
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 2,
      maxInFlight: 4,
      hold: true,
      embed: async (t) => {
        calls += 1;
        return t.map(vecFor);
      },
    });
    for (let i = 0; i < 6; i++) q.push(item(`A:${i}`, `t${i}`));
    q.startDrain();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(0);
    expect(q.pending).toBe(6);
    q.release();
    await q.drain();
    expect(calls).toBe(3);
    expect(sink.writes.map((w) => w.qname)).toEqual(["A:0", "A:1", "A:2", "A:3", "A:4", "A:5"]);
  });

  it("held, backpressure still dispatches so memory stays bounded", async () => {
    const sink = makeSink();
    let calls = 0;
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 2,
      maxInFlight: 1,
      hold: true,
      maxPendingChars: 10,
      embed: async (t) => {
        calls += 1;
        return t.map(vecFor);
      },
    });
    for (let i = 0; i < 4; i++) q.push(item(`A:${i}`, "xxxx"));
    expect(q.overCapacity).toBe(true);
    await q.waitForCapacity();
    expect(calls).toBeGreaterThan(0);
    expect(q.overCapacity).toBe(false);
    q.release();
    await q.drain();
    expect(sink.writes).toHaveLength(4);
  });
});

/** A sink that remembers the latest hash per qname, like SqliteVectorStore. */
function storeSink(seed: Record<string, string> = {}): VectorSink & {
  writes: Array<{ qname: string; v0: number; hash: string }>;
  hashes: Map<string, string>;
} {
  const writes: Array<{ qname: string; v0: number; hash: string }> = [];
  const hashes = new Map<string, string>(Object.entries(seed));
  return {
    writes,
    hashes,
    upsertNodeVector(_o, qname, _l, vector, hash) {
      writes.push({ qname: String(qname), v0: vector[0] as number, hash: String(hash) });
      hashes.set(String(qname), String(hash));
      return {};
    },
    getContentHash(_o, qname) {
      return (hashes.get(String(qname)) ?? null) as never;
    },
  };
}

describe("EmbeddingQueue — last writer wins across batches (I-1)", () => {
  it("a later unchanged emission supersedes an earlier changed one still in flight", async () => {
    // Re-ingest without rebuild: the store already holds X's vector for T2.
    // X is emitted with T1 (batch 1, in flight) and then T2 (batch 2): the
    // final stored vector must be T2's, not T1's.
    const calls: Array<{ texts: string[]; d: ReturnType<typeof deferred<Float32Array[]>> }> = [];
    const sink = storeSink({ X: sha("t2-final") });
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 2,
      maxInFlight: 4,
      embed: (texts) => {
        const d = deferred<Float32Array[]>();
        calls.push({ texts, d });
        return d.promise;
      },
    });
    q.push(item("X", "t1-first-body"));
    q.push(item("A", "a"));
    q.push(item("B", "b"));
    q.push(item("X", "t2-final"));
    q.startDrain();
    for (const c of calls) c.d.resolve(c.texts.map(vecFor));
    await q.drain();
    expect(sink.hashes.get("X")).toBe(sha("t2-final"));
    expect(sink.writes.filter((w) => w.qname === "X").map((w) => w.v0)).toEqual([]);
  });

  it("a later changed emission in a later batch wins even if it resolves first", async () => {
    const calls: Array<{ texts: string[]; d: ReturnType<typeof deferred<Float32Array[]>> }> = [];
    const sink = storeSink();
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 2,
      maxInFlight: 4,
      embed: (texts) => {
        const d = deferred<Float32Array[]>();
        calls.push({ texts, d });
        return d.promise;
      },
    });
    q.push(item("X", "first-long-body"));
    q.push(item("A", "a"));
    q.push(item("X", "second"));
    q.push(item("B", "b"));
    expect(calls.length).toBe(2);
    (calls[1] as (typeof calls)[number]).d.resolve((calls[1]?.texts ?? []).map(vecFor));
    (calls[0] as (typeof calls)[number]).d.resolve((calls[0]?.texts ?? []).map(vecFor));
    await q.drain();
    const xs = sink.writes.filter((w) => w.qname === "X");
    expect(xs.at(-1)?.v0).toBe("second".length);
    expect(sink.hashes.get("X")).toBe(sha("second"));
    // The superseded first text is never written.
    expect(xs.map((w) => w.v0)).toEqual(["second".length]);
  });

  it("within one batch, an unchanged last emission supersedes a changed first one", async () => {
    const sink = storeSink({ X: sha("same") });
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 64,
      embed: async (t) => t.map(vecFor),
    });
    q.push(item("X", "different-earlier"));
    q.push(item("X", "same"));
    await q.drain();
    expect(sink.hashes.get("X")).toBe(sha("same"));
    expect(sink.writes).toEqual([]);
    expect(q.stats.unchanged).toBe(1);
  });

  it("keys supersede by org as well as qname", async () => {
    const sink = storeSink();
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 64,
      embed: async (t) => t.map(vecFor),
    });
    q.push({ qname: "X", text: "one", orgId: "o1", label: "L" });
    q.push({ qname: "X", text: "two!", orgId: "o2", label: "L" });
    await q.drain();
    expect(sink.writes.map((w) => w.v0)).toEqual([3, 4]);
  });
});

describe("EmbeddingQueue — fix round 1 behaviours", () => {
  it("m-3: a cache write failure is a warning, not an embedding failure", async () => {
    const errors: string[] = [];
    const cacheErrors: string[] = [];
    const sink = makeSink();
    const cache = memCache();
    cache.putMany = () => {
      throw new Error("SQLITE_BUSY");
    };
    const q = new EmbeddingQueue({
      vectorStore: sink,
      cache,
      dim: 4,
      embed: async (t) => t.map(vecFor),
      onError: (e) => errors.push(e.message),
      onCacheError: (e) => cacheErrors.push(e.message),
    });
    q.push(item("A", "aa"));
    await q.drain();
    expect(sink.writes.length).toBe(1);
    expect(errors).toEqual([]);
    expect(cacheErrors).toEqual(["SQLITE_BUSY"]);
    expect(q.stats.failed).toBe(0);
  });

  it("m-9: a superseded in-flight emission is not cached; the cache holds the latest text's vector", async () => {
    const calls: Array<{ texts: string[]; d: ReturnType<typeof deferred<Float32Array[]>> }> = [];
    const cache = memCache();
    const q = new EmbeddingQueue({
      vectorStore: makeSink(),
      cache,
      dim: 4,
      batchSize: 1,
      maxInFlight: 4,
      embed: (texts) => {
        const d = deferred<Float32Array[]>();
        calls.push({ texts, d });
        return d.promise;
      },
    });
    q.push(item("X", "old"));
    q.push(item("X", "new!"));
    expect(calls.length).toBe(2);
    for (const c of calls) c.d.resolve(c.texts.map(vecFor));
    await q.drain();
    expect([...cache.map.keys()]).toEqual([sha("new!")]);
  });

  it("m-2: onWork fires once, only when there is real vector work", async () => {
    let work = 0;
    const sink = storeSink({ A: sha("same") });
    const q = new EmbeddingQueue({
      vectorStore: sink,
      embed: async (t) => t.map(vecFor),
      onWork: () => {
        work += 1;
      },
    });
    q.push(item("A", "same"));
    await q.drain();
    expect(q.stats.unchanged).toBe(1);
    expect(work).toBe(0);
    q.push(item("B", "b"));
    q.push(item("C", "c"));
    await q.drain();
    expect(work).toBe(1);
  });

  it("m-2: abandoning live work signals it (the vectors are left pending)", () => {
    let work = 0;
    const q = new EmbeddingQueue({
      vectorStore: makeSink(),
      hold: true,
      embed: async (t) => t.map(vecFor),
      onWork: () => {
        work += 1;
      },
    });
    q.push(item("A", "a"));
    expect(work).toBe(0);
    expect(q.abandon()).toBe(1);
    expect(work).toBe(1);
  });

  it("m-8: flushCached() writes buffered cache hits without the model and leaves misses queued", async () => {
    const cache = memCache();
    cache.map.set(sha("hit"), vecFor("hit"));
    let modelCalls = 0;
    const sink = makeSink();
    const q = new EmbeddingQueue({
      vectorStore: sink,
      cache,
      dim: 4,
      hold: true,
      embed: async (t) => {
        modelCalls += 1;
        return t.map(vecFor);
      },
    });
    q.push(item("H", "hit"));
    q.push(item("M", "miss"));
    q.push(item("S", "superseded"));
    q.push(item("S", "hit")); // same text as H's cache entry, different qname is fine
    expect(q.flushCached()).toBe(2);
    expect(sink.writes.map((w) => w.qname)).toEqual(["H", "S"]);
    expect(q.stats.superseded).toBe(1);
    expect(q.pending).toBe(1);
    expect(q.abandon()).toBe(1);
    expect(modelCalls).toBe(0);
  });
});
