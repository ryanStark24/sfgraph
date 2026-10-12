import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedIngestedOrgDb } from "./_seed-org-db.js";

/** Create a minimal real ingested graph at the path getToolContext expects for
 *  an orgId. (A 0-byte file is no longer accepted — audit rel-06 — so these
 *  tests seed an `_sfgraph_orgs` row.) They exercise orgId-classification /
 *  alias-resolution, not real graph data. */
async function seedOrgDb(dir: string, orgId: string, alias = "seeded-alias"): Promise<void> {
  await seedIngestedOrgDb(dir, orgId, alias);
}

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
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
  delete process.env.SFGRAPH_ALIAS_SF_FALLBACK;
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
    await expect(getToolContext({ orgId: "MyUnknownAlias" })).rejects.toThrow(/unknown org alias/);
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
    await expect(getToolContext({ orgId: "MyOrgAliasIs15c" })).rejects.toThrow(/unknown org alias/);
  });

  it("accepts a real 18-char SF orgId (00D-prefixed) and opens a store", async () => {
    await stubPaths();
    await stubCore();
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    await seedOrgDb(workDir, "00DXX0000001abcEAA"); // org is "ingested" → guard passes
    const ctx = await getToolContext({ orgId: "00DXX0000001abcEAA" });
    expect(String(ctx.orgId)).toBe("00DXX0000001abcEAA");
    await closeAllContexts();
  });

  it("falls back to sf-CLI resolution (opt-in) when alias isn't in any existing DB", async () => {
    // Since audit tools-09 the sf-CLI fallback (which can block on the
    // keychain) is opt-in and bounded by a timeout.
    process.env.SFGRAPH_ALIAS_SF_FALLBACK = "1";
    await stubPaths();
    await stubCore(async (alias: string) => {
      if (alias === "newlyAuthed") return { orgId: "00DZZ0000009xyzEAA" };
      throw new Error("unknown");
    });
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    await seedOrgDb(workDir, "00DZZ0000009xyzEAA"); // resolved org is "ingested" → guard passes
    const ctx = await getToolContext({ orgId: "newlyAuthed" });
    expect(String(ctx.orgId)).toBe("00DZZ0000009xyzEAA");
    await closeAllContexts();
  });

  it("rejects a valid-but-never-ingested orgId instead of creating an empty DB (audit guard)", async () => {
    await stubPaths();
    await stubCore();
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);
    // Valid 18-char orgId, but no <orgId>.sqlite seeded → must reject, not
    // silently create an empty DB that makes every tool return confident-empty.
    await expect(getToolContext({ orgId: "00DXX0000001abcEAA" })).rejects.toThrow(
      /has not been ingested/,
    );
  });

  it("resolves an alias from the sf org snapshot without the sf CLI", async () => {
    await stubPaths();
    let calls = 0;
    await stubCore(async () => {
      calls += 1;
      throw new Error("must not be called");
    });
    const { getToolContext, closeAllContexts, setToolContextFactory } = await import(
      "../context.js"
    );
    setToolContextFactory(null);
    await seedOrgDb(workDir, "00DZZ0000009xyzEAA", "ingested-as-username@example.com");
    writeFileSync(
      path.join(workDir, "orgs-snapshot.json"),
      JSON.stringify({
        aliases: { myAlias: "u@example.com" },
        authorizations: { "u@example.com": { orgId: "00DZZ0000009xyzEAA", instanceUrl: "x" } },
      }),
    );
    const ctx = await getToolContext({ orgId: "MYALIAS" });
    expect(String(ctx.orgId)).toBe("00DZZ0000009xyzEAA");
    expect(calls).toBe(0);
    await closeAllContexts();
  });

  it("rejects a DB file that has no _sfgraph_orgs row (not an ingested graph)", async () => {
    await stubPaths();
    await stubCore();
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);
    writeFileSync(path.join(workDir, "00DXX0000001abcEAA.sqlite"), "not a database");
    await expect(getToolContext({ orgId: "00DXX0000001abcEAA" })).rejects.toThrow(
      /no usable graph/,
    );
  });
});
