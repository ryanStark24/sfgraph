import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `--db <path>` lets a user override the SQLite path the ingester writes to.
 * Without containment, a script could overwrite arbitrary files or fill `/`.
 * We require the resolved path to land inside `getSfgraphPaths().data`
 * unless `SFGRAPH_ALLOW_ANY_DB=1` is set.
 */

let tmpDataDir: string;
let tmpDbDir: string;
let prevAllowAnyDb: string | undefined;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "sfg-dbguard-data-"));
  tmpDbDir = mkdtempSync(join(tmpdir(), "sfg-dbguard-elsewhere-"));
  prevAllowAnyDb = process.env.SFGRAPH_ALLOW_ANY_DB;
  // biome-ignore lint/performance/noDelete: cleanest reset of an env var override
  delete process.env.SFGRAPH_ALLOW_ANY_DB;
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
  rmSync(tmpDbDir, { recursive: true, force: true });
  if (prevAllowAnyDb === undefined) {
    // biome-ignore lint/performance/noDelete: cleanest reset of an env var override
    delete process.env.SFGRAPH_ALLOW_ANY_DB;
  } else {
    process.env.SFGRAPH_ALLOW_ANY_DB = prevAllowAnyDb;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadIngestWithStubs(): Promise<typeof import("../commands/ingest.js")> {
  vi.doMock("@ryanstark24/sfgraph-core", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
      "@ryanstark24/sfgraph-core",
    );
    return {
      ...actual,
      liveIngest: async () => ({
        orgId: "00DxxGuardTest001",
        capabilities: {},
        mode: "full" as const,
        membersProcessed: 0,
        parseErrors: 0,
        deletions: 0,
        durationMs: 0,
      }),
      resolveOrg: async (alias: string) => ({
        orgId: "00DxxGuardTest001",
        alias,
        username: "u@example.com",
        instanceUrl: "https://x.test",
        apiVersion: "60.0",
        conn: {},
      }),
    };
  });
  vi.doMock("@ryanstark24/sfgraph-shared", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-shared")>(
      "@ryanstark24/sfgraph-shared",
    );
    return {
      ...actual,
      getSfgraphPaths: () => ({ data: tmpDataDir, cache: tmpDataDir, config: tmpDataDir }),
    };
  });
  return await import("../commands/ingest.js");
}

describe("ingest --db containment", () => {
  it("rejects --db path outside the data dir", async () => {
    const { ingestCmd } = await loadIngestWithStubs();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const badDbPath = join(tmpDbDir, "anywhere.sqlite");
    await ingestCmd({ org: "myalias", db: badDbPath });
    expect(process.exitCode).toBe(1);
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("resolves outside the sfgraph data dir"))).toBe(true);
    process.exitCode = 0;
    errSpy.mockRestore();
  });

  it("rejects --db with parent-dir traversal", async () => {
    const { ingestCmd } = await loadIngestWithStubs();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const traversed = join(tmpDataDir, "..", "escape.sqlite");
    await ingestCmd({ org: "myalias", db: traversed });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    errSpy.mockRestore();
  });

  it("accepts --db inside the data dir", async () => {
    const { ingestCmd } = await loadIngestWithStubs();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const goodDbPath = join(tmpDataDir, "00DxxGuardTest001.sqlite");
    await ingestCmd({ org: "myalias", db: goodDbPath });
    // Either succeeds or fails inside liveIngest (we stubbed it to no-op),
    // but it should NOT bail with the containment error.
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("resolves outside the sfgraph data dir"))).toBe(false);
    errSpy.mockRestore();
  });

  it("permits cross-dir --db when SFGRAPH_ALLOW_ANY_DB=1 is set", async () => {
    process.env.SFGRAPH_ALLOW_ANY_DB = "1";
    const { ingestCmd } = await loadIngestWithStubs();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const elsewhere = join(tmpDbDir, "ok.sqlite");
    await ingestCmd({ org: "myalias", db: elsewhere });
    const calls = errSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes("resolves outside the sfgraph data dir"))).toBe(false);
    errSpy.mockRestore();
  });
});
