import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MigrationError } from "@sfgraph/shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Migration } from "../interfaces.js";
import { MIGRATIONS, MigrationRunner } from "../sqlite/migrations.js";

let workDir: string;
let dbPath: string;
let backupDir: string;
let db: Database.Database;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-mig-"));
  dbPath = path.join(workDir, "test.sqlite");
  backupDir = path.join(workDir, "backups");
  db = new Database(dbPath);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(workDir, { recursive: true, force: true });
});

function currentVersion(d: Database.Database): number {
  const exists = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_sfgraph_schema_version'")
    .get();
  if (!exists) return 0;
  const r = d.prepare("SELECT MAX(version) AS v FROM _sfgraph_schema_version").get() as
    | { v: number | null }
    | undefined;
  return r?.v ?? 0;
}

describe("MigrationRunner", () => {
  it("fresh DB starts at version 0", () => {
    expect(currentVersion(db)).toBe(0);
  });

  it("applyPending brings DB to highest version", () => {
    const runner = new MigrationRunner(db, MIGRATIONS, { backupDir, retainBackups: 5 });
    runner.applyPending();
    expect(currentVersion(db)).toBe(3);
  });

  it("is idempotent on re-run", () => {
    const runner = new MigrationRunner(db, MIGRATIONS, { backupDir, retainBackups: 5 });
    runner.applyPending();
    runner.applyPending();
    expect(currentVersion(db)).toBe(3);
    const rows = db.prepare("SELECT version FROM _sfgraph_schema_version ORDER BY version").all();
    expect(rows).toHaveLength(3);
  });

  it("rejects duplicate migration versions", () => {
    const m1 = MIGRATIONS[0] as Migration;
    const dup: Migration[] = [m1, { ...m1 }];
    const runner = new MigrationRunner(db, dup, { backupDir, retainBackups: 5 });
    expect(() => runner.applyPending()).toThrow(MigrationError);
  });

  it("creates a backup when applying a new migration over an existing version", () => {
    // First apply just v1.
    const v1Only = MIGRATIONS.filter((m) => m.version === 1);
    new MigrationRunner(db, v1Only, { backupDir, retainBackups: 5 }).applyPending();
    expect(currentVersion(db)).toBe(1);

    // Now apply through v3; should produce backups.
    new MigrationRunner(db, MIGRATIONS, { backupDir, retainBackups: 5 }).applyPending();
    expect(currentVersion(db)).toBe(3);
    const files = readdirSync(backupDir).filter((f) => f.endsWith(".sqlite"));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("rotates old backups beyond retainBackups", () => {
    // Apply v1 first.
    new MigrationRunner(
      db,
      MIGRATIONS.filter((m) => m.version === 1),
      {
        backupDir,
        retainBackups: 1,
      },
    ).applyPending();
    // Now run a runner that has two new migrations to apply, generating 2 backups, retained=1.
    new MigrationRunner(db, MIGRATIONS, { backupDir, retainBackups: 1 }).applyPending();
    const files = readdirSync(backupDir).filter((f) => f.endsWith(".sqlite"));
    expect(files.length).toBeLessThanOrEqual(1);
  });
});
