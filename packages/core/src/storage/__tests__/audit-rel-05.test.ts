import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { BUSY_TIMEOUT_MS, SqliteGraphStore } from "../sqlite/graph-store.js";
import { SqliteSnapshotStore } from "../sqlite/snapshot-store.js";

const ORG = asOrgId("org1");
function nf(label: string, qname: string, hash = "h1"): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: { a: 1 },
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function ef(rt: string, src: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rt as EdgeFact["relType"],
    attributes: { k: "v" },
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}
let workDir: string;
let dbPath: string;
beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-audit-"));
  dbPath = path.join(workDir, "g.sqlite");
});
afterEach(() => rmSync(workDir, { recursive: true, force: true }));

// audit rel-05: opening a store with a pending migration while a writer holds the lock.
import Database from "better-sqlite3";
import { MIGRATIONS, MigrationRunner } from "../sqlite/migrations.js";

describe("audit rel-05", () => {
  it("opening a store one migration behind during an ingest write lock does not fail with a raw 'database is locked'", async () => {
    const seed = new Database(dbPath);
    seed.pragma("journal_mode = WAL");
    const behind = MIGRATIONS.slice(0, -1);
    new MigrationRunner(seed, behind, {
      backupDir: path.join(workDir, "b0"),
      retainBackups: 1,
    }).applyPending();
    seed.close();
    const writer = new Database(dbPath);
    writer.pragma("journal_mode = WAL");
    writer.exec("BEGIN IMMEDIATE");
    const reader = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    let err: Error | null = null;
    try {
      await reader.init();
    } catch (e) {
      err = e as Error;
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    // Either the open succeeds (read-only / skip-migrations) or it fails with a clear hint.
    if (err) expect(err.message).toMatch(/ingest.*(in progress|running)|retry/i);
    expect(err?.message ?? "").not.toMatch(/^database is locked$/i);
    // A refused open must not leave a full-size VACUUM INTO backup behind.
    if (err)
      expect(
        existsSync(path.join(workDir, "b")) ? readdirSync(path.join(workDir, "b")) : [],
      ).toEqual([]);
    try {
      await reader.close();
    } catch {
      /* ignore */
    }
  }, 30_000);

  it("sets an explicit busy_timeout on open", async () => {
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "b") });
    await g.init();
    expect(g.db.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);
    await g.close();
  });
});

describe("review I1 / minor 4: migration backups and progress", () => {
  it("takes exactly one backup per applyPending run, even across several pending steps", () => {
    const db = new Database(dbPath);
    new MigrationRunner(
      db,
      MIGRATIONS.filter((m) => m.version <= 12),
      { backupDir: path.join(workDir, "b0"), retainBackups: 5 },
    ).applyPending();
    const b = path.join(workDir, "b");
    new MigrationRunner(db, MIGRATIONS, { backupDir: b, retainBackups: 5 }).applyPending();
    const files = readdirSync(b);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.v12\.\d+\.sqlite$/);
    db.close();
  });

  it("removes the backup it just wrote when the apply then fails with BUSY (probe-to-apply race)", () => {
    const db = new Database(dbPath);
    const behind = MIGRATIONS.slice(0, -1);
    new MigrationRunner(db, behind, {
      backupDir: path.join(workDir, "b0"),
      retainBackups: 5,
    }).applyPending();
    const last = MIGRATIONS[MIGRATIONS.length - 1]!;
    const busy = {
      ...last,
      up: () => {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      },
    };
    const b = path.join(workDir, "b");
    expect(() =>
      new MigrationRunner(db, [...behind, busy], { backupDir: b, retainBackups: 5 }).applyPending(),
    ).toThrow(/locked by another writer/);
    expect(existsSync(b) ? readdirSync(b) : []).toEqual([]);
    db.close();
  });

  it("v14 reports conversion progress on stderr and never writes to stdout", () => {
    const db = new Database(dbPath);
    new MigrationRunner(
      db,
      MIGRATIONS.filter((m) => m.version <= 13),
      { backupDir: path.join(workDir, "b0"), retainBackups: 5 },
    ).applyPending();
    db.prepare(
      "INSERT INTO _sfgraph_snapshots(id, org_id, label, created_at, is_auto) VALUES ('s1', 'org1', 's1', 1, 0)",
    ).run();
    const out = vi.spyOn(process.stdout, "write");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      new MigrationRunner(db, MIGRATIONS, {
        backupDir: path.join(workDir, "b"),
        retainBackups: 5,
      }).applyPending();
      expect(out).not.toHaveBeenCalled();
      expect(err.mock.calls.map((c) => String(c[0])).join("")).toMatch(/snapshot/i);
    } finally {
      out.mockRestore();
      err.mockRestore();
      db.close();
    }
  });
});
