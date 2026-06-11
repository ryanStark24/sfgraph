import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { MigrationError } from "@ryanstark24/sfgraph-shared";
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
    version: 4,
    description: "org last_synced_at",
    up(db) {
      // SQLite forbids ALTER TABLE ADD COLUMN with a non-constant default; NULL is fine.
      db.exec("ALTER TABLE _sfgraph_orgs ADD COLUMN last_synced_at INTEGER");
    },
  },
  {
    version: 5,
    description: "phase 6 analysis tables (findings, dead-code, governor, test coverage)",
    up(db) {
      // NOTE: Spec called for PK using IFNULL(line,0) but SQLite doesn't allow
      // expressions in PRIMARY KEY declarations. Divergence: store -1 sentinel
      // for "no specific line" findings and include `line` as a plain PK column.
      db.exec(`
        CREATE TABLE IF NOT EXISTS _sfgraph_findings (
          org_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          line INTEGER NOT NULL DEFAULT -1,
          severity TEXT NOT NULL,
          message TEXT NOT NULL,
          evidence TEXT,
          computed_at INTEGER NOT NULL,
          PRIMARY KEY(org_id, qualified_name, rule_id, line)
        );
        CREATE INDEX IF NOT EXISTS _sfgraph_findings_qname
          ON _sfgraph_findings(org_id, qualified_name);
        CREATE INDEX IF NOT EXISTS _sfgraph_findings_rule
          ON _sfgraph_findings(org_id, rule_id, severity);

        CREATE TABLE IF NOT EXISTS _sfgraph_dead_code_scores (
          org_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          score REAL NOT NULL,
          confidence TEXT NOT NULL,
          reasons TEXT NOT NULL,
          computed_at INTEGER NOT NULL,
          PRIMARY KEY(org_id, qualified_name)
        );
        CREATE INDEX IF NOT EXISTS _sfgraph_dead_code_conf
          ON _sfgraph_dead_code_scores(org_id, confidence, score);

        CREATE TABLE IF NOT EXISTS _sfgraph_governor_risks (
          org_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          risk_type TEXT NOT NULL,
          evidence TEXT,
          line INTEGER NOT NULL DEFAULT -1,
          computed_at INTEGER NOT NULL,
          PRIMARY KEY(org_id, qualified_name, risk_type, line)
        );
        CREATE INDEX IF NOT EXISTS _sfgraph_governor_type
          ON _sfgraph_governor_risks(org_id, risk_type);

        CREATE TABLE IF NOT EXISTS _sfgraph_test_coverage (
          org_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          test_count INTEGER NOT NULL,
          computed_at INTEGER NOT NULL,
          PRIMARY KEY(org_id, qualified_name)
        );
        CREATE INDEX IF NOT EXISTS _sfgraph_test_coverage_low
          ON _sfgraph_test_coverage(org_id, test_count);
      `);
    },
  },
  {
    version: 6,
    description: "snippet store (source text + lazy LLM explanations)",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS _sfgraph_snippets (
          org_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          source_format TEXT NOT NULL,
          source_text TEXT NOT NULL,
          start_line INTEGER,
          end_line INTEGER,
          source_hash TEXT NOT NULL,
          llm_explanation TEXT,
          explained_at INTEGER,
          PRIMARY KEY (org_id, qualified_name)
        );
        CREATE INDEX IF NOT EXISTS idx_snippets_org ON _sfgraph_snippets (org_id);
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
  {
    version: 7,
    description:
      "W3-05: service-id ↔ qualified-name map for rename stability. When a metadata component's underlying Salesforce ID is unchanged but its developer name changes, we rewrite incoming edges to point at the new qname instead of treating it as a delete+add.",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS _sfgraph_service_ids (
          org_id TEXT NOT NULL,
          service_id TEXT NOT NULL,
          qualified_name TEXT NOT NULL,
          label TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY (org_id, service_id)
        );
        CREATE INDEX IF NOT EXISTS idx_service_ids_qname
          ON _sfgraph_service_ids (org_id, qualified_name);
      `);
    },
  },
  {
    version: 8,
    description:
      "W1.5-08: sync-generation counter + in-progress flag on _sfgraph_orgs so concurrent MCP readers can detect 'graph is being rewritten' mid-ingest. Additive ALTER TABLE; pre-existing rows default to (0, 0, NULL).",
    up(db) {
      // SQLite forbids ALTER TABLE ADD COLUMN with a non-constant default,
      // but constant 0 / NULL are fine. Existing rows pick up the defaults
      // automatically. Three separate ALTERs (SQLite ALTER syntax doesn't
      // batch column adds).
      db.exec(`
        ALTER TABLE _sfgraph_orgs ADD COLUMN sync_generation INTEGER NOT NULL DEFAULT 0;
      `);
      db.exec(`
        ALTER TABLE _sfgraph_orgs ADD COLUMN sync_in_progress INTEGER NOT NULL DEFAULT 0;
      `);
      db.exec(`
        ALTER TABLE _sfgraph_orgs ADD COLUMN sync_started_at TEXT;
      `);
    },
  },
  {
    version: 9,
    description:
      "Case-insensitive qnames: rebuild every qname-keyed table with COLLATE NOCASE on its qname columns. Salesforce API names are case-insensitive (Account == account), but qnames were stored/looked-up case-sensitively, so a SOQL `from account` produced a CustomObject:account edge that never matched the CustomObject:Account node (dangling edges, duplicate rows, missed joins). NOCASE makes =, PK uniqueness, and JOINs fold case while preserving the original display string. Stored values are unchanged → zero golden churn.",
    up(db) {
      addNocaseCollation(db);
    },
  },
];

/**
 * Rebuild a table so the named columns use `COLLATE NOCASE`, by rewriting the
 * table's OWN `CREATE` SQL (read from sqlite_master) rather than hardcoding each
 * schema — robust against schema drift. Preserves rows (case-duplicate PK
 * collisions collapse via INSERT OR IGNORE — first-seen row wins) and secondary
 * indexes. No-op if the table is absent or already NOCASE on those columns.
 */
export function rebuildWithNocase(
  db: BetterSqlite3Database,
  table: string,
  qnameCols: string[],
): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  if (!row?.sql) return;
  let createSql = row.sql;
  let changed = false;
  for (const col of qnameCols) {
    // Match `<col> TEXT …` up to the next comma/newline; add COLLATE NOCASE if absent.
    const re = new RegExp(`(\\b${col}\\b\\s+TEXT\\b[^,\\n]*)`, "i");
    createSql = createSql.replace(re, (def) => {
      if (/COLLATE\s+NOCASE/i.test(def)) return def;
      changed = true;
      return `${def} COLLATE NOCASE`;
    });
  }
  if (!changed) return; // already NOCASE
  const tmp = `${table}__nocase_tmp`;
  // The table name appears right after CREATE TABLE [IF NOT EXISTS]; rename only that.
  const tmpCreate = createSql.replace(
    /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?("?)([^\s("]+)\2/i,
    (_m, ifne, q, _name) => `CREATE TABLE ${ifne ?? ""}${q}${tmp}${q}`,
  );
  const indexes = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    )
    .all(table) as Array<{ sql: string }>;
  db.exec(tmpCreate);
  db.exec(`INSERT OR IGNORE INTO ${tmp} SELECT * FROM ${table};`);
  db.exec(`DROP TABLE ${table};`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table};`);
  // Secondary indexes were dropped with the old table; recreate them (their SQL
  // names the original table, which now exists again under the same name).
  for (const idx of indexes) db.exec(idx.sql);
}

/** Apply NOCASE to every table whose primary/foreign key is a qname. */
function addNocaseCollation(db: BetterSqlite3Database): void {
  // Dynamic per-label node tables + per-rel edge tables (from the registries).
  const nodeTables = db.prepare("SELECT table_name FROM _sfgraph_node_labels").all() as Array<{
    table_name: string;
  }>;
  for (const { table_name } of nodeTables) rebuildWithNocase(db, table_name, ["qualified_name"]);
  const edgeTables = db.prepare("SELECT table_name FROM _sfgraph_edge_types").all() as Array<{
    table_name: string;
  }>;
  for (const { table_name } of edgeTables)
    rebuildWithNocase(db, table_name, ["src_qname", "dst_qname"]);
  // Static qname-keyed tables (lookups + derived data). Snapshot tables are left
  // case-sensitive on purpose — they are point-in-time history.
  rebuildWithNocase(db, "_sfgraph_node_index", ["qualified_name"]);
  rebuildWithNocase(db, "_sfgraph_snippets", ["qualified_name"]);
  rebuildWithNocase(db, "_sfgraph_governor_risks", ["qualified_name"]);
  rebuildWithNocase(db, "_sfgraph_findings", ["qualified_name"]);
  rebuildWithNocase(db, "_sfgraph_dead_code_scores", ["qualified_name"]);
  rebuildWithNocase(db, "_sfgraph_test_coverage", ["qualified_name"]);
  rebuildWithNocase(db, "_sfgraph_node_vector_meta", ["qualified_name"]);
  rebuildWithNocase(db, "_sfgraph_service_ids", ["qualified_name"]);
}

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
