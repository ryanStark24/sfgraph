import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  ErrorCode,
  SfgraphError,
  StorageError,
  asQualifiedName,
} from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { validateLabel } from "../identifier.js";
import type {
  BetterSqlite3Database,
  BundleSearchHit,
  NodeSearchHit,
  VectorStore,
  VectorUpsertResult,
} from "../interfaces.js";
import { wrapAbiError } from "./load-better-sqlite3.js";
import { MIGRATIONS, MigrationRunner } from "./migrations.js";

export interface SqliteVectorStoreOptions {
  dbPath: string;
  dim?: number;
  backupDir?: string;
  retainBackups?: number;
  db?: BetterSqlite3Database;
  skipMigrations?: boolean;
}

export class SqliteVectorStore implements VectorStore {
  readonly db: BetterSqlite3Database;
  private readonly ownsDb: boolean;
  private readonly opts: SqliteVectorStoreOptions;
  private initialized = false;

  constructor(opts: SqliteVectorStoreOptions) {
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
    if (this.ownsDb) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("wal_autocheckpoint = 256");
    }
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
    // Make sure extension is loaded for query phase too (vec0 needs it on every connection).
    try {
      sqliteVec.load(this.db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only swallow the benign "already loaded" case. Anything else means
      // vec0 virtual tables won't work and the store would lie about being
      // initialized — surface that as E_VECTOR_EXTENSION so callers know.
      if (!/already/i.test(msg)) {
        throw new SfgraphError(
          ErrorCode.E_VECTOR_EXTENSION,
          `failed to load sqlite-vec extension: ${msg}`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.ownsDb) this.db.close();
  }

  private toBlob(vec: Float32Array): Buffer {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  }

  upsertNodeVector(
    orgId: OrgId,
    qname: QualifiedName,
    label: string,
    vector: Float32Array,
    contentHash: Sha256,
  ): VectorUpsertResult {
    validateLabel(label);
    const meta = this.db
      .prepare(
        "SELECT content_hash, vec_rowid FROM _sfgraph_node_vector_meta WHERE org_id = ? AND qualified_name = ?",
      )
      .get(orgId, qname) as { content_hash: string; vec_rowid: number } | undefined;
    if (meta && meta.content_hash === contentHash) {
      return { inserted: false, deduped: true };
    }
    const blob = this.toBlob(vector);
    const apply = this.db.transaction(() => {
      if (meta) {
        this.db.prepare("DELETE FROM _sfgraph_node_vectors WHERE rowid = ?").run(meta.vec_rowid);
      }
      const info = this.db
        .prepare("INSERT INTO _sfgraph_node_vectors(org_id, embedding) VALUES (?, ?)")
        .run(orgId, blob);
      const newRowid = Number(info.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO _sfgraph_node_vector_meta(org_id, qualified_name, content_hash, label, vec_rowid)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(org_id, qualified_name) DO UPDATE SET content_hash=excluded.content_hash, label=excluded.label, vec_rowid=excluded.vec_rowid`,
        )
        .run(orgId, qname, contentHash, label, newRowid);
    });
    apply();
    return { inserted: true, deduped: false };
  }

  upsertBundleVector(
    orgId: OrgId,
    bundleId: string,
    vector: Float32Array,
    contentHash: Sha256,
  ): VectorUpsertResult {
    const meta = this.db
      .prepare(
        "SELECT content_hash, vec_rowid FROM _sfgraph_bundle_vector_meta WHERE org_id = ? AND bundle_id = ?",
      )
      .get(orgId, bundleId) as { content_hash: string; vec_rowid: number } | undefined;
    if (meta && meta.content_hash === contentHash) {
      return { inserted: false, deduped: true };
    }
    const blob = this.toBlob(vector);
    const apply = this.db.transaction(() => {
      if (meta) {
        this.db.prepare("DELETE FROM _sfgraph_bundle_vectors WHERE rowid = ?").run(meta.vec_rowid);
      }
      const info = this.db
        .prepare("INSERT INTO _sfgraph_bundle_vectors(org_id, embedding) VALUES (?, ?)")
        .run(orgId, blob);
      const newRowid = Number(info.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO _sfgraph_bundle_vector_meta(org_id, bundle_id, content_hash, vec_rowid)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(org_id, bundle_id) DO UPDATE SET content_hash=excluded.content_hash, vec_rowid=excluded.vec_rowid`,
        )
        .run(orgId, bundleId, contentHash, newRowid);
    });
    apply();
    return { inserted: true, deduped: false };
  }

  searchNodes(
    orgId: OrgId,
    query: Float32Array,
    k: number,
    opts?: { label?: string },
  ): NodeSearchHit[] {
    if (k <= 0) return [];
    const blob = this.toBlob(query);
    let sql = `SELECT meta.qualified_name AS qname, meta.label AS label, vec.distance AS distance
               FROM _sfgraph_node_vectors AS vec
               JOIN _sfgraph_node_vector_meta AS meta ON meta.vec_rowid = vec.rowid
               WHERE vec.org_id = ? AND vec.embedding MATCH ? AND k = ?`;
    const params: unknown[] = [orgId, blob, k];
    if (opts?.label) {
      validateLabel(opts.label);
      sql += " AND meta.label = ?";
      params.push(opts.label);
    }
    sql += " ORDER BY vec.distance";
    const rows = this.db.prepare(sql).all(...params) as Array<{
      qname: string;
      label: string;
      distance: number;
    }>;
    return rows.map((r) => ({
      qname: asQualifiedName(r.qname),
      label: r.label,
      distance: r.distance,
    }));
  }

  searchBundles(orgId: OrgId, query: Float32Array, k: number): BundleSearchHit[] {
    if (k <= 0) return [];
    const blob = this.toBlob(query);
    const rows = this.db
      .prepare(
        `SELECT meta.bundle_id AS bundle_id, vec.distance AS distance
         FROM _sfgraph_bundle_vectors AS vec
         JOIN _sfgraph_bundle_vector_meta AS meta ON meta.vec_rowid = vec.rowid
         WHERE vec.org_id = ? AND vec.embedding MATCH ? AND k = ?
         ORDER BY vec.distance`,
      )
      .all(orgId, blob, k) as Array<{ bundle_id: string; distance: number }>;
    return rows.map((r) => ({ bundleId: r.bundle_id, distance: r.distance }));
  }

  countNodeVectors(orgId: OrgId): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM _sfgraph_node_vector_meta WHERE org_id = ?")
      .get(orgId) as { c: number } | undefined;
    if (!row) throw new StorageError("count query failed");
    return row.c;
  }

  /** Fetch a stored node embedding by (orgId, qname). The vec0 virtual
   *  table stores embeddings as BLOBs; the meta table maps to vec_rowid.
   *  We do the JOIN here so callers don't have to know the schema. */
  getNodeVector(orgId: OrgId, qname: QualifiedName): Float32Array | null {
    const row = this.db
      .prepare(
        `SELECT vec.embedding AS blob
         FROM _sfgraph_node_vectors AS vec
         JOIN _sfgraph_node_vector_meta AS meta ON meta.vec_rowid = vec.rowid
         WHERE meta.org_id = ? AND meta.qualified_name = ?
         LIMIT 1`,
      )
      .get(orgId, qname) as { blob: Buffer | Uint8Array } | undefined;
    if (!row?.blob) return null;
    // vec0 stores Float32Array as packed little-endian bytes. Wrap, don't
    // copy — caller treats the returned array as read-only.
    const buf = row.blob instanceof Buffer ? row.blob : Buffer.from(row.blob);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
}
