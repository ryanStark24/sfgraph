import { describe, expect, it } from "vitest";
import { ParserWorkerPool } from "../worker-pool.js";
import { makeTestCtx } from "./_harness.js";

describe("ParserWorkerPool", () => {
  it("dispatches happy-path tasks via in-process runner", async () => {
    let calls = 0;
    const pool = new ParserWorkerPool({
      runner: async () => {
        calls++;
        return { nodes: [], edges: [] };
      },
    });
    const ctx = makeTestCtx();
    await pool.dispatch({ parserType: "ApexClass", input: { className: "X", body: "" }, ctx });
    await pool.dispatch({ parserType: "ApexClass", input: { className: "Y", body: "" }, ctx });
    expect(calls).toBe(2);
    await pool.destroy();
  });

  it("remains usable after a task throws (crash-restart semantics)", async () => {
    let attempts = 0;
    const pool = new ParserWorkerPool({
      runner: async () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        return { nodes: [], edges: [] };
      },
    });
    const ctx = makeTestCtx();
    await expect(pool.dispatch({ parserType: "X", input: {}, ctx })).rejects.toThrow(/boom/);
    const ok = await pool.dispatch({ parserType: "X", input: {}, ctx });
    expect(ok).toEqual({ nodes: [], edges: [] });
    await pool.destroy();
  });

  it("rejects when in-flight depth exceeds maxQueue", async () => {
    const pool = new ParserWorkerPool({
      maxQueue: 1,
      runner: () => new Promise(() => undefined), // never resolves
    });
    const ctx = makeTestCtx();
    // Fire first call (held forever)
    void pool.dispatch({ parserType: "X", input: {}, ctx });
    // Second call should reject synchronously due to depth check
    await expect(pool.dispatch({ parserType: "X", input: {}, ctx })).rejects.toThrow(
      /queue overflow/,
    );
    await pool.destroy();
  });
});
