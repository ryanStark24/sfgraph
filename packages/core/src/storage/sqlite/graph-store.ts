import { mkdirSync } from "node:fs";
import path from "node:path";
import { StorageError, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import type { EdgeFact, NodeFact, Org, RelType } from "../../domain/index.js";
import { edgeTableName, nodeTableName, validateLabel, validateRelType } from "../identifier.js";
import type {
  BetterSqlite3Database,
  GraphStore,
  MergeResult,
  SnippetRecord,
  SnippetSourceFormat,
  SnippetUpsertResult,
} from "../interfaces.js";
import { wrapAbiError } from "./load-better-sqlite3.js";
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
  private closed = false;

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
      try {
        this.db = new Database(opts.dbPath);
      } catch (e) {
        const wrapped = wrapAbiError(e);
        if (wrapped) throw wrapped;
        throw e;
      }
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
    // Smaller WAL auto-checkpoint threshold (default 1000 pages = ~4MB).
    // With large ingests producing 10-20K inserts during the object phase,
    // the WAL hits the default threshold right around the 30-second mark
    // and triggers one big checkpoint inside the native binding. Under
    // sustained write pressure that checkpoint has been observed to
    // silently abort the process on macOS 26+ (no JS handler can intercept
    // — the binding terminates natively). 256 pages = ~1MB per checkpoint:
    // each checkpoint completes in <50ms, runs more frequently, and never
    // accumulates the page-lock pressure of a single multi-MB flush.
    this.db.pragma("wal_autocheckpoint = 256");
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

  /**
   * Flush WAL to the main DB file with a PASSIVE checkpoint. Cheap (no
   * locking against readers) and lets the auto-checkpoint mechanism stay
   * ahead of write pressure. Callers should invoke this at major phase
   * boundaries (between extractors, before long-running parses) so the
   * WAL never grows beyond a few hundred pages.
   *
   * Returns true if checkpoint succeeded, false on any error (best-effort).
   */
  checkpoint(): boolean {
    if (this.closed) return false;
    try {
      this.db.pragma("wal_checkpoint(PASSIVE)");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) {
      try {
        // Final TRUNCATE checkpoint on close: flushes WAL fully and
        // truncates the WAL file to zero. Without this the .sqlite-wal
        // sidecar can persist between runs at multi-MB size.
        try {
          this.db.pragma("wal_checkpoint(TRUNCATE)");
        } catch {
          /* ignore — close still proceeds */
        }
        this.db.close();
      } catch {
        // already closed by another path — idempotent
      }
    }
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

  listEdgesByDstLike(
    orgId: OrgId,
    pattern: string,
    relType?: RelType,
    limit?: number,
  ): EdgeFact[] {
    const out: EdgeFact[] = [];
    const types = relType ? [relType] : Array.from(this.edgeRelCache.keys());
    const cap = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;
    for (const t of types) {
      if (out.length >= cap) break;
      const tbl = this.edgeRelCache.get(t);
      if (!tbl) continue;
      const remaining = Number.isFinite(cap) ? cap - out.length : -1;
      const sql = remaining > 0
        ? `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND dst_qname LIKE ? LIMIT ${remaining}`
        : `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND dst_qname LIKE ?`;
      const rows = this.db.prepare(sql).all(orgId, pattern) as RawEdgeRow[];
      for (const r of rows) out.push(rowToEdge(r, t as RelType));
    }
    return out;
  }

  deleteEdge(
    orgId: OrgId,
    src: QualifiedName,
    dst: QualifiedName,
    relType: RelType,
  ): void {
    const tbl = this.edgeRelCache.get(relType);
    if (!tbl) return;
    this.db
      .prepare(`DELETE FROM ${tbl} WHERE org_id = ? AND src_qname = ? AND dst_qname = ?`)
      .run(orgId, src, dst);
  }

  /**
   * Edges whose `dst_qname` has no matching row in `_sfgraph_node_index`.
   * Iterates every known edge table and LEFT JOINs against the node index;
   * surfaces stranded edges left behind by extractors that emit speculative
   * QName targets (e.g. `ApexMethod:Foo.bar(?)`, `Remote:unknown`, dotted
   * field refs whose CustomObject wasn't ingested).
   */
  listDanglingEdges(orgId: OrgId, limit?: number): EdgeFact[] {
    const out: EdgeFact[] = [];
    const cap = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;
    for (const [relType, tbl] of this.edgeRelCache) {
      if (out.length >= cap) break;
      const remaining = Number.isFinite(cap) ? cap - out.length : -1;
      const limitClause = remaining > 0 ? `LIMIT ${remaining}` : "";
      const rows = this.db
        .prepare(
          `SELECT e.org_id, e.src_qname, e.dst_qname, e.attributes, e.first_seen_at, e.last_seen_at
           FROM ${tbl} e
           LEFT JOIN _sfgraph_node_index n
             ON n.org_id = e.org_id AND n.qualified_name = e.dst_qname
           WHERE e.org_id = ? AND n.qualified_name IS NULL
           ${limitClause}`,
        )
        .all(orgId) as RawEdgeRow[];
      for (const r of rows) out.push(rowToEdge(r, relType as RelType));
    }
    return out;
  }

  /**
   * Return every qualified name persisted for `orgId` across all label tables.
   * Used by full-sync deletion detection to compute the difference between
   * what was previously known and what the current sync touched.
   */
  listAllQnames(orgId: OrgId): QualifiedName[] {
    const out: QualifiedName[] = [];
    for (const tbl of this.nodeLabelCache.values()) {
      const rows = this.db
        .prepare(`SELECT qualified_name FROM ${tbl} WHERE org_id = ?`)
        .all(orgId) as Array<{ qualified_name: string }>;
      for (const r of rows) out.push(r.qualified_name as QualifiedName);
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

  upsertSnippet(rec: SnippetRecord): SnippetUpsertResult {
    const existing = this.db
      .prepare("SELECT source_hash FROM _sfgraph_snippets WHERE org_id = ? AND qualified_name = ?")
      .get(rec.orgId, rec.qualifiedName) as { source_hash: string } | undefined;
    if (existing && existing.source_hash === rec.sourceHash) {
      return { inserted: false, updated: false, unchanged: true };
    }
    if (existing) {
      this.db
        .prepare(
          `UPDATE _sfgraph_snippets
             SET source_format = ?, source_text = ?, start_line = ?, end_line = ?,
                 source_hash = ?, llm_explanation = NULL, explained_at = NULL
           WHERE org_id = ? AND qualified_name = ?`,
        )
        .run(
          rec.sourceFormat,
          rec.sourceText,
          rec.startLine ?? null,
          rec.endLine ?? null,
          rec.sourceHash,
          rec.orgId,
          rec.qualifiedName,
        );
      return { inserted: false, updated: true, unchanged: false };
    }
    this.db
      .prepare(
        `INSERT INTO _sfgraph_snippets
           (org_id, qualified_name, source_format, source_text, start_line, end_line, source_hash, llm_explanation, explained_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.orgId,
        rec.qualifiedName,
        rec.sourceFormat,
        rec.sourceText,
        rec.startLine ?? null,
        rec.endLine ?? null,
        rec.sourceHash,
        rec.llmExplanation ?? null,
        rec.explainedAt ?? null,
      );
    return { inserted: true, updated: false, unchanged: false };
  }

  getSnippet(orgId: OrgId, qname: QualifiedName): SnippetRecord | null {
    const row = this.db
      .prepare(
        `SELECT org_id, qualified_name, source_format, source_text, start_line, end_line,
                source_hash, llm_explanation, explained_at
           FROM _sfgraph_snippets WHERE org_id = ? AND qualified_name = ?`,
      )
      .get(orgId, qname) as
      | {
          org_id: string;
          qualified_name: string;
          source_format: string;
          source_text: string;
          start_line: number | null;
          end_line: number | null;
          source_hash: string;
          llm_explanation: string | null;
          explained_at: number | null;
        }
      | undefined;
    if (!row) return null;
    const rec: SnippetRecord = {
      orgId: asOrgId(row.org_id),
      qualifiedName: asQualifiedName(row.qualified_name),
      sourceFormat: row.source_format as SnippetSourceFormat,
      sourceText: row.source_text,
      sourceHash: asSha256(row.source_hash),
    };
    if (row.start_line != null) rec.startLine = row.start_line;
    if (row.end_line != null) rec.endLine = row.end_line;
    if (row.llm_explanation != null) rec.llmExplanation = row.llm_explanation;
    if (row.explained_at != null) rec.explainedAt = row.explained_at;
    return rec;
  }

  updateSnippetExplanation(
    orgId: OrgId,
    qname: QualifiedName,
    llmExplanation: string,
    explainedAt: number,
  ): boolean {
    const r = this.db
      .prepare(
        `UPDATE _sfgraph_snippets
            SET llm_explanation = ?, explained_at = ?
          WHERE org_id = ? AND qualified_name = ?`,
      )
      .run(llmExplanation, explainedAt, orgId, qname);
    return r.changes > 0;
  }

  listSnippetsMissingExplanation(orgId: OrgId, limit?: number): SnippetRecord[] {
    const sql = `SELECT org_id, qualified_name, source_format, source_text, start_line, end_line,
                        source_hash, llm_explanation, explained_at
                   FROM _sfgraph_snippets
                  WHERE org_id = ? AND llm_explanation IS NULL${
                    typeof limit === "number" ? " LIMIT ?" : ""
                  }`;
    const params: unknown[] = [orgId];
    if (typeof limit === "number") params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      org_id: string;
      qualified_name: string;
      source_format: string;
      source_text: string;
      start_line: number | null;
      end_line: number | null;
      source_hash: string;
      llm_explanation: string | null;
      explained_at: number | null;
    }>;
    return rows.map((row) => {
      const rec: SnippetRecord = {
        orgId: asOrgId(row.org_id),
        qualifiedName: asQualifiedName(row.qualified_name),
        sourceFormat: row.source_format as SnippetSourceFormat,
        sourceText: row.source_text,
        sourceHash: asSha256(row.source_hash),
      };
      if (row.start_line != null) rec.startLine = row.start_line;
      if (row.end_line != null) rec.endLine = row.end_line;
      return rec;
    });
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
