import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { MigrationError } from "@sfgraph/shared";
import * as sqliteVec from "sqlite-vec";
import type { BetterSqlite3Database, Migration } from "../interfaces.js";

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial registry + snapshot tables",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS _sfgraph_schema_version (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL,
          description TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _sfgraph_orgs (
          id TEXT PRIMARY KEY,
          alias TEXT NOT NULL,
          instance_url TEXT NOT NULL,
          api_version TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _sfgraph_node_labels (
          label TEXT PRIMARY KEY,
          table_name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _sfgraph_edge_types (
          rel_type TEXT PRIMARY KEY,
          table_name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS _sfgraph_snapshots (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          label TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          is_auto INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS _sfgraph_snapshots_org_created
          ON _sfgraph_snapshots(org_id, created_at);
        CREATE TABLE IF NOT EXISTS _sfgraph_node_snapshots (
          snapshot_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          label TEXT NOT NULL,
          attributes TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          last_modified_at INTEGER NOT NULL,
          PRIMARY KEY(snapshot_id, org_id, qualified_name)
        );
        CREATE TABLE IF NOT EXISTS _sfgraph_edge_snapshots (
          snapshot_id TEXT NOT NULL,
          org_id TEXT NOT NULL,
          src_qname TEXT NOT NULL,
          dst_qname TEXT NOT NULL,
          rel_type TEXT NOT NULL,
          attributes TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY(snapshot_id, org_id, src_qname, dst_qname, rel_type)
        );
      `);
    },
  },
  {
    version: 2,
    description: "node index lookup",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS _sfgraph_node_index (
          org_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          label TEXT NOT NULL,
          PRIMARY KEY(org_id, qualified_name)
        );
      `);
    },
  },
  {
    version: 3,
    description: "vector tables (sqlite-vec)",
    up(db) {
      sqliteVec.load(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS _sfgraph_node_vector_meta (
          org_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          label TEXT NOT NULL,
          vec_rowid INTEGER NOT NULL,
          PRIMARY KEY(org_id, qualified_name)
        );
        CREATE INDEX IF NOT EXISTS _sfgraph_node_vector_meta_hash
          ON _sfgraph_node_vector_meta(content_hash);
        CREATE TABLE IF NOT EXISTS _sfgraph_bundle_vector_meta (
          org_id TEXT NOT NULL,
          bundle_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          vec_rowid INTEGER NOT NULL,
          PRIMARY KEY(org_id, bundle_id)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS _sfgraph_node_vectors USING vec0(
          org_id TEXT PARTITION KEY,
          embedding float[384]
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS _sfgraph_bundle_vectors USING vec0(
          org_id TEXT PARTITION KEY,
          embedding float[384]
        );
      `);
    },
  },
];

export interface MigrationRunnerOpts {
  backupDir: string;
  retainBackups: number;
}

export class MigrationRunner {
  constructor(
    private readonly db: BetterSqlite3Database,
    private readonly migrations: Migration[],
    private readonly opts: MigrationRunnerOpts,
  ) {}

  private getCurrentVersion(): number {
    const row = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_sfgraph_schema_version'",
      )
      .get() as { name: string } | undefined;
    if (!row) return 0;
    const r = this.db.prepare("SELECT MAX(version) AS v FROM _sfgraph_schema_version").get() as
      | { v: number | null }
      | undefined;
    return r?.v ?? 0;
  }

  private validateRegistry(): void {
    const seen = new Set<number>();
    for (const m of this.migrations) {
      if (seen.has(m.version)) {
        throw new MigrationError(
          `SF_DUPLICATE_MIGRATION: duplicate migration version ${m.version}`,
        );
      }
      seen.add(m.version);
    }
  }

  private backup(currentVersion: number): void {
    const dbName = this.db.name;
    if (!dbName || dbName === ":memory:" || dbName === "") return;
    if (!existsSync(this.opts.backupDir)) {
      mkdirSync(this.opts.backupDir, { recursive: true });
    }
    const ts = Date.now();
    const base = path.basename(dbName);
    const dest = path.join(this.opts.backupDir, `${base}.v${currentVersion}.${ts}.sqlite`);
    // better-sqlite3 backup is async; use VACUUM INTO for a sync snapshot.
    this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    this.rotateBackups();
  }

  private rotateBackups(): void {
    if (!existsSync(this.opts.backupDir)) return;
    const entries = readdirSync(this.opts.backupDir)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => {
        const full = path.join(this.opts.backupDir, f);
        return { full, mtime: statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (let i = this.opts.retainBackups; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry) {
        try {
          unlinkSync(entry.full);
        } catch {
          /* ignore */
        }
      }
    }
  }

  applyPending(): void {
    this.validateRegistry();
    const sorted = [...this.migrations].sort((a, b) => a.version - b.version);
    let current = this.getCurrentVersion();
    for (const m of sorted) {
      if (m.version <= current) continue;
      // Only back up if there's prior state worth preserving.
      if (current > 0) {
        this.backup(current);
      }
      const apply = this.db.transaction(() => {
        m.up(this.db);
        this.db
          .prepare(
            "INSERT INTO _sfgraph_schema_version(version, applied_at, description) VALUES (?, ?, ?)",
          )
          .run(m.version, Date.now(), m.description);
      });
      apply();
      current = m.version;
    }
  }
}
