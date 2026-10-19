import { describe, expect, it } from "vitest";
import { EmbeddingQueue, type VectorSink } from "../queue.js";

function makeSink(): VectorSink & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    upsertNodeVector(orgId, qname, label, vector, contentHash) {
      calls.push({
        orgId: String(orgId),
        qname: String(qname),
        label,
        len: vector.length,
        contentHash: String(contentHash),
      });
      return { upserted: true };
    },
  };
}

/** Non-zero stub vectors — the queue now skips all-zero vectors (they poison
 *  find_similar), so batching/drain tests must produce real-ish vectors. */
const embedOnes = async (texts: string[]) =>
  texts.map(() => {
    const v = new Float32Array(384);
    v[0] = 1;
    return v;
  });
/** All-zero stub — used to assert the queue drops them. */
const embedZero = async (texts: string[]) => texts.map(() => new Float32Array(384));

describe("EmbeddingQueue", () => {
  it("does not auto-flush below batchSize", () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 4, embed: embedOnes });
    q.push({ qname: "A:1", text: "a", orgId: "o", label: "A" });
    q.push({ qname: "A:2", text: "b", orgId: "o", label: "A" });
    expect(sink.calls.length).toBe(0);
    expect(q.pending).toBe(2);
  });

  it("auto-flushes once batchSize is reached and drain awaits in-flight", async () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 2, embed: embedOnes });
    q.push({ qname: "A:1", text: "a", orgId: "o", label: "A" });
    q.push({ qname: "A:2", text: "b", orgId: "o", label: "A" });
    await q.drain();
    expect(sink.calls.length).toBe(2);
  });

  it("drain flushes all queued items, regardless of batchSize", async () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 16, embed: embedOnes });
    for (let i = 0; i < 5; i++) {
      q.push({ qname: `A:${i}`, text: `t${i}`, orgId: "o", label: "A" });
    }
    await q.drain();
    expect(sink.calls.length).toBe(5);
  });

  it("invokes onError and keeps ingest alive when embed() throws", async () => {
    const sink = makeSink();
    const errors: Error[] = [];
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 1,
      embed: async () => {
        throw new Error("boom");
      },
      onError: (e) => errors.push(e),
    });
    q.push({ qname: "A:1", text: "a", orgId: "o", label: "A" });
    await q.drain();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]?.message).toBe("boom");
    expect(sink.calls.length).toBe(0);
  });
});

describe("EmbeddingQueue — content hash + zero-vector guard (audit fixes)", () => {
  it("content hash reflects the embed TEXT, so changed text re-embeds and identical text dedups", async () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 16, embed: embedOnes });
    q.push({ qname: "A:1", text: "endpoint = https://old", orgId: "o", label: "A" });
    q.push({ qname: "A:2", text: "endpoint = https://old", orgId: "o", label: "A" });
    q.push({ qname: "A:3", text: "endpoint = https://NEW", orgId: "o", label: "A" });
    await q.drain();
    const hashes = sink.calls as Array<{ qname: string; contentHash: string }>;
    const h1 = hashes.find((c) => c.qname === "A:1")!.contentHash;
    const h2 = hashes.find((c) => c.qname === "A:2")!.contentHash;
    const h3 = hashes.find((c) => c.qname === "A:3")!.contentHash;
    // Same text → same hash (vector store will dedup); different text → different hash (re-embeds).
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    // It is a real 64-hex sha256, NOT the old constant "rule:<qname>".
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain("rule:");
  });

  it("drops all-zero vectors (the embedder failure fallback) instead of indexing them", async () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 16, embed: embedZero });
    q.push({ qname: "A:1", text: "x", orgId: "o", label: "A" });
    q.push({ qname: "A:2", text: "y", orgId: "o", label: "A" });
    await q.drain();
    expect(sink.calls.length).toBe(0);
  });

  it("skips the embedding model for items whose stored hash matches (pre-embed dedup)", async () => {
    const { createHash } = await import("node:crypto");
    const hashOf = (t: string) => createHash("sha256").update(t).digest("hex");
    const sink = makeSink();
    // Pretend A:1's stored vector already matches its text hash → must be skipped.
    sink.getContentHash = (_o, qname) =>
      (String(qname) === "A:1" ? hashOf("unchanged") : null) as ReturnType<
        NonNullable<VectorSink["getContentHash"]>
      >;
    const embedded: string[] = [];
    const embed = async (texts: string[]) => {
      embedded.push(...texts);
      return texts.map(() => {
        const v = new Float32Array(384);
        v[0] = 1;
        return v;
      });
    };
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 16, embed });
    q.push({ qname: "A:1", text: "unchanged", orgId: "o", label: "A" });
    q.push({ qname: "A:2", text: "changed", orgId: "o", label: "A" });
    await q.drain();
    // A:1 never reached the model; only A:2 was embedded + upserted.
    expect(embedded).toEqual(["changed"]);
    expect(sink.calls.map((c) => (c as { qname: string }).qname)).toEqual(["A:2"]);
  });
});

describe("EmbeddingQueue batched writes", () => {
  it("writes each batch in one sink transaction when the sink has one", async () => {
    const sink = makeSink();
    let txns = 0;
    const tx: VectorSink = {
      ...sink,
      upsertNodeVector: sink.upsertNodeVector,
      transaction: <T>(fn: () => T): T => {
        txns += 1;
        return fn();
      },
    };
    const q = new EmbeddingQueue({ vectorStore: tx, batchSize: 8, embed: embedOnes });
    for (let i = 0; i < 16; i++) q.push({ qname: `A:${i}`, text: `t${i}`, orgId: "o", label: "A" });
    await q.drain();
    expect(sink.calls.length).toBe(16);
    expect(txns).toBe(2);
  });

  it("falls back to row-by-row writes when the transaction fails", async () => {
    const sink = makeSink();
    const errors: Error[] = [];
    const tx: VectorSink = {
      ...sink,
      upsertNodeVector: sink.upsertNodeVector,
      transaction: () => {
        throw new Error("SQLITE_BUSY");
      },
    };
    const q = new EmbeddingQueue({
      vectorStore: tx,
      batchSize: 4,
      embed: embedOnes,
      onError: (e) => errors.push(e),
    });
    for (let i = 0; i < 4; i++) q.push({ qname: `A:${i}`, text: `t${i}`, orgId: "o", label: "A" });
    await q.drain();
    expect(sink.calls.length).toBe(4);
    expect(errors).toEqual([]);
  });

  it("final review core M-5: rethrows when the failed batch also ended the outer transaction", async () => {
    const sink = makeSink();
    const errors: Error[] = [];
    let open = true;
    const tx: VectorSink = {
      ...sink,
      upsertNodeVector: sink.upsertNodeVector,
      get inTransaction() {
        return open;
      },
      transaction: () => {
        open = false; // the error rolled the outer transaction back
        throw new Error("SQLITE_FULL");
      },
    };
    const q = new EmbeddingQueue({
      vectorStore: tx,
      batchSize: 4,
      embed: embedOnes,
      onError: (e) => errors.push(e),
    });
    for (let i = 0; i < 4; i++) q.push({ qname: `A:${i}`, text: `t${i}`, orgId: "o", label: "A" });
    await q.drain();
    // No row was written outside the (gone) outer transaction.
    expect(sink.calls.length).toBe(0);
    expect(errors.map((e) => e.message)).toEqual(["SQLITE_FULL"]);
  });

  it("final review core M-5: an outer transaction that survives still falls back row by row", async () => {
    const sink = makeSink();
    const tx: VectorSink = {
      ...sink,
      upsertNodeVector: sink.upsertNodeVector,
      inTransaction: true,
      transaction: () => {
        throw new Error("SQLITE_CONSTRAINT");
      },
    };
    const q = new EmbeddingQueue({ vectorStore: tx, batchSize: 4, embed: embedOnes });
    for (let i = 0; i < 4; i++) q.push({ qname: `A:${i}`, text: `t${i}`, orgId: "o", label: "A" });
    await q.drain();
    expect(sink.calls.length).toBe(4);
  });
});
