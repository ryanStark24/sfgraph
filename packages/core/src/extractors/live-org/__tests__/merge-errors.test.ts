import { describe, expect, it } from "vitest";
import { mergeAsyncIterablesParallel } from "../bulk-retrieve.js";

/** Review M7: a rejected sub-stream used to be mapped to `done`, silently
 *  truncating it — the same swallowed-error shape as the original ApexClass
 *  bug. The merge must keep draining the healthy streams, then reject. */

async function* yieldsThenThrows(n: number, err: Error): AsyncIterable<string> {
  for (let i = 0; i < n; i += 1) yield `bad${i}`;
  throw err;
}

async function* healthy(n: number, prefix: string): AsyncIterable<string> {
  for (let i = 0; i < n; i += 1) {
    await new Promise((r) => setTimeout(r, 2));
    yield `${prefix}${i}`;
  }
}

async function collect(it: AsyncIterable<string>) {
  const out: string[] = [];
  let error: unknown;
  try {
    for await (const v of it) out.push(v);
  } catch (e) {
    error = e;
  }
  return { out, error };
}

describe("mergeAsyncIterablesParallel propagates sub-stream errors", () => {
  it("drains the other streams, then rethrows the failure", async () => {
    const boom = new Error("drain truncated after 1 rows");
    const { out, error } = await collect(
      mergeAsyncIterablesParallel([yieldsThenThrows(1, boom), healthy(3, "ok")], {
        concurrency: 2,
      }),
    );
    expect(out.sort()).toEqual(["bad0", "ok0", "ok1", "ok2"]);
    expect(error).toBe(boom);
  });

  it("starts queued streams after a failure and reports every failure", async () => {
    const a = new Error("A failed");
    const b = new Error("B failed");
    const { out, error } = await collect(
      mergeAsyncIterablesParallel(
        [yieldsThenThrows(0, a), yieldsThenThrows(0, b), healthy(2, "q")],
        { concurrency: 1 },
      ),
    );
    expect(out).toEqual(["q0", "q1"]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([a, b]);
  });

  it("completes normally when no stream fails", async () => {
    const { out, error } = await collect(
      mergeAsyncIterablesParallel([healthy(2, "x"), healthy(2, "y")], { concurrency: 2 }),
    );
    expect(out.sort()).toEqual(["x0", "x1", "y0", "y1"]);
    expect(error).toBeUndefined();
  });
});
