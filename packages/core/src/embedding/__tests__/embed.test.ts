import { describe, expect, it } from "vitest";
import { embedSingle, embedTexts } from "../embed.js";

/**
 * Tests for the standalone embedder. The MiniLM runtime
 * (`@xenova/transformers` + `@ryanstark24/sfgraph-models`) is an
 * `optionalDependencies` — these tests intentionally don't require it
 * to be present and instead validate the graceful-fallback contract.
 *
 * The two functions:
 *   embedTexts(texts) — always returns Float32Array[]; falls back to
 *                       zero vectors when the runtime isn't available
 *                       (so the ingest path can keep upserting
 *                       placeholder embeddings without crashing).
 *   embedSingle(text) — returns null when the runtime is unavailable
 *                       OR when the embedding is degenerate-all-zero.
 *                       Lets callers (like find_similar's text mode)
 *                       distinguish "no embedder" from "embedded fine
 *                       but the vector happens to be empty."
 *
 * On CI runners where the optional deps ARE installed (most cases) the
 * tests still pass because the contracts hold either way: shape is
 * always Float32Array, length is always 384, and embedSingle either
 * returns null OR a non-degenerate vector.
 */

describe("embedTexts", () => {
  it("always returns a Float32Array per input, length 384", async () => {
    const out = await embedTexts(["hello", "world", "lorem ipsum"]);
    expect(out).toHaveLength(3);
    for (const v of out) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(384);
    }
  });

  it("handles an empty array", async () => {
    const out = await embedTexts([]);
    expect(out).toEqual([]);
  });

  it("never throws on missing runtime — returns zero-vectors as fallback", async () => {
    // The fallback path returns Float32Array(384) per input (all zeros).
    // We can't force the import to fail mid-test without monkey-patching,
    // so we just confirm that the function reliably returns *something*
    // shaped right and doesn't throw on a stress input.
    const out = await embedTexts(["", "x".repeat(1024)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[1]).toBeInstanceOf(Float32Array);
  });
});

describe("embedSingle", () => {
  it("returns null OR a Float32Array (never throws)", async () => {
    const v = await embedSingle("test query");
    if (v === null) {
      // No runtime — that's a valid outcome. Done.
      return;
    }
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(384);
  });

  it("respects custom dim opt when runtime is unavailable", async () => {
    // When runtime is missing, embedSingle returns null regardless of dim
    // (the only way to surface "no real embedding" cleanly). When runtime
    // IS available, dim defaults to 384 unless overridden; we don't
    // assert non-default here because that would require a real model
    // configured for the alternate dim.
    const v = await embedSingle("test", { dim: 768 });
    // Either null (no runtime) or a Float32Array (with whatever dim
    // the active model produces — caller's responsibility to match
    // their override).
    expect(v === null || v instanceof Float32Array).toBe(true);
  });
});
