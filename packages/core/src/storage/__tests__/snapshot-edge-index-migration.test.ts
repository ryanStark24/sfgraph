import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, MigrationRunner } from "../sqlite/migrations.js";
import { SqliteSnapshotStore } from "../sqlite/snapshot-store.js";
import { SNAP_EDGE_INDEXES } from "../sqlite/snapshot-versions.js";

// T14 batch L, schema v15: the snapshot edge key / rel indexes become covering
// (from_seq, and src/dst on the rel index), so edge-diff anti-joins and counts
// never read version rows. Existing versions and diffs are unchanged.

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-v15-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const indexCols = (db: Database.Database, name: string) =>
  (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ seqno: number; name: string }>)
    .sort((a, b) => a.seqno - b.seqno)
    .map((r) => r.name);

const plan = (db: Database.Database, sql: string, params: Record<string, unknown>) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as Array<{ detail: string }>)
    .map((r) => r.detail)
    .join("\n");

describe("migration v15: covering snapshot edge indexes", () => {
  it("rebuilds both edge indexes on a v14 DB, keeping versions and diffs", async () => {
    const dbPath = path.join(workDir, "v14.sqlite");
    const db = new Database(dbPath);
    const backupDir = path.join(workDir, "bkp");
    new MigrationRunner(
      db,
      MIGRATIONS.filter((m) => m.version <= 14),
      { backupDir, retainBackups: 5 },
    ).applyPending();
    // The index shapes a DB migrated before v15 has (the v14 DDL now creates
    // the v15 shapes directly).
    db.exec(`
      DROP INDEX _sfgraph_snap_edges_key;
      CREATE INDEX _sfgraph_snap_edges_key
        ON _sfgraph_snap_edges(org_id, src_qname, dst_qname, rel_type, to_seq);
      DROP INDEX _sfgraph_snap_edges_rel;
      CREATE INDEX _sfgraph_snap_edges_rel ON _sfgraph_snap_edges(org_id, rel_type, to_seq);
    `);
    expect(indexCols(db, "_sfgraph_snap_edges_key")).toHaveLength(5);
    expect(indexCols(db, "_sfgraph_snap_edges_rel")).toHaveLength(3);
    // A v14 graph with one edge table and two snapshots.
    db.exec(`
      INSERT INTO _sfgraph_edge_types(rel_type, table_name, created_at) VALUES ('CALLS', '_sfg_e_calls', 1);
      CREATE TABLE _sfg_e_calls (
        org_id TEXT NOT NULL, src_qname TEXT NOT NULL COLLATE NOCASE, dst_qname TEXT NOT NULL COLLATE NOCASE,
        attributes TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(org_id, src_qname, dst_qname));
      INSERT INTO _sfgraph_snapshots(id, org_id, label, created_at, is_auto, seq) VALUES
        ('s1', 'org1', 's1', 1, 0, 1), ('s2', 'org1', 's2', 2, 0, 2);
      INSERT INTO _sfgraph_snap_edges VALUES
        ('org1', 'A', 'B', 'CALLS', '{}', 1, 1, 1, 2),
        ('org1', 'A', 'C', 'CALLS', '{}', 1, 1, 1, NULL),
        ('org1', 'A', 'D', 'CALLS', '{}', 1, 1, 2, NULL);
      INSERT INTO _sfg_e_calls VALUES ('org1', 'A', 'C', '{}', 1, 1), ('org1', 'A', 'E', '{}', 1, 1);
    `);
    const before = db.prepare("SELECT * FROM _sfgraph_snap_edges ORDER BY rowid").all();
    new MigrationRunner(db, MIGRATIONS, { backupDir, retainBackups: 5 }).applyPending();
    expect(
      (db.prepare("SELECT MAX(version) AS v FROM _sfgraph_schema_version").get() as { v: number })
        .v,
    ).toBe(17);
    expect(indexCols(db, "_sfgraph_snap_edges_key")).toEqual([
      "org_id",
      "src_qname",
      "dst_qname",
      "rel_type",
      "to_seq",
      "from_seq",
    ]);
    expect(indexCols(db, "_sfgraph_snap_edges_rel")).toEqual([
      "org_id",
      "rel_type",
      "to_seq",
      "from_seq",
      "src_qname",
      "dst_qname",
    ]);
    expect(db.prepare("SELECT * FROM _sfgraph_snap_edges ORDER BY rowid").all()).toEqual(before);

    const snap = new SqliteSnapshotStore({ dbPath, db, skipMigrations: true });
    await snap.init();
    const keys = (d: { added: unknown[]; removed: unknown[] }) => ({
      added: (d.added as Array<{ dstQualifiedName: string }>).map((x) => x.dstQualifiedName),
      removed: (d.removed as Array<{ dstQualifiedName: string }>).map((x) => x.dstQualifiedName),
    });
    const org = asOrgId("org1");
    expect(keys(snap.diffEdges(org, "s1", "current"))).toEqual({ added: ["E"], removed: ["B"] });
    expect(keys(snap.diffEdges(org, "s2", "current"))).toEqual({ added: ["E"], removed: ["D"] });
    expect(keys(snap.diffEdges(org, "s1", "s2"))).toEqual({ added: ["D"], removed: ["B"] });

    // Both anti-join directions are answered from the covering indexes.
    const toCurrent = plan(
      db,
      `SELECT COUNT(*) FROM _sfg_e_calls c WHERE c.org_id = @org AND NOT EXISTS (
         SELECT 1 FROM _sfgraph_snap_edges w WHERE w.org_id = c.org_id AND w.src_qname = c.src_qname
           AND w.dst_qname = c.dst_qname AND w.rel_type = 'CALLS'
           AND w.from_seq <= @s AND (w.to_seq IS NULL OR w.to_seq > @s))`,
      { org: "org1", s: 1 },
    );
    expect(toCurrent).toMatch(/SEARCH w USING COVERING INDEX _sfgraph_snap_edges_key/);
    const fromSnap = plan(
      db,
      `SELECT COUNT(*) FROM _sfgraph_snap_edges v WHERE v.org_id = @org AND v.rel_type = 'CALLS'
         AND v.from_seq <= @s AND (v.to_seq IS NULL OR v.to_seq > @s)
         AND NOT EXISTS (SELECT 1 FROM _sfg_e_calls c WHERE c.org_id = v.org_id
           AND c.src_qname = v.src_qname AND c.dst_qname = v.dst_qname
           AND c.src_qname = v.src_qname COLLATE BINARY AND c.dst_qname = v.dst_qname COLLATE BINARY)`,
      { org: "org1", s: 1 },
    );
    expect(fromSnap).toMatch(/SEARCH v USING COVERING INDEX _sfgraph_snap_edges_rel/);
    db.close();
  });

  it("does not rebuild indexes a fresh DB already has in the v15 shape", () => {
    const db = new Database(path.join(workDir, "fresh.sqlite"));
    const runner = (ms: typeof MIGRATIONS) =>
      new MigrationRunner(db, ms, { backupDir: path.join(workDir, "bkp2"), retainBackups: 5 });
    runner(MIGRATIONS.filter((m) => m.version <= 14)).applyPending();
    for (const [name, cols] of Object.entries(SNAP_EDGE_INDEXES)) {
      expect(indexCols(db, name)).toEqual(cols);
    }
    const sqlOf = () =>
      db
        .prepare(
          "SELECT name, sql, rootpage FROM sqlite_master WHERE name LIKE '_sfgraph_snap_edges_%'",
        )
        .all();
    const before = sqlOf();
    runner(MIGRATIONS).applyPending();
    expect(sqlOf()).toEqual(before);
    db.close();
  });
});
