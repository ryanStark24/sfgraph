import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { embedTexts, getEmbedPipeline, meanPoolNormalize } from "../embed.js";
import { EmbeddingQueue, type VectorSink } from "../queue.js";

/**
 * Vectorised mean pooling must reproduce @xenova/transformers'
 * `pooling: "mean", normalize: true` path to within 1e-6 per component.
 *
 * The pure-function test needs only the library's Tensor helpers. The
 * end-to-end test needs the vendored MiniLM model too; like embed.test.ts it
 * passes trivially when the optional runtime/model is unavailable.
 */

type TensorLike = { data: Float32Array; dims: number[] };
type TransformersMod = {
  Tensor: new (
    type: string,
    data: unknown,
    dims: number[],
  ) => TensorLike & {
    normalize: (p: number, dim: number) => TensorLike;
  };
  mean_pooling: (
    h: unknown,
    m: unknown,
  ) => TensorLike & {
    normalize: (p: number, dim: number) => TensorLike;
  };
};

async function loadTransformers(): Promise<TransformersMod | null> {
  try {
    return (await import("@xenova/transformers")) as unknown as TransformersMod;
  } catch {
    return null;
  }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

describe("meanPoolNormalize", () => {
  it("matches transformers mean_pooling + normalize(2, -1) within 1e-6", async () => {
    const tf = await loadTransformers();
    if (!tf) return; // runtime unavailable — nothing to compare against
    const [batch, seq, dim] = [5, 11, 384];
    const rnd = lcg(42);
    const hidden = new Float32Array(batch * seq * dim);
    for (let i = 0; i < hidden.length; i++) hidden[i] = rnd() * 4;
    const lens = [11, 3, 7, 1, 9];
    const mask = new BigInt64Array(batch * seq);
    for (let b = 0; b < batch; b++)
      for (let j = 0; j < seq; j++) mask[b * seq + j] = j < (lens[b] as number) ? 1n : 0n;

    const ref = tf
      .mean_pooling(
        new tf.Tensor("float32", hidden, [batch, seq, dim]),
        new tf.Tensor("int64", mask, [batch, seq]),
      )
      .normalize(2, -1);
    const got = meanPoolNormalize(hidden, [batch, seq, dim], mask);
    expect(got).toHaveLength(batch);
    for (let b = 0; b < batch; b++) {
      const v = got[b] as Float32Array;
      expect(v.length).toBe(dim);
      for (let k = 0; k < dim; k++) {
        expect(Math.abs((v[k] as number) - (ref.data[b * dim + k] as number))).toBeLessThanOrEqual(
          1e-6,
        );
      }
    }
  });
});

describe("embedTexts (vectorised pooling) vs the old pipeline pooling path", () => {
  it("agrees within 1e-6 per component on a few texts", async () => {
    const pipe = await getEmbedPipeline();
    if (!pipe) return; // model/runtime unavailable — mirrors embed.test.ts
    const texts = [
      "ApexClass: ApexClass:AccountService\naccount service load save",
      "x",
      "CustomField: CustomField:Account.Tier__c\ntier text field on account",
      "Flow: Flow:Order_Router\n".repeat(30),
      "",
    ];
    const old = (await pipe(texts, { pooling: "mean", normalize: true })) as { data: Float32Array };
    const got = await embedTexts(texts);
    expect(got).toHaveLength(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const v = got[i] as Float32Array;
      expect(v.length).toBe(384);
      let maxDiff = 0;
      for (let k = 0; k < 384; k++) {
        maxDiff = Math.max(maxDiff, Math.abs((v[k] as number) - (old.data[i * 384 + k] as number)));
      }
      expect(maxDiff).toBeLessThanOrEqual(1e-6);
    }
  }, 60_000);
});

describe("embedTexts inference batching", () => {
  it("runs the model in sub-batches of 64 (70 texts → 2 model calls)", async () => {
    const pipe = await getEmbedPipeline();
    if (!pipe) return; // model/runtime unavailable — mirrors embed.test.ts
    const realModel = pipe.model;
    const sizes: number[] = [];
    pipe.model = async (inputs) => {
      sizes.push((inputs.attention_mask as { dims: number[] }).dims[0] as number);
      return realModel(inputs);
    };
    try {
      const out = await embedTexts(Array.from({ length: 70 }, (_, i) => `text number ${i}`));
      expect(out).toHaveLength(70);
    } finally {
      pipe.model = realModel;
    }
    expect(sizes).toEqual([64, 6]);
  }, 60_000);
});

describe("EmbeddingQueue batching", () => {
  it("defaults to batches of 64", async () => {
    const sizes: number[] = [];
    const sink: VectorSink = { upsertNodeVector: () => undefined };
    const q = new EmbeddingQueue({
      vectorStore: sink,
      embed: async (t) => {
        sizes.push(t.length);
        return t.map(() => Float32Array.from({ length: 384 }, () => 1));
      },
    });
    for (let i = 0; i < 130; i++)
      q.push({ qname: `A:${i}`, text: `t${i}`, orgId: "o", label: "A" });
    await q.drain();
    expect(sizes).toEqual([64, 64, 2]);
  });

  it("sorts each flush batch by text length and maps vectors back to the right qname", async () => {
    const seen: string[][] = [];
    const written = new Map<string, number>();
    const sink: VectorSink = {
      upsertNodeVector: (_o, qname, _l, v) => {
        written.set(String(qname), v[0] as number);
      },
    };
    const q = new EmbeddingQueue({
      vectorStore: sink,
      batchSize: 8,
      // Vector component 0 encodes the text length, so a mis-mapped vector shows up.
      embed: async (t) => {
        seen.push([...t]);
        return t.map((s) =>
          Float32Array.from({ length: 384 }, (_, k) => (k === 0 ? s.length + 1 : 1)),
        );
      },
    });
    const texts = ["ccc", "a", "eeeee", "bb", "dddd", "", "ffffff", "gg"];
    texts.forEach((t, i) => q.push({ qname: `A:${i}`, text: t, orgId: "o", label: "A" }));
    await q.drain();
    expect(seen).toHaveLength(1);
    const lens = (seen[0] as string[]).map((s) => s.length);
    expect(lens).toEqual([...lens].sort((x, y) => x - y));
    texts.forEach((t, i) => expect(written.get(`A:${i}`)).toBe(t.length + 1));
  });
  it("keeps last-writer-wins for a qname emitted twice in one flush (vector and hash from the last text)", async () => {
    const written: Array<{ qname: string; v0: number; hash: string }> = [];
    const sink: VectorSink = {
      upsertNodeVector: (_o, qname, _l, v, hash) => {
        written.push({ qname: String(qname), v0: v[0] as number, hash: String(hash) });
      },
    };
    const q = new EmbeddingQueue({
      vectorStore: sink,
      embed: async (t) =>
        t.map((s) => Float32Array.from({ length: 384 }, (_, k) => (k === 0 ? s.length + 1 : 1))),
    });
    // First emission is LONGER than the last, so a length sort would write it last.
    const first = "a much longer first body for the duplicated class";
    const last = "short";
    q.push({ qname: "ApexClass:Dup", text: first, orgId: "o", label: "ApexClass" });
    q.push({ qname: "ApexClass:Other", text: "mid length text", orgId: "o", label: "ApexClass" });
    q.push({ qname: "ApexClass:Dup", text: last, orgId: "o", label: "ApexClass" });
    await q.drain();
    const finalDup = written.filter((w) => w.qname === "ApexClass:Dup").at(-1);
    expect(finalDup?.v0).toBe(last.length + 1);
    expect(finalDup?.hash).toBe(createHash("sha256").update(last).digest("hex"));
  });
});
