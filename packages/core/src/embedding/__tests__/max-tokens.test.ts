import { describe, expect, it } from "vitest";
import { EMBED_MAX_TOKENS, embedTexts, getEmbedPipeline } from "../embed.js";

/**
 * Model input is capped at MiniLM's 256-token window (the tokenizer config
 * says 512, but all-MiniLM-L6-v2 was trained at 256 and 512-token batches of
 * 64 are the largest ONNX activations in an ingest). Passes trivially when the
 * optional runtime/model is unavailable, like the other embed tests.
 */
describe("embedTexts max input length", () => {
  it("is 256 tokens", () => {
    expect(EMBED_MAX_TOKENS).toBe(256);
  });

  it("ignores everything after the 256th token", async () => {
    const pipe = await getEmbedPipeline();
    if (!pipe) return;
    // A prefix past 256 tokens but well inside the old 512 window.
    const head = Array.from({ length: 330 }, () => "the").join(" ");
    const ids = pipe.tokenizer([head], { padding: true, truncation: false }) as unknown as {
      input_ids: { dims: number[] };
    };
    expect(ids.input_ids.dims[1]).toBeGreaterThan(300);
    expect(ids.input_ids.dims[1]).toBeLessThan(400);
    const [a, b] = await embedTexts([`${head} apples oranges`, `${head} invoices refunds`]);
    expect(Buffer.from((a as Float32Array).buffer)).toEqual(
      Buffer.from((b as Float32Array).buffer),
    );
  });
});
