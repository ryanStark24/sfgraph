import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cover the default factory's alias-classification + unknown-alias rejection
 * paths added in the P1 audit pass. Tests bypass the test-factory swap so we
 * exercise the real `defaultFactory` against a tempdir-backed `getSfgraphPaths`.
 */

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-default-factory-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

async function stubPaths(): Promise<void> {
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
}

async function stubCore(
  resolveImpl?: (alias: string) => Promise<{ orgId: string }>,
): Promise<void> {
  vi.doMock("@ryanstark24/sfgraph-core", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
      "@ryanstark24/sfgraph-core",
    );
    return {
      ...actual,
      resolveOrg:
        resolveImpl ??
        (async (alias: string) => {
          throw new Error(`unknown alias: ${alias}`);
        }),
    };
  });
}

describe("default factory: alias classification (P1 regex fix)", () => {
  it("rejects unknown alias rather than creating empty <alias>.sqlite", async () => {
    await stubPaths();
    await stubCore();
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    // Force null so default factory is picked up.
    setToolContextFactory(null);
    await expect(getToolContext({ orgId: "MyUnknownAlias" })).rejects.toThrow(
      /unknown org identifier/,
    );
  });

  it("treats a 15-char alias (not starting with 00D) as an alias, not an orgId", async () => {
    // The pre-P1 logic mistakenly classified any 15-char string as an orgId
    // by length alone. With the 00D-prefixed regex, this must be treated as
    // an alias and hit the alias-resolution path (which will fail here).
    await stubPaths();
    await stubCore();
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);
    // 15 chars, not starting with 00D — must NOT be classified as an orgId.
    await expect(getToolContext({ orgId: "MyOrgAliasIs15c" })).rejects.toThrow(
      /unknown org identifier/,
    );
  });

  it("accepts a real 18-char SF orgId (00D-prefixed) and opens a store", async () => {
    await stubPaths();
    await stubCore();
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    const ctx = await getToolContext({ orgId: "00DXX0000001abcEAA" });
    expect(String(ctx.orgId)).toBe("00DXX0000001abcEAA");
    await closeAllContexts();
  });

  it("falls back to sf-CLI resolution when alias isn't in any existing DB", async () => {
    await stubPaths();
    await stubCore(async (alias: string) => {
      if (alias === "newlyAuthed") return { orgId: "00DZZ0000009xyzEAA" };
      throw new Error("unknown");
    });
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    const ctx = await getToolContext({ orgId: "newlyAuthed" });
    expect(String(ctx.orgId)).toBe("00DZZ0000009xyzEAA");
    await closeAllContexts();
  });
});
