import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedIngestedOrgDb } from "./_seed-org-db.js";

/**
 * Audit tools-09: an unknown org alias reaches core.resolveOrg ->
 * @salesforce/core AuthInfo.create, which on macOS can block forever on a
 * keychain GUI dialog. Correct behaviour: the alias resolution is bounded by
 * a timeout (or fails fast with a clear "unknown org alias" error).
 *
 * SAFETY: this test NEVER reaches the real sf CLI / AuthInfo / keychain.
 * `resolveOrg` is replaced by a promise that never settles, which is exactly
 * what the hung keychain call looks like from context.ts's point of view.
 */
let workDir: string;
let resolveOrgCalls = 0;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-audit-tools09-"));
  resolveOrgCalls = 0;
});

afterEach(() => {
  vi.useRealTimers();
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
  delete process.env.SFGRAPH_ALIAS_SF_FALLBACK;
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("audit tools-09: unknown alias must not hang on sf-CLI/keychain resolution", () => {
  it("rejects within a bounded time when resolveOrg never settles", async () => {
    vi.doMock("@ryanstark24/sfgraph-shared", async () => {
      const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-shared")>(
        "@ryanstark24/sfgraph-shared",
      );
      return {
        ...actual,
        getSfgraphPaths: () => ({
          data: workDir,
          cache: workDir,
          log: workDir,
          config: workDir,
          temp: workDir,
        }),
      };
    });
    vi.doMock("@ryanstark24/sfgraph-core", async () => {
      const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
        "@ryanstark24/sfgraph-core",
      );
      return {
        ...actual,
        // Stand-in for a keychain-blocked AuthInfo.create: never settles.
        resolveOrg: () => {
          resolveOrgCalls += 1;
          return new Promise(() => {});
        },
      };
    });
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let state: "pending" | "rejected" | "resolved" = "pending";
    let message = "";
    getToolContext({ orgId: "typo-alias" }).then(
      () => {
        state = "resolved";
      },
      (e: unknown) => {
        state = "rejected";
        message = String((e as Error)?.message ?? e);
      },
    );
    const turn = () => new Promise<void>((r) => setImmediate(r));
    for (let i = 0; i < 30; i++) await turn();
    // A generous 2 minutes of (fake) time: any sane resolution timeout fires.
    await vi.advanceTimersByTimeAsync(120_000);
    for (let i = 0; i < 30; i++) await turn();

    expect(resolveOrgCalls).toBeLessThanOrEqual(1);
    expect(state).toBe("rejected");
    expect(message).toMatch(/unknown org|timed out|timeout/i);
  }, 30_000); // module re-import of core under vi.resetModules takes seconds

  it("fails fast with 'unknown org alias' and lists registered aliases, never calling resolveOrg", async () => {
    await seedIngestedOrgDb(workDir, "00DXX0000001abcEAA", "acme-repo");
    vi.doMock("@ryanstark24/sfgraph-shared", async () => {
      const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-shared")>(
        "@ryanstark24/sfgraph-shared",
      );
      return {
        ...actual,
        getSfgraphPaths: () => ({
          data: workDir,
          cache: workDir,
          log: workDir,
          config: workDir,
          temp: workDir,
        }),
      };
    });
    vi.doMock("@ryanstark24/sfgraph-core", async () => {
      const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
        "@ryanstark24/sfgraph-core",
      );
      return {
        ...actual,
        resolveOrg: () => {
          resolveOrgCalls += 1;
          return new Promise(() => {});
        },
      };
    });
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);
    await expect(getToolContext({ orgId: "acme-rep0" })).rejects.toThrow(
      /unknown org alias 'acme-rep0'.*acme-repo \(00DXX0000001abcEAA\)/,
    );
    expect(resolveOrgCalls).toBe(0);
  }, 30_000);

  it("bounds the opt-in sf-CLI fallback with a timeout", async () => {
    process.env.SFGRAPH_ALIAS_SF_FALLBACK = "1";
    vi.doMock("@ryanstark24/sfgraph-shared", async () => {
      const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-shared")>(
        "@ryanstark24/sfgraph-shared",
      );
      return {
        ...actual,
        getSfgraphPaths: () => ({
          data: workDir,
          cache: workDir,
          log: workDir,
          config: workDir,
          temp: workDir,
        }),
      };
    });
    vi.doMock("@ryanstark24/sfgraph-core", async () => {
      const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
        "@ryanstark24/sfgraph-core",
      );
      return {
        ...actual,
        // Stand-in for a keychain-blocked AuthInfo.create: never settles.
        resolveOrg: () => {
          resolveOrgCalls += 1;
          return new Promise(() => {});
        },
      };
    });
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let state: "pending" | "rejected" | "resolved" = "pending";
    let message = "";
    getToolContext({ orgId: "typo-alias" }).then(
      () => {
        state = "resolved";
      },
      (e: unknown) => {
        state = "rejected";
        message = String((e as Error)?.message ?? e);
      },
    );
    const turn = () => new Promise<void>((r) => setImmediate(r));
    for (let i = 0; i < 30; i++) await turn();
    expect(resolveOrgCalls).toBe(1);
    expect(state).toBe("pending");
    await vi.advanceTimersByTimeAsync(10_000);
    for (let i = 0; i < 30; i++) await turn();
    expect(state).toBe("rejected");
    expect(message).toMatch(/timed out after 5000 ms/);
  }, 30_000);
});
