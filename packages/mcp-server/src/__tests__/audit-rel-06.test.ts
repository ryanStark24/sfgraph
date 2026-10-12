import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit rel-06: a zero-byte <orgId>.sqlite passes the existsSync guard and is
 * silently migrated into an empty graph (and written to by the read-only
 * server), so every tool returns a confident-empty answer. Correct behaviour:
 * reject it as not ingested / corrupt and leave the file untouched.
 */
const ORG_ID = "00DXX0000001abcEAA";
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-audit-rel06-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("audit rel-06: zero-byte DB file", () => {
  it("is rejected and not migrated in place", async () => {
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
    const dbPath = path.join(workDir, `${ORG_ID}.sqlite`);
    writeFileSync(dbPath, "");
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    let outcome: "opened" | "rejected" = "opened";
    try {
      await getToolContext({ orgId: ORG_ID });
    } catch {
      outcome = "rejected";
    }
    await closeAllContexts();
    expect(outcome).toBe("rejected");
    expect(statSync(dbPath).size).toBe(0);
  }, 30_000); // module re-import of core under vi.resetModules takes seconds
});
