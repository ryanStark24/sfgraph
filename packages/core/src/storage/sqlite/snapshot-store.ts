import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { StorageError, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import type { EdgeFact, NodeFact, RelType, Snapshot } from "../../domain/index.js";
import type { BetterSqlite3Database, EdgeDiff, NodeDiff, SnapshotStore } from "../interfaces.js";
import { wrapAbiError } from "./load-better-sqlite3.js";
import { MIGRATIONS, MigrationRunner } from "./migrations.js";

export interface SqliteSnapshotStoreOptions {
  dbPath: string;
  backupDir?: string;
  retainBackups?: number;
  db?: BetterSqlite3Database;
  skipMigrations?: boolean;
}

interface RawSnapshotRow {
  id: string;
  org_id: string;
  label: string;
  created_at: number;
  is_auto: number;
}

interface NodeSnapshotRow {
  org_id: string;
  qualified_name: string;
  label: string;
  attributes: string;
  source_hash: string;
  first_seen_at: number;
  last_seen_at: number;
  last_modified_at: number;
}

interface EdgeSnapshotRow {
  org_id: string;
  src_qname: string;
  dst_qname: string;
  rel_type: string;
  attributes: string;
  first_seen_at: number;
  last_seen_at: number;
}

function snapshotFromRow(row: RawSnapshotRow): Snapshot {
  return {
    id: row.id,
    orgId: asOrgId(row.org_id),
    label: row.label,
    createdAt: row.created_at,
    isAuto: row.is_auto === 1,
  };
}

function nodeFromSnapshotRow(row: NodeSnapshotRow): NodeFact {
  return {
    orgId: asOrgId(row.org_id),
    qualifiedName: asQualifiedName(row.qualified_name),
    label: row.label,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    sourceHash: asSha256(row.source_hash),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastModifiedAt: row.last_modified_at,
  };
}

function edgeFromSnapshotRow(row: EdgeSnapshotRow): EdgeFact {
  return {
    orgId: asOrgId(row.org_id),
    srcQualifiedName: asQualifiedName(row.src_qname),
    dstQualifiedName: asQualifiedName(row.dst_qname),
    relType: row.rel_type as RelType,
    attributes: JSON.parse(row.attributes) as Record<string, unknown>,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export class SqliteSnapshotStore implements SnapshotStore {
  readonly db: BetterSqlite3Database;
  private readonly ownsDb: boolean;
  private readonly opts: SqliteSnapshotStoreOptions;
  private initialized = false;

  constructor(opts: SqliteSnapshotStoreOptions) {
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
    if (!this.opts.skipMigrations) {
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
    }
    this.initialized = true;
  }

  private getNodeLabelTables(): Map<string, string> {
    const out = new Map<string, string>();
    const rows = this.db
      .prepare("SELECT label, table_name FROM _sfgraph_node_labels")
      .all() as Array<{ label: string; table_name: string }>;
    for (const r of rows) out.set(r.label, r.table_name);
    return out;
  }

  private getEdgeRelTables(): Map<string, string> {
    const out = new Map<string, string>();
    const rows = this.db
      .prepare("SELECT rel_type, table_name FROM _sfgraph_edge_types")
      .all() as Array<{ rel_type: string; table_name: string }>;
    for (const r of rows) out.set(r.rel_type, r.table_name);
    return out;
  }

  createSnapshot(orgId: OrgId, label: string, isAuto: boolean): Snapshot {
    const id = `snap_${randomUUID()}`;
    const createdAt = Date.now();
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO _sfgraph_snapshots(id, org_id, label, created_at, is_auto) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, orgId, label, createdAt, isAuto ? 1 : 0);
      for (const [lbl, tbl] of this.getNodeLabelTables()) {
        this.db
          .prepare(
            `INSERT INTO _sfgraph_node_snapshots(snapshot_id, org_id, qualified_name, label, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at)
             SELECT ?, org_id, qualified_name, ?, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at FROM ${tbl} WHERE org_id = ?`,
          )
          .run(id, lbl, orgId);
      }
      for (const [rt, tbl] of this.getEdgeRelTables()) {
        this.db
          .prepare(
            `INSERT INTO _sfgraph_edge_snapshots(snapshot_id, org_id, src_qname, dst_qname, rel_type, attributes, first_seen_at, last_seen_at)
             SELECT ?, org_id, src_qname, dst_qname, ?, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ?`,
          )
          .run(id, rt, orgId);
      }
    });
    apply();
    return {
      id,
      orgId,
      label,
      createdAt,
      isAuto,
    };
  }

  listSnapshots(orgId: OrgId): Snapshot[] {
    const rows = this.db
      .prepare(
        "SELECT id, org_id, label, created_at, is_auto FROM _sfgraph_snapshots WHERE org_id = ? ORDER BY created_at DESC",
      )
      .all(orgId) as RawSnapshotRow[];
    return rows.map(snapshotFromRow);
  }

  getSnapshot(id: string): Snapshot | null {
    const row = this.db
      .prepare("SELECT id, org_id, label, created_at, is_auto FROM _sfgraph_snapshots WHERE id = ?")
      .get(id) as RawSnapshotRow | undefined;
    return row ? snapshotFromRow(row) : null;
  }

  deleteSnapshot(id: string): void {
    const apply = this.db.transaction(() => {
      this.db.prepare("DELETE FROM _sfgraph_node_snapshots WHERE snapshot_id = ?").run(id);
      this.db.prepare("DELETE FROM _sfgraph_edge_snapshots WHERE snapshot_id = ?").run(id);
      this.db.prepare("DELETE FROM _sfgraph_snapshots WHERE id = ?").run(id);
    });
    apply();
  }

  private readNodes(orgId: OrgId, src: string | "current"): Map<string, NodeFact> {
    const out = new Map<string, NodeFact>();
    if (src === "current") {
      for (const [lbl, tbl] of this.getNodeLabelTables()) {
        const rows = this.db
          .prepare(
            `SELECT org_id, qualified_name, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at FROM ${tbl} WHERE org_id = ?`,
          )
          .all(orgId) as Array<Omit<NodeSnapshotRow, "label">>;
        for (const r of rows) {
          const nf = nodeFromSnapshotRow({ ...r, label: lbl });
          out.set(nf.qualifiedName, nf);
        }
      }
    } else {
      const rows = this.db
        .prepare(
          "SELECT org_id, qualified_name, label, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at FROM _sfgraph_node_snapshots WHERE snapshot_id = ? AND org_id = ?",
        )
        .all(src, orgId) as NodeSnapshotRow[];
      for (const r of rows) {
        const nf = nodeFromSnapshotRow(r);
        out.set(nf.qualifiedName, nf);
      }
    }
    return out;
  }

  private readEdges(orgId: OrgId, src: string | "current"): Map<string, EdgeFact> {
    const out = new Map<string, EdgeFact>();
    const keyOf = (e: EdgeFact) => `${e.srcQualifiedName}|${e.dstQualifiedName}|${e.relType}`;
    if (src === "current") {
      for (const [rt, tbl] of this.getEdgeRelTables()) {
        const rows = this.db
          .prepare(
            `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ?`,
          )
          .all(orgId) as Array<Omit<EdgeSnapshotRow, "rel_type">>;
        for (const r of rows) {
          const e = edgeFromSnapshotRow({ ...r, rel_type: rt });
          out.set(keyOf(e), e);
        }
      }
    } else {
      const rows = this.db
        .prepare(
          "SELECT org_id, src_qname, dst_qname, rel_type, attributes, first_seen_at, last_seen_at FROM _sfgraph_edge_snapshots WHERE snapshot_id = ? AND org_id = ?",
        )
        .all(src, orgId) as EdgeSnapshotRow[];
      for (const r of rows) {
        const e = edgeFromSnapshotRow(r);
        out.set(keyOf(e), e);
      }
    }
    return out;
  }

  diffNodes(orgId: OrgId, fromId: string | "current", toId: string | "current"): NodeDiff {
    if (fromId !== "current" && !this.getSnapshot(fromId)) {
      throw new StorageError(`snapshot ${fromId} not found`);
    }
    if (toId !== "current" && !this.getSnapshot(toId)) {
      throw new StorageError(`snapshot ${toId} not found`);
    }
    const from = this.readNodes(orgId, fromId);
    const to = this.readNodes(orgId, toId);
    const added: NodeFact[] = [];
    const removed: NodeFact[] = [];
    const changed: Array<{ before: NodeFact; after: NodeFact }> = [];
    for (const [qn, t] of to) {
      const f = from.get(qn);
      if (!f) added.push(t);
      else if (f.sourceHash !== t.sourceHash) changed.push({ before: f, after: t });
    }
    for (const [qn, f] of from) {
      if (!to.has(qn)) removed.push(f);
    }
    return { added, removed, changed };
  }

  diffEdges(orgId: OrgId, fromId: string | "current", toId: string | "current"): EdgeDiff {
    if (fromId !== "current" && !this.getSnapshot(fromId)) {
      throw new StorageError(`snapshot ${fromId} not found`);
    }
    if (toId !== "current" && !this.getSnapshot(toId)) {
      throw new StorageError(`snapshot ${toId} not found`);
    }
    const from = this.readEdges(orgId, fromId);
    const to = this.readEdges(orgId, toId);
    const added: EdgeFact[] = [];
    const removed: EdgeFact[] = [];
    for (const [k, t] of to) if (!from.has(k)) added.push(t);
    for (const [k, f] of from) if (!to.has(k)) removed.push(f);
    return { added, removed };
  }

  prune(orgId: OrgId, retainDays: number): number {
    const cutoff = Date.now() - retainDays * 86_400_000;
    const ids = this.db
      .prepare(
        "SELECT id FROM _sfgraph_snapshots WHERE org_id = ? AND is_auto = 1 AND created_at < ?",
      )
      .all(orgId, cutoff) as Array<{ id: string }>;
    for (const { id } of ids) this.deleteSnapshot(id);
    return ids.length;
  }
}

// Avoid unused-import false positive for QualifiedName/Sha256 in some toolchains
export type { QualifiedName, Sha256 };
