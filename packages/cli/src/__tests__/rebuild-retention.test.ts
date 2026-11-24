import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rebuild backups: keep 1, prune only after the rebuilt graph's sync completed, never let a
 * backup of a half-built graph displace a complete one, sweep other orgs, skip a locked org.
 */

const ORG = "00Dxx0000001abc";
const OTHER = "00Dxx0000002abc";
const LOCKED = "00Dxx0000003abc";

let dataDir: string;
let liveIngestBehaviour: "ok" | "fail";
let savedKept: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sfgraph-rebuild-ret-"));
  liveIngestBehaviour = "ok";
  savedKept = process.env.SFGRAPH_REBUILD_BACKUPS_KEPT;
  // biome-ignore lint/performance/noDelete: reset env
  delete process.env.SFGRAPH_REBUILD_BACKUPS_KEPT;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (savedKept === undefined) {
    // biome-ignore lint/performance/noDelete: an env var cannot be set to undefined
    delete process.env.SFGRAPH_REBUILD_BACKUPS_KEPT;
  } else {
    process.env.SFGRAPH_REBUILD_BACKUPS_KEPT = savedKept;
  }
  process.exitCode = 0;
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
      liveIngest: async () => {
        if (liveIngestBehaviour === "fail") throw new Error("simulated sync failure");
        return {
          orgId: ORG,
          capabilities: {},
          mode: "full" as const,
          membersProcessed: 0,
          parseErrors: 0,
          deletions: 0,
          durationMs: 0,
        };
      },
      resolveOrg: async (alias: string) => ({
        orgId: ORG,
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
      getSfgraphPaths: () => ({
        data: dataDir,
        cache: dataDir,
        log: dataDir,
        config: dataDir,
        temp: dataDir,
      }),
    };
  });
}

/** A real graph file at <dataDir>/<org>.sqlite holding `snapshots` snapshots. */
async function makeGraph(file: string, org: string, snapshots: number): Promise<void> {
  const { SqliteGraphStore, SqliteSnapshotStore } = await import("@ryanstark24/sfgraph-core");
  const { asOrgId } = await import("@ryanstark24/sfgraph-shared");
  const g = new SqliteGraphStore({ dbPath: file });
  await g.init();
  const s = new SqliteSnapshotStore({ dbPath: file, db: g.db, skipMigrations: true });
  await s.init();
  for (let i = 0; i < snapshots; i++) s.createSnapshot(asOrgId(org), `old-${i}`, false);
  await g.close();
}

const backupsDir = (): string => join(dataDir, "backups");
const backupNames = (org = ORG): string[] =>
  existsSync(backupsDir())
    ? readdirSync(backupsDir())
        .filter((f) => f.startsWith(`${org}.rebuild-20`) && f.endsWith(".sqlite"))
        .sort()
    : [];
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

async function rebuild(): Promise<void> {
  const { ingestCmd } = await import("../commands/ingest.js");
  await ingestCmd({ org: "fake", rebuild: true });
  await tick();
}

function stubBackups(org: string, n: number, day = 1): string[] {
  mkdirSync(backupsDir(), { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = `${org}.rebuild-2026-01-${String(day + i).padStart(2, "0")}T00-00-00-000Z.sqlite`;
    writeFileSync(join(backupsDir(), name), "stub-graph");
    names.push(name);
  }
  return names;
}

describe("rebuild keeps one backup and prunes only after a finished sync", () => {
  it("a failed rebuild and its retry never delete the last good backup", async () => {
    await stubModules();
    await makeGraph(join(dataDir, `${ORG}.sqlite`), ORG, 1);
    const { snapshotCountInFile } = await import("@ryanstark24/sfgraph-core");

    liveIngestBehaviour = "fail";
    await rebuild(); // moves the good graph to B0, sync fails
    const afterFirst = backupNames();
    expect(afterFirst).toHaveLength(1);
    const good = afterFirst[0] as string;
    expect(existsSync(join(dataDir, `${ORG}.rebuild-pending.json`))).toBe(true);

    await rebuild(); // retry fails too: B1 is a half-built graph, marked incomplete
    const afterSecond = backupNames();
    expect(afterSecond).toHaveLength(2);
    const half = afterSecond.find((n) => n !== good) as string;
    expect(existsSync(join(backupsDir(), `${half}.incomplete`))).toBe(true);
    expect(existsSync(join(backupsDir(), `${good}.incomplete`))).toBe(false);

    liveIngestBehaviour = "ok";
    await rebuild(); // retry succeeds: only now are backups pruned
    // the complete backup is the one kept; the half-built copies are gone
    expect(backupNames()).toEqual([good]);
    expect(existsSync(join(backupsDir(), `${half}.incomplete`))).toBe(false);
    expect(existsSync(join(dataDir, `${ORG}.rebuild-pending.json`))).toBe(false);
    // history was carried into the new graph
    expect(snapshotCountInFile(join(dataDir, `${ORG}.sqlite`))).toBe(1);
  });

  it("nothing is pruned while the sync is failing, however many rebuilds are retried", async () => {
    await stubModules();
    stubBackups(ORG, 3);
    await makeGraph(join(dataDir, `${ORG}.sqlite`), ORG, 0);
    liveIngestBehaviour = "fail";
    await rebuild();
    expect(backupNames()).toHaveLength(4);
  });

  it("with the default of 1 an older complete backup goes after a good rebuild", async () => {
    await stubModules();
    const old = stubBackups(ORG, 2);
    await makeGraph(join(dataDir, `${ORG}.sqlite`), ORG, 0);
    await rebuild();
    const left = backupNames();
    expect(left).toHaveLength(1);
    expect(old).not.toContain(left[0]); // the new backup is the newest, so it is the one kept
  });

  it("SFGRAPH_REBUILD_BACKUPS_KEPT=0 still carries the snapshot history, then keeps no backup", async () => {
    await stubModules();
    process.env.SFGRAPH_REBUILD_BACKUPS_KEPT = "0";
    await makeGraph(join(dataDir, `${ORG}.sqlite`), ORG, 2);
    const { snapshotCountInFile } = await import("@ryanstark24/sfgraph-core");
    await rebuild();
    expect(backupNames()).toEqual([]);
    expect(snapshotCountInFile(join(dataDir, `${ORG}.sqlite`))).toBe(2);
  });

  it("a failed carry keeps the backup that holds the history, even with keep 0", async () => {
    await stubModules();
    process.env.SFGRAPH_REBUILD_BACKUPS_KEPT = "0";
    const core = await import("@ryanstark24/sfgraph-core");
    vi.spyOn(core.SqliteSnapshotStore.prototype, "copySnapshotsFrom").mockImplementation(() => {
      throw new Error("simulated carry failure");
    });
    await makeGraph(join(dataDir, `${ORG}.sqlite`), ORG, 2);
    await rebuild();
    const left = backupNames();
    expect(left).toHaveLength(1);
    expect(core.snapshotCountInFile(join(backupsDir(), left[0] as string))).toBe(2);
    expect(core.snapshotCountInFile(join(dataDir, `${ORG}.sqlite`))).toBe(0);
  });

  it("a finished rebuild also trims other orgs' backups, but not a locked org or foreign files", async () => {
    await stubModules();
    const other = stubBackups(OTHER, 4);
    const locked = stubBackups(LOCKED, 3);
    writeFileSync(join(backupsDir(), "notes.txt"), "keep me");
    writeFileSync(join(backupsDir(), `${OTHER}.rebuild-bogus.sqlite`), "not a stamp");
    const core = await import("@ryanstark24/sfgraph-core");
    const lock = core.acquireIngestLock({ dir: dataDir, orgId: LOCKED });
    try {
      await makeGraph(join(dataDir, `${ORG}.sqlite`), ORG, 0);
      await rebuild();
    } finally {
      lock.release();
    }
    expect(backupNames(OTHER)).toEqual([other[other.length - 1]]);
    expect(backupNames(LOCKED)).toEqual(locked);
    expect(existsSync(join(backupsDir(), "notes.txt"))).toBe(true);
    expect(existsSync(join(backupsDir(), `${OTHER}.rebuild-bogus.sqlite`))).toBe(true);
  });
});

describe("a plain successful ingest clears the pending-rebuild marker", () => {
  const marker = (): string => join(dataDir, `${ORG}.rebuild-pending.json`);

  it("a failed rebuild, then a plain full ingest: the next rebuild's backup is complete", async () => {
    await stubModules();
    await makeGraph(join(dataDir, `${ORG}.sqlite`), ORG, 0);
    liveIngestBehaviour = "fail";
    await rebuild();
    expect(existsSync(marker())).toBe(true);

    liveIngestBehaviour = "ok";
    const { ingestCmd } = await import("../commands/ingest.js");
    await ingestCmd({ org: "fake", mode: "full" });
    expect(existsSync(marker())).toBe(false);

    await rebuild(); // moves a complete graph: its backup must not be marked incomplete
    const names = backupNames();
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(existsSync(join(backupsDir(), `${n}.incomplete`))).toBe(false);
  });

  it("a targeted or failing ingest leaves the marker", async () => {
    await stubModules();
    await makeGraph(join(dataDir, `${ORG}.sqlite`), ORG, 0);
    liveIngestBehaviour = "fail";
    await rebuild();
    const { ingestCmd } = await import("../commands/ingest.js");
    await ingestCmd({ org: "fake", mode: "full" }); // fails: still incomplete
    expect(existsSync(marker())).toBe(true);
    liveIngestBehaviour = "ok";
    await ingestCmd({ org: "fake", only: "apex" }); // not the whole graph
    expect(existsSync(marker())).toBe(true);
  });
});

describe("backup keep rules", () => {
  it("planBackupKeep: incomplete backups never count; history is protected when asked", async () => {
    const { planBackupKeep } = await import("../commands/rebuild-backups.js");
    const mk = (n: number, incomplete = false) => ({
      name: `${ORG}.rebuild-2026-01-0${n}T00-00-00-000Z.sqlite`,
      orgId: ORG,
      stamp: `2026-01-0${n}`,
      path: `/x/${n}`,
      bytes: 1,
      at: null,
      incomplete,
    });
    const sets = [mk(1), mk(2), mk(3, true), mk(4, true)];
    const plan = planBackupKeep(sets, 1, false, () => 0);
    expect(plan.keep.map((s) => s.path)).toEqual(["/x/2"]);
    expect(plan.drop.map((s) => s.path)).toEqual(["/x/4", "/x/3", "/x/1"]);
    // only unusable copies: keep the newest so something is left
    expect(
      planBackupKeep([mk(3, true), mk(4, true)], 1, false, () => 0).keep.map((s) => s.path),
    ).toEqual(["/x/4"]);
    // history holder is older than the kept one
    const hist = planBackupKeep([mk(1), mk(2)], 1, true, (s) => (s.path === "/x/1" ? 3 : 0));
    expect(hist.keep.map((s) => s.path).sort()).toEqual(["/x/1", "/x/2"]);
    // unreadable (-1) counts as holding history
    const unreadable = planBackupKeep([mk(1), mk(2)], 0, true, (s) => (s.path === "/x/2" ? -1 : 0));
    expect(unreadable.keep.map((s) => s.path)).toEqual(["/x/2"]);
    // keep 0 without protection removes everything
    expect(planBackupKeep([mk(1), mk(2)], 0, false, () => 3).keep).toEqual([]);
  });

  it("sweepBackups skips a locked org, reports foreign files and never touches them", async () => {
    const { sweepBackups } = await import("../commands/rebuild-backups.js");
    const { acquireIngestLock } = await import("@ryanstark24/sfgraph-core");
    const a = stubBackups(ORG, 3);
    stubBackups(LOCKED, 3);
    writeFileSync(join(backupsDir(), `${a[0]}-wal`), "wal");
    writeFileSync(join(backupsDir(), "readme.txt"), "x");
    mkdirSync(join(backupsDir(), "subdir"));
    const lock = acquireIngestLock({ dir: dataDir, orgId: LOCKED });
    try {
      const r = sweepBackups(dataDir, { keep: 1 });
      expect(r.busyOrgs).toEqual([LOCKED]);
      expect(r.removed.map((b) => b.name)).toEqual([a[1], a[0]].sort().reverse());
      expect(r.other.map((f) => f.name).sort()).toEqual(["readme.txt", "subdir"]);
    } finally {
      lock.release();
    }
    expect(backupNames()).toEqual([a[2]]);
    expect(existsSync(join(backupsDir(), `${a[0]}-wal`))).toBe(false); // sidecar left with its backup
    expect(backupNames(LOCKED)).toHaveLength(3);
    expect(existsSync(join(backupsDir(), "readme.txt"))).toBe(true);
    // the sweep took and released the lock of the org it worked on
    expect(existsSync(join(dataDir, `${ORG}.ingest.lock`))).toBe(false);
  });

  it("a file the OS says is in use is reported as skipped and not counted as freed", async () => {
    const { pruneOrgBackups } = await import("../commands/rebuild-backups.js");
    const names = stubBackups(ORG, 3);
    const busy = (p: string) => {
      if (p.endsWith(names[0] as string)) {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      }
      return rmSync(p, { force: true });
    };
    const r = pruneOrgBackups(backupsDir(), ORG, { keep: 1, unlink: busy });
    expect(r.inUse.map((b) => b.name)).toEqual([names[0]]);
    expect(r.removed.map((b) => b.name)).toEqual([names[1]]);
    expect(r.freedBytes).toBe("stub-graph".length);
    expect(backupNames()).toEqual([names[0], names[2]]);
  });
});
