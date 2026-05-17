import { beforeEach, describe, expect, it } from "vitest";
import {
  METADATA_READ_BATCH_SIZE,
  limiter,
  readMetadataBatchAdaptive,
} from "../rate-limit.js";

interface Item {
  fullName: string;
}

function items(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ fullName: `Item${i}` }));
}

function recordingConn() {
  const calls: string[][] = [];
  return {
    calls,
    conn: {
      metadata: {
        read: async (_type: string, names: string[]): Promise<unknown[]> => {
          calls.push([...names]);
          return names.map((n) => ({ fullName: n, payload: n }));
        },
      },
    },
  };
}

describe("W2-06: readMetadataBatchAdaptive pre-chunks to the Metadata API per-call limit", () => {
  beforeEach(async () => {
    await limiter.incrementReservoir(10_000);
  });

  it("sends a single call when items.length ≤ METADATA_READ_BATCH_SIZE", async () => {
    const { conn, calls } = recordingConn();
    const out = await readMetadataBatchAdaptive(conn, "Flow", items(METADATA_READ_BATCH_SIZE));
    expect(calls.length).toBe(1);
    expect(calls[0]?.length).toBe(METADATA_READ_BATCH_SIZE);
    expect(out.length).toBe(METADATA_READ_BATCH_SIZE);
  });

  it("splits oversized inputs into ceil(n/limit) parallel sub-calls", async () => {
    const { conn, calls } = recordingConn();
    // 25 items @ limit 10 → 3 sub-calls (10, 10, 5)
    const out = await readMetadataBatchAdaptive(conn, "Flow", items(25));
    expect(out.length).toBe(25);
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.length).sort((a, b) => a - b)).toEqual([5, 10, 10]);
    // Result order must match input order across all chunks.
    expect(out.map((r) => (r as { fullName: string }).fullName)).toEqual(
      Array.from({ length: 25 }, (_, i) => `Item${i}`),
    );
  });

  it("METADATA_READ_BATCH_SIZE is 10 by default (the Salesforce documented per-call cap)", () => {
    // Guard against accidental bumps to 25 — that value belongs to the
    // Composite REST API, not the SOAP Metadata API path this helper uses.
    expect(METADATA_READ_BATCH_SIZE).toBeLessThanOrEqual(10);
    expect(METADATA_READ_BATCH_SIZE).toBeGreaterThanOrEqual(1);
  });

  it("on per-chunk failure, only the failing chunk bisects (healthy peers unaffected)", async () => {
    const calls: { names: string[]; ok: boolean }[] = [];
    const conn = {
      metadata: {
        read: async (_type: string, names: string[]): Promise<unknown[]> => {
          // Fail the SECOND chunk (Item10..Item19), succeed on others.
          // The bisection will halve, eventually succeeding on smaller slices.
          const failsChunk = names.length > 1 && names[0] === "Item10";
          calls.push({ names: [...names], ok: !failsChunk });
          if (failsChunk) {
            throw new Error("simulated transient failure");
          }
          return names.map((n) => ({ fullName: n }));
        },
      },
    };
    const out = await readMetadataBatchAdaptive(conn, "Flow", items(25));
    expect(out.length).toBe(25);
    // Verify chunks 1 (Item0..Item9) and 3 (Item20..Item24) were single-call,
    // while chunk 2 (Item10..Item19) bisected at least once.
    const chunk1Calls = calls.filter((c) => c.names[0] === "Item0");
    const chunk3Calls = calls.filter((c) => c.names[0] === "Item20");
    const chunk2Calls = calls.filter((c) => c.names[0]?.startsWith("Item1") && c.names[0] !== "Item20");
    expect(chunk1Calls.length).toBe(1);
    expect(chunk3Calls.length).toBe(1);
    expect(chunk2Calls.length).toBeGreaterThan(1);
  });
});
