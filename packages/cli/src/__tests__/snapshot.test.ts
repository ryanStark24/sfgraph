import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end snapshot CLI tests. We:
 * - Stub @salesforce/core so resolveOrg returns a fake orgId
 * - Stub getSfgraphPaths to point to a temp dir
 * - Call the snapshot subcommand wrappers directly
 * - Inspect the resulting SQLite store through a second `SqliteSnapshotStore`
 *   instance (or via the same command's read paths).
 */

let tmpDataDir: string;
const orgId = "00DTestSnap0001";

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "sfgraph-snap-"));
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

async function stubModules(): Promise<void> {
  vi.doMock("@ryanstark24/sfgraph-core", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
      "@ryanstark24/sfgraph-core",
    );
    return {
      ...actual,
      resolveOrg: async (alias: string) => ({
        orgId,
        alias,
        username: "u@example.com",
        instanceUrl: "https://x.test",
        apiVersion: "60.0",
        conn: {},
      }),
      resolveDefaultOrgAlias: async () => "fake",
    };
  });
  vi.doMock("@ryanstark24/sfgraph-shared", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-shared")>(
      "@ryanstark24/sfgraph-shared",
    );
    return {
      ...actual,
      getSfgraphPaths: () => ({
        data: tmpDataDir,
        cache: tmpDataDir,
        log: tmpDataDir,
        config: tmpDataDir,
        temp: tmpDataDir,
      }),
    };
  });
}

describe("sfgraph snapshot CLI", () => {
  it("list reports 'no snapshots' for a fresh org", async () => {
    await stubModules();
    const { snapshotListCmd } = await import("../commands/snapshot.js");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    await snapshotListCmd({ org: "fake" });
    spy.mockRestore();
    expect(logs.join("\n")).toMatch(/No snapshots/);
  });

  it("create + list shows the new snapshot in the table", async () => {
    await stubModules();
    const { snapshotCreateCmd, snapshotListCmd } = await import("../commands/snapshot.js");

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    await snapshotCreateCmd({ org: "fake", label: "before-deploy" });
    await snapshotListCmd({ org: "fake" });
    spy.mockRestore();

    const out = logs.join("\n");
    expect(out).toMatch(/Created snapshot snap_/);
    expect(out).toMatch(/manual:before-deploy/);
    expect(out).toMatch(/\| ID \| Label \| Created \| Auto \|/);
  });

  it("diff against 'current' produces a markdown summary", async () => {
    await stubModules();
    const { snapshotCreateCmd, snapshotDiffCmd } = await import("../commands/snapshot.js");

    let snapId = "";
    const captureCreate = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      const match = /(snap_[a-f0-9-]+)/.exec(String(m));
      if (match) snapId = match[1] ?? "";
    });
    await snapshotCreateCmd({ org: "fake", label: "baseline" });
    captureCreate.mockRestore();
    expect(snapId).toMatch(/^snap_/);

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    await snapshotDiffCmd({ org: "fake", fromId: snapId, toId: "current" });
    spy.mockRestore();
    const out = logs.join("\n");
    expect(out).toMatch(/Snapshot diff/);
    expect(out).toMatch(/Nodes/);
    expect(out).toMatch(/Edges/);
  });

  it("prune --retain-days 0 returns a count", async () => {
    await stubModules();
    const { snapshotCreateCmd, snapshotPruneCmd } = await import("../commands/snapshot.js");
    // Prune only touches auto-snapshots, and CLI creates manual ones → 0 is fine.
    await snapshotCreateCmd({ org: "fake", label: "x" });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    await snapshotPruneCmd({ org: "fake", retainDays: 0 });
    spy.mockRestore();
    expect(logs.join("\n")).toMatch(/Pruned \d+ auto-snapshot/);
  });

  it("delete removes a specific snapshot id", async () => {
    await stubModules();
    const { snapshotCreateCmd, snapshotDeleteCmd, snapshotListCmd } = await import(
      "../commands/snapshot.js"
    );
    let snapId = "";
    const captureCreate = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      const match = /(snap_[a-f0-9-]+)/.exec(String(m));
      if (match) snapId = match[1] ?? "";
    });
    await snapshotCreateCmd({ org: "fake", label: "del-me" });
    captureCreate.mockRestore();
    expect(snapId).toMatch(/^snap_/);

    await snapshotDeleteCmd({ org: "fake", snapshotId: snapId });

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    await snapshotListCmd({ org: "fake" });
    spy.mockRestore();
    // The label was unique to that snap; should be gone.
    expect(logs.join("\n")).not.toMatch(/del-me/);
  });
});
