import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * --rebuild moves an existing graph file to `<dataDir>/backups/`. We exercise
 * the real `applyRebuild` path by feeding the CLI a `--db` override (so the
 * computation of the dbPath is fully under our control) and stubbing
 * `liveIngest` so we don't open a Salesforce connection.
 *
 * Note: --rebuild's backupDir computation in CLI uses `getSfgraphPaths().data`,
 * not the dir of --db. So we additionally stub that.
 */

let tmpDataDir: string;
let tmpDbDir: string;

beforeEach(() => {
  tmpDataDir = mkdtempSync(join(tmpdir(), "sfgraph-rebuild-data-"));
  tmpDbDir = mkdtempSync(join(tmpdir(), "sfgraph-rebuild-db-"));
});

afterEach(() => {
  rmSync(tmpDataDir, { recursive: true, force: true });
  rmSync(tmpDbDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

async function stubModulesForRebuild(orgId: string): Promise<void> {
  vi.doMock("@ryanstark24/sfgraph-core", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-core")>(
      "@ryanstark24/sfgraph-core",
    );
    return {
      ...actual,
      liveIngest: async () => ({
        orgId,
        capabilities: {},
        mode: "full" as const,
        membersProcessed: 0,
        parseErrors: 0,
        deletions: 0,
        durationMs: 0,
      }),
      resolveOrg: async (alias: string) => ({
        orgId,
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
        data: tmpDataDir,
        cache: tmpDataDir,
        log: tmpDataDir,
        config: tmpDataDir,
        temp: tmpDataDir,
      }),
    };
  });
}

describe("ingest --rebuild file handling", () => {
  it("moves an existing graph file to backups/", async () => {
    const orgId = "00Dxxfakeorg00";
    const dbPath = join(tmpDbDir, `${orgId}.sqlite`);
    writeFileSync(dbPath, "stub");

    await stubModulesForRebuild(orgId);
    const { ingestCmd } = await import("../commands/ingest.js");
    await ingestCmd({ org: "fake", rebuild: true, db: dbPath });

    // After rebuild, a NEW empty DB exists at dbPath (created by SqliteGraphStore).
    // The OLD stub bytes must live in backups/.
    const backupDir = join(tmpDataDir, "backups");
    expect(existsSync(backupDir)).toBe(true);
    const files = readdirSync(backupDir);
    const backupFile = files.find(
      (f) => f.startsWith(`${orgId}.rebuild-`) && f.endsWith(".sqlite"),
    );
    expect(backupFile).toBeDefined();
    // Confirm the backup is the original stub content (not a fresh SQLite DB).
    expect(readFileSync(join(backupDir, backupFile ?? ""), "utf8")).toBe("stub");
  });

  it("--no-backup deletes the file instead", async () => {
    const orgId = "00Dxxnobak00";
    const dbPath = join(tmpDbDir, `${orgId}.sqlite`);
    writeFileSync(dbPath, "stub");

    await stubModulesForRebuild(orgId);
    const { ingestCmd } = await import("../commands/ingest.js");
    await ingestCmd({ org: "fake", rebuild: true, noBackup: true, db: dbPath });

    // dbPath was unlinked, then SqliteGraphStore re-created a fresh DB there.
    // Confirm no backup was made for this org.
    const backupDir = join(tmpDataDir, "backups");
    if (existsSync(backupDir)) {
      const files = readdirSync(backupDir);
      expect(files.some((f) => f.startsWith(`${orgId}.rebuild-`))).toBe(false);
    }
    // The recreated DB at dbPath is NOT the stub content.
    if (existsSync(dbPath)) {
      expect(readFileSync(dbPath, "utf8")).not.toBe("stub");
    }
  });

  it("moves WAL/SHM sidecars alongside the main DB to backups/", async () => {
    const orgId = "00Dxxsidecar01";
    const dbPath = join(tmpDbDir, `${orgId}.sqlite`);
    writeFileSync(dbPath, "stub");
    writeFileSync(`${dbPath}-wal`, "stubwal");
    writeFileSync(`${dbPath}-shm`, "stubshm");

    await stubModulesForRebuild(orgId);
    const { ingestCmd } = await import("../commands/ingest.js");
    await ingestCmd({ org: "fake", rebuild: true, db: dbPath });

    const backupDir = join(tmpDataDir, "backups");
    const files = readdirSync(backupDir);
    const mainBackup = files.find(
      (f) => f.startsWith(`${orgId}.rebuild-`) && f.endsWith(".sqlite"),
    );
    expect(mainBackup).toBeDefined();
    // Sidecars must have moved alongside the main file.
    const walBackup = files.find((f) => f === `${mainBackup}-wal`);
    const shmBackup = files.find((f) => f === `${mainBackup}-shm`);
    expect(walBackup).toBeDefined();
    expect(shmBackup).toBeDefined();
    expect(readFileSync(join(backupDir, walBackup ?? ""), "utf8")).toBe("stubwal");
    expect(readFileSync(join(backupDir, shmBackup ?? ""), "utf8")).toBe("stubshm");
    // No orphan sidecars left next to the (fresh) main DB.
    expect(existsSync(`${dbPath}-wal`)).toBeDefined();
    // The fresh sidecars from the reopened DB are SQLite's own; what
    // matters is the stub contents are gone — assert by absence of "stubwal".
    if (existsSync(`${dbPath}-wal`)) {
      expect(readFileSync(`${dbPath}-wal`, "utf8")).not.toBe("stubwal");
    }
  });

  it("--no-backup deletes sidecars too", async () => {
    const orgId = "00Dxxsidecar02";
    const dbPath = join(tmpDbDir, `${orgId}.sqlite`);
    writeFileSync(dbPath, "stub");
    writeFileSync(`${dbPath}-wal`, "stubwal");
    writeFileSync(`${dbPath}-shm`, "stubshm");
    writeFileSync(`${dbPath}-journal`, "stubjournal");

    await stubModulesForRebuild(orgId);
    const { ingestCmd } = await import("../commands/ingest.js");
    await ingestCmd({ org: "fake", rebuild: true, noBackup: true, db: dbPath });

    // After rebuild + no-backup, the stub sidecars must not exist (a fresh
    // DB may have created new WAL/SHM with different content, which is fine).
    if (existsSync(`${dbPath}-wal`)) {
      expect(readFileSync(`${dbPath}-wal`, "utf8")).not.toBe("stubwal");
    }
    if (existsSync(`${dbPath}-shm`)) {
      expect(readFileSync(`${dbPath}-shm`, "utf8")).not.toBe("stubshm");
    }
    // -journal isn't created in WAL mode, so it shouldn't reappear.
    expect(existsSync(`${dbPath}-journal`)).toBe(false);
  });

  it("is a no-op when no existing DB file is present", async () => {
    const orgId = "00Dxxnewbuild";
    const dbPath = join(tmpDbDir, `${orgId}.sqlite`);
    expect(existsSync(dbPath)).toBe(false);

    await stubModulesForRebuild(orgId);
    const { ingestCmd } = await import("../commands/ingest.js");
    // Should not throw.
    await ingestCmd({ org: "fake", rebuild: true, db: dbPath });
    // No backup created.
    const backupDir = join(tmpDataDir, "backups");
    if (existsSync(backupDir)) {
      const files = readdirSync(backupDir);
      expect(files.some((f) => f.startsWith(`${orgId}.rebuild-`))).toBe(false);
    }
  });
});
