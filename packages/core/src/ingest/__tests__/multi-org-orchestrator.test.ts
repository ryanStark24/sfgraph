import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { LiveIngestOpts, LiveIngestResult } from "../live-ingest.js";
import { multiOrgIngest } from "../multi-org.js";

function fakeResult(alias: string, durationMs = 0): LiveIngestResult {
  return {
    orgId: asOrgId(`00D_${alias}`),
    capabilities: {} as unknown as LiveIngestResult["capabilities"],
    mode: "full",
    membersProcessed: 1,
    parseErrors: 0,
    deletions: 0,
    durationMs,
    crossFlavorEdges: 0,
    arityResolved: 0,
    flowMethodsResolved: 0,
    danglingEdges: 0,
    overlap: { matched: 0, diverged: 0, empty: 0, annotated: 0 },
    warnings: [],
  };
}

describe("multiOrgIngest", () => {
  it("runs aliases sequentially in order", async () => {
    const order: string[] = [];
    const summary = await multiOrgIngest({
      aliases: ["alpha", "beta"],
      buildOpts: (alias) => ({ alias }) as unknown as LiveIngestOpts,
      runOne: async (opts) => {
        order.push(opts.alias);
        // Simulate some work to make sequencing observable.
        await new Promise((r) => setTimeout(r, 10));
        return fakeResult(opts.alias);
      },
    });
    expect(order).toEqual(["alpha", "beta"]);
    expect(summary.parallel).toBe(false);
    expect(summary.entries.every((e) => e.status === "ok")).toBe(true);
  });

  it("runs aliases concurrently when parallel=true (start times overlap)", async () => {
    const starts: Record<string, number> = {};
    const summary = await multiOrgIngest({
      aliases: ["a", "b", "c"],
      parallel: true,
      buildOpts: (alias) => ({ alias }) as unknown as LiveIngestOpts,
      runOne: async (opts) => {
        starts[opts.alias] = Date.now();
        await new Promise((r) => setTimeout(r, 40));
        return fakeResult(opts.alias);
      },
    });
    const ts = Object.values(starts).sort((x, y) => x - y);
    // All three should have started well within one "task" of each other.
    expect((ts[2] ?? 0) - (ts[0] ?? 0)).toBeLessThan(30);
    expect(summary.parallel).toBe(true);
    expect(summary.entries).toHaveLength(3);
  });

  it("isolates failures: one alias throws, others still complete", async () => {
    const summary = await multiOrgIngest({
      aliases: ["good1", "bad", "good2"],
      parallel: true,
      buildOpts: (alias) => ({ alias }) as unknown as LiveIngestOpts,
      runOne: async (opts) => {
        if (opts.alias === "bad") throw new Error("boom");
        return fakeResult(opts.alias);
      },
    });
    const byAlias = new Map(summary.entries.map((e) => [e.alias, e]));
    expect(byAlias.get("good1")?.status).toBe("ok");
    expect(byAlias.get("good2")?.status).toBe("ok");
    expect(byAlias.get("bad")?.status).toBe("error");
    expect(byAlias.get("bad")?.error).toContain("boom");
  });

  it("isolates failures in sequential mode too", async () => {
    const summary = await multiOrgIngest({
      aliases: ["good1", "bad", "good2"],
      buildOpts: (alias) => ({ alias }) as unknown as LiveIngestOpts,
      runOne: async (opts) => {
        if (opts.alias === "bad") throw new Error("nope");
        return fakeResult(opts.alias);
      },
    });
    expect(summary.entries.map((e) => e.status)).toEqual(["ok", "error", "ok"]);
  });

  it("captures elapsed time per entry", async () => {
    const summary = await multiOrgIngest({
      aliases: ["x"],
      buildOpts: (alias) => ({ alias }) as unknown as LiveIngestOpts,
      runOne: async (opts) => {
        await new Promise((r) => setTimeout(r, 5));
        return fakeResult(opts.alias);
      },
    });
    const e = summary.entries[0];
    expect(e).toBeDefined();
    expect((e?.finishedAt ?? 0) - (e?.startedAt ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it("returns empty entries list when no aliases are given", async () => {
    const summary = await multiOrgIngest({
      aliases: [],
      buildOpts: () => ({}) as unknown as LiveIngestOpts,
      runOne: async () => fakeResult("never"),
    });
    expect(summary.entries).toEqual([]);
  });
});
