import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedIngestedOrgDb } from "./_seed-org-db.js";

/**
 * Audit tools-23: alias lookup against the local `_sfgraph_orgs` registry was
 * case-sensitive, so 'ACME-REPO' missed an org ingested as 'acme-repo' and fell
 * through to the sf-CLI/keychain path. Correct: case-insensitive match.
 */
const ORG_ID = "00DXX0000001abcEAA";
let workDir: string;
let resolveOrgCalls = 0;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-audit-tools23-"));
  resolveOrgCalls = 0;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("audit tools-23: alias lookup is case-insensitive", () => {
  it("resolves a wrong-case alias to the ingested org without touching the sf CLI", async () => {
    await seedIngestedOrgDb(workDir, ORG_ID, "acme-repo");
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
    const { getToolContext, closeAllContexts, setToolContextFactory, _contextCacheSize } =
      await import("../context.js");
    setToolContextFactory(null);
    const upper = await getToolContext({ orgId: "ACME-REPO" });
    expect(String(upper.orgId)).toBe(ORG_ID);
    // Every spelling shares the one open store (rel-04).
    const exact = await getToolContext({ orgId: "acme-repo" });
    expect(exact).toBe(upper);
    expect(_contextCacheSize()).toBe(1);
    expect(resolveOrgCalls).toBe(0);
    await closeAllContexts();
  }, 30_000);
});
