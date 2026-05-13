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

const embedZero = async (texts: string[]) => texts.map(() => new Float32Array(384));

describe("EmbeddingQueue", () => {
  it("does not auto-flush below batchSize", () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 4, embed: embedZero });
    q.push({ qname: "A:1", text: "a", orgId: "o", label: "A" });
    q.push({ qname: "A:2", text: "b", orgId: "o", label: "A" });
    expect(sink.calls.length).toBe(0);
    expect(q.pending).toBe(2);
  });

  it("auto-flushes once batchSize is reached and drain awaits in-flight", async () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 2, embed: embedZero });
    q.push({ qname: "A:1", text: "a", orgId: "o", label: "A" });
    q.push({ qname: "A:2", text: "b", orgId: "o", label: "A" });
    await q.drain();
    expect(sink.calls.length).toBe(2);
  });

  it("drain flushes all queued items, regardless of batchSize", async () => {
    const sink = makeSink();
    const q = new EmbeddingQueue({ vectorStore: sink, batchSize: 16, embed: embedZero });
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
