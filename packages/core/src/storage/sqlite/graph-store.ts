import { mkdirSync } from "node:fs";
import path from "node:path";
import { StorageError, asOrgId, asQualifiedName, asSha256 } from "@sfgraph/shared";
import type { OrgId, QualifiedName, Sha256 } from "@sfgraph/shared";
import Database from "better-sqlite3";
import type { EdgeFact, NodeFact, Org, RelType } from "../../domain/index.js";
import { edgeTableName, nodeTableName, validateLabel, validateRelType } from "../identifier.js";
import type { BetterSqlite3Database, GraphStore, MergeResult } from "../interfaces.js";
import { MIGRATIONS, MigrationRunner } from "./migrations.js";

export interface SqliteGraphStoreOptions {
  dbPath: string;
  backupDir?: string;
  retainBackups?: number;
  db?: BetterSqlite3Database; // for sharing with VectorStore/SnapshotStore
}

interface RawNodeRow {
  org_id: string;
  qualified_name: string;
  attributes: string;
  source_hash: string;
  first_seen_at: number;
  last_seen_at: number;
  last_modified_at: number;
}

interface RawEdgeRow {
  org_id: string;
  src_qname: string;
  dst_qname: string;
  attributes: string;
  first_seen_at: number;
  last_seen_at: number;
}

function rowToNode(row: RawNodeRow, label: string): NodeFact {
  return {
    orgId: asOrgId(row.org_id),
    qualifiedName: asQualifiedName(row.qualified_name),
    label,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    sourceHash: asSha256(row.source_hash),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastModifiedAt: row.last_modified_at,
  };
}

function rowToEdge(row: RawEdgeRow, relType: RelType): EdgeFact {
  return {
    orgId: asOrgId(row.org_id),
    srcQualifiedName: asQualifiedName(row.src_qname),
    dstQualifiedName: asQualifiedName(row.dst_qname),
    relType,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class SqliteGraphStore implements GraphStore {
  readonly db: BetterSqlite3Database;
  private readonly ownsDb: boolean;
  private readonly opts: SqliteGraphStoreOptions;
  private nodeLabelCache: Map<string, string> = new Map();
  private edgeRelCache: Map<string, string> = new Map();
  private initialized = false;

  constructor(opts: SqliteGraphStoreOptions) {
    this.opts = opts;
    if (opts.db) {
      this.db = opts.db;
      this.ownsDb = false;
    } else {
      if (opts.dbPath !== ":memory:") {
        const dir = path.dirname(opts.dbPath);
        if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(opts.dbPath);
      this.ownsDb = true;
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 268435456");
    this.db.pragma("cache_size = -200000");
    const backupDir =
      this.opts.backupDir ??
      (this.opts.dbPath === ":memory:"
        ? path.join(process.cwd(), ".sfgraph-backups")
        : path.join(path.dirname(this.opts.dbPath), ".sfgraph-backups"));
    const runner = new MigrationRunner(this.db, MIGRATIONS, {
      backupDir,
      retainBackups: this.opts.retainBackups ?? 5,
    });
    runner.applyPending();
    this.loadCaches();
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.ownsDb) this.db.close();
  }

  private loadCaches(): void {
    const labels = this.db
      .prepare("SELECT label, table_name FROM _sfgraph_node_labels")
      .all() as Array<{ label: string; table_name: string }>;
    for (const row of labels) this.nodeLabelCache.set(row.label, row.table_name);
    const edges = this.db
      .prepare("SELECT rel_type, table_name FROM _sfgraph_edge_types")
      .all() as Array<{ rel_type: string; table_name: string }>;
    for (const row of edges) this.edgeRelCache.set(row.rel_type, row.table_name);
  }

  private ensureNodeTable(label: string): string {
    const cached = this.nodeLabelCache.get(label);
    if (cached) return cached;
    const tbl = nodeTableName(label);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${tbl} (
        org_id TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        attributes TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_modified_at INTEGER NOT NULL,
        PRIMARY KEY(org_id, qualified_name)
      );
      CREATE INDEX IF NOT EXISTS ${tbl}_org ON ${tbl}(org_id);
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO _sfgraph_node_labels(label, table_name, created_at) VALUES (?, ?, ?)",
      )
      .run(label, tbl, Date.now());
    this.nodeLabelCache.set(label, tbl);
    return tbl;
  }

  private ensureEdgeTable(relType: string): string {
    const cached = this.edgeRelCache.get(relType);
    if (cached) return cached;
    const tbl = edgeTableName(relType);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${tbl} (
        org_id TEXT NOT NULL,
        src_qname TEXT NOT NULL,
        dst_qname TEXT NOT NULL,
        attributes TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(org_id, src_qname, dst_qname)
      );
      CREATE INDEX IF NOT EXISTS ${tbl}_rev ON ${tbl}(org_id, dst_qname);
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO _sfgraph_edge_types(rel_type, table_name, created_at) VALUES (?, ?, ?)",
      )
      .run(relType, tbl, Date.now());
    this.edgeRelCache.set(relType, tbl);
    return tbl;
  }

  upsertOrg(org: Org): void {
    this.db
      .prepare(
        `INSERT INTO _sfgraph_orgs(id, alias, instance_url, api_version, created_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET alias=excluded.alias, instance_url=excluded.instance_url, api_version=excluded.api_version`,
      )
      .run(
        org.id,
        org.alias,
        org.instanceUrl,
        org.apiVersion,
        org.createdAt,
        org.lastSyncedAt ?? null,
      );
  }

  getOrg(id: OrgId): Org | null {
    const row = this.db
      .prepare(
        "SELECT id, alias, instance_url, api_version, created_at, last_synced_at FROM _sfgraph_orgs WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          alias: string;
          instance_url: string;
          api_version: string;
          created_at: number;
          last_synced_at: number | null;
        }
      | undefined;
    if (!row) return null;
    const org: Org = {
      id: asOrgId(row.id),
      alias: row.alias,
      instanceUrl: row.instance_url,
      apiVersion: row.api_version,
      createdAt: row.created_at,
    };
    if (row.last_synced_at != null) {
      org.lastSyncedAt = row.last_synced_at;
    }
    return org;
  }

  touchSync(orgId: OrgId, iso: string): void {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) {
      throw new StorageError(`touchSync: invalid ISO timestamp ${JSON.stringify(iso)}`);
    }
    this.db.prepare("UPDATE _sfgraph_orgs SET last_synced_at = ? WHERE id = ?").run(ts, orgId);
  }

  deleteNode(orgId: OrgId, qname: QualifiedName): void {
    const apply = this.db.transaction(() => {
      const idx = this.db
        .prepare("SELECT label FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name = ?")
        .get(orgId, qname) as { label: string } | undefined;
      if (idx) {
        const tbl = this.nodeLabelCache.get(idx.label);
        if (tbl) {
          this.db
            .prepare(`DELETE FROM ${tbl} WHERE org_id = ? AND qualified_name = ?`)
            .run(orgId, qname);
        }
        this.db
          .prepare("DELETE FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name = ?")
          .run(orgId, qname);
      }
    });
    apply();
  }

  deleteEdgesFor(orgId: OrgId, qname: QualifiedName): void {
    const apply = this.db.transaction(() => {
      for (const tbl of this.edgeRelCache.values()) {
        this.db
          .prepare(`DELETE FROM ${tbl} WHERE org_id = ? AND (src_qname = ? OR dst_qname = ?)`)
          .run(orgId, qname, qname);
      }
    });
    apply();
  }

  mergeNodes(facts: NodeFact[]): MergeResult {
    if (facts.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
    const buckets = new Map<string, NodeFact[]>();
    for (const f of facts) {
      validateLabel(f.label);
      const arr = buckets.get(f.label) ?? [];
      arr.push(f);
      buckets.set(f.label, arr);
    }
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const apply = this.db.transaction(() => {
      for (const [label, bucket] of buckets) {
        const tbl = this.ensureNodeTable(label);
        const selectStmt = this.db.prepare(
          `SELECT source_hash, first_seen_at FROM ${tbl} WHERE org_id = ? AND qualified_name = ?`,
        );
        const insertStmt = this.db.prepare(
          `INSERT INTO ${tbl}(org_id, qualified_name, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const updateChangedStmt = this.db.prepare(
          `UPDATE ${tbl} SET attributes = ?, source_hash = ?, last_seen_at = ?, last_modified_at = ? WHERE org_id = ? AND qualified_name = ?`,
        );
        const updateUnchangedStmt = this.db.prepare(
          `UPDATE ${tbl} SET last_seen_at = ? WHERE org_id = ? AND qualified_name = ?`,
        );
        const indexStmt = this.db.prepare(
          `INSERT INTO _sfgraph_node_index(org_id, qualified_name, label) VALUES (?, ?, ?)
           ON CONFLICT(org_id, qualified_name) DO UPDATE SET label=excluded.label`,
        );
        for (const fact of bucket) {
          const existing = selectStmt.get(fact.orgId, fact.qualifiedName) as
            | { source_hash: string; first_seen_at: number }
            | undefined;
          const attrsJson = JSON.stringify(fact.attributes);
          if (!existing) {
            insertStmt.run(
              fact.orgId,
              fact.qualifiedName,
              attrsJson,
              fact.sourceHash,
              fact.firstSeenAt,
              fact.lastSeenAt,
              fact.lastModifiedAt,
            );
            indexStmt.run(fact.orgId, fact.qualifiedName, label);
            inserted += 1;
          } else if (existing.source_hash !== fact.sourceHash) {
            updateChangedStmt.run(
              attrsJson,
              fact.sourceHash,
              fact.lastSeenAt,
              fact.lastModifiedAt,
              fact.orgId,
              fact.qualifiedName,
            );
            updated += 1;
          } else {
            updateUnchangedStmt.run(fact.lastSeenAt, fact.orgId, fact.qualifiedName);
            unchanged += 1;
          }
        }
      }
    });
    apply();
    return { inserted, updated, unchanged };
  }

  mergeEdges(facts: EdgeFact[]): MergeResult {
    if (facts.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
    const buckets = new Map<string, EdgeFact[]>();
    for (const f of facts) {
      validateRelType(f.relType);
      const arr = buckets.get(f.relType) ?? [];
      arr.push(f);
      buckets.set(f.relType, arr);
    }
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const apply = this.db.transaction(() => {
      for (const [relType, bucket] of buckets) {
        const tbl = this.ensureEdgeTable(relType);
        const selectStmt = this.db.prepare(
          `SELECT attributes, first_seen_at FROM ${tbl} WHERE org_id = ? AND src_qname = ? AND dst_qname = ?`,
        );
        const insertStmt = this.db.prepare(
          `INSERT INTO ${tbl}(org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const updateChangedStmt = this.db.prepare(
          `UPDATE ${tbl} SET attributes = ?, last_seen_at = ? WHERE org_id = ? AND src_qname = ? AND dst_qname = ?`,
        );
        const updateSeenStmt = this.db.prepare(
          `UPDATE ${tbl} SET last_seen_at = ? WHERE org_id = ? AND src_qname = ? AND dst_qname = ?`,
        );
        for (const fact of bucket) {
          const existing = selectStmt.get(
            fact.orgId,
            fact.srcQualifiedName,
            fact.dstQualifiedName,
          ) as { attributes: string; first_seen_at: number } | undefined;
          const attrsJson = JSON.stringify(fact.attributes);
          if (!existing) {
            insertStmt.run(
              fact.orgId,
              fact.srcQualifiedName,
              fact.dstQualifiedName,
              attrsJson,
              fact.firstSeenAt,
              fact.lastSeenAt,
            );
            inserted += 1;
          } else if (existing.attributes !== attrsJson) {
            updateChangedStmt.run(
              attrsJson,
              fact.lastSeenAt,
              fact.orgId,
              fact.srcQualifiedName,
              fact.dstQualifiedName,
            );
            updated += 1;
          } else {
            updateSeenStmt.run(
              fact.lastSeenAt,
              fact.orgId,
              fact.srcQualifiedName,
              fact.dstQualifiedName,
            );
            unchanged += 1;
          }
        }
      }
    });
    apply();
    return { inserted, updated, unchanged };
  }

  getNode(orgId: OrgId, qname: QualifiedName): NodeFact | null {
    const idx = this.db
      .prepare("SELECT label FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name = ?")
      .get(orgId, qname) as { label: string } | undefined;
    if (!idx) return null;
    const tbl = this.nodeLabelCache.get(idx.label);
    if (!tbl) return null;
    const row = this.db
      .prepare(
        `SELECT org_id, qualified_name, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at FROM ${tbl} WHERE org_id = ? AND qualified_name = ?`,
      )
      .get(orgId, qname) as RawNodeRow | undefined;
    if (!row) return null;
    return rowToNode(row, idx.label);
  }

  listNodesByLabel(orgId: OrgId, label: string, limit?: number): NodeFact[] {
    validateLabel(label);
    const tbl = this.nodeLabelCache.get(label);
    if (!tbl) return [];
    const sql = `SELECT org_id, qualified_name, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at FROM ${tbl} WHERE org_id = ?${typeof limit === "number" ? " LIMIT ?" : ""}`;
    const params: unknown[] = [orgId];
    if (typeof limit === "number") params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as RawNodeRow[];
    return rows.map((r) => rowToNode(r, label));
  }

  listEdgesFrom(orgId: OrgId, src: QualifiedName, relType?: RelType): EdgeFact[] {
    const out: EdgeFact[] = [];
    const types = relType ? [relType] : Array.from(this.edgeRelCache.keys());
    for (const t of types) {
      const tbl = this.edgeRelCache.get(t);
      if (!tbl) continue;
      const rows = this.db
        .prepare(
          `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND src_qname = ?`,
        )
        .all(orgId, src) as RawEdgeRow[];
      for (const r of rows) out.push(rowToEdge(r, t as RelType));
    }
    return out;
  }

  listEdgesTo(orgId: OrgId, dst: QualifiedName, relType?: RelType): EdgeFact[] {
    const out: EdgeFact[] = [];
    const types = relType ? [relType] : Array.from(this.edgeRelCache.keys());
    for (const t of types) {
      const tbl = this.edgeRelCache.get(t);
      if (!tbl) continue;
      const rows = this.db
        .prepare(
          `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND dst_qname = ?`,
        )
        .all(orgId, dst) as RawEdgeRow[];
      for (const r of rows) out.push(rowToEdge(r, t as RelType));
    }
    return out;
  }

  countNodes(orgId: OrgId): number {
    let total = 0;
    for (const tbl of this.nodeLabelCache.values()) {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${tbl} WHERE org_id = ?`).get(orgId) as
        | { c: number }
        | undefined;
      total += row?.c ?? 0;
    }
    return total;
  }

  countEdges(orgId: OrgId): number {
    let total = 0;
    for (const tbl of this.edgeRelCache.values()) {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${tbl} WHERE org_id = ?`).get(orgId) as
        | { c: number }
        | undefined;
      total += row?.c ?? 0;
    }
    return total;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // Helpers for shared usage
  getNodeLabelTables(): Map<string, string> {
    return new Map(this.nodeLabelCache);
  }

  getEdgeRelTables(): Map<string, string> {
    return new Map(this.edgeRelCache);
  }

  // For tests/diagnostics
  _explainReverseEdgeQuery(relType: RelType): string {
    const tbl = this.edgeRelCache.get(relType);
    if (!tbl) throw new StorageError(`unknown rel type ${relType}`);
    const rows = this.db
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${tbl} WHERE org_id = ? AND dst_qname = ?`)
      .all("o", "x") as Array<{ detail: string }>;
    return rows.map((r) => r.detail).join(" | ");
  }
}
