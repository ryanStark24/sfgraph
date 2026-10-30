import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { StorageError, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import type { EdgeFact, NodeFact, Org, RelType } from "../../domain/index.js";
import { splitIdentifierWords } from "../../embedding/tokenize.js";
import { isThisHost, ownStartMs, ownerIsStale, thisHost } from "../../util/process-owner.js";
import { edgeTableName, nodeTableName, validateLabel, validateRelType } from "../identifier.js";
import type {
  ApexFrameCandidate,
  BetterSqlite3Database,
  DanglingEdgeRow,
  GraphStore,
  MemberRow,
  MergeEdgesOptions,
  MergeResult,
  SnippetRecord,
  SnippetSourceFormat,
  SnippetUpsertResult,
  SyncStatus,
} from "../interfaces.js";
import { wrapAbiError } from "./load-better-sqlite3.js";
import { MIGRATIONS, MigrationRunner } from "./migrations.js";

/**
 * Plain (non-vec0) tables holding derived data keyed by (org_id, qualified_name).
 * Purged in deleteNode so a removed node leaves no orphan rows. The vec0 vector
 * table is NOT here — it needs the sqlite-vec extension and is purged via the
 * VectorStore. Snapshot tables are intentionally excluded (point-in-time
 * history must survive a node's deletion).
 */
const DERIVED_QNAME_TABLES = [
  "_sfgraph_apex_frame_index",
  "_sfgraph_snippets",
  "_sfgraph_governor_risks",
  "_sfgraph_findings",
  "_sfgraph_dead_code_scores",
  "_sfgraph_test_coverage",
] as const;
// _sfgraph_node_fts is also derived per-qname, but its key columns are FTS5
// UNINDEXED (a WHERE on them scans the whole table), so it is purged by rowid
// through _sfgraph_node_fts_rowid instead — see deleteNodeFts.

/** How long a write waits for another connection's lock (rel-05). */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * Page cache per connection, in KiB (`cache_size = -N`). Was 200 MB: whole-graph
 * phases (resolvers, audit, deadcode) fill it on a large org DB (1.4 GB), and
 * the pages stay resident. 64 MB kept a large Vlocity repo rebuild's wall time
 * unchanged (3 interleaved runs each: 55.0 s at 200 MB vs 53.1 s).
 */
export const SQLITE_CACHE_SIZE_KIB = 64_000;

/** Memory-mapped I/O window per connection, in bytes (was 256 MiB; same measurement). */
export const SQLITE_MMAP_SIZE_BYTES = 64 * 1024 * 1024;

/** Members per bulk transaction (beginBulk/endBulk). */
export const BULK_TXN_MEMBERS = 2000;

/**
 * Live-graph write batches (beginBatch): members per transaction, and the
 * longest one transaction holds the write lock. A non-rebuild ingest writes
 * into a graph that MCP servers may be reading (and, rarely, writing): readers
 * are never blocked in WAL mode, and another writer waits at most about this
 * long, far inside BUSY_TIMEOUT_MS.
 */
export const BATCH_TXN_MEMBERS = 250;
export const BATCH_TXN_MAX_MS = 200;

/** Edge tables per UNION ALL statement (SQLite's default compound-SELECT cap is 500). */
const MAX_UNION_ARMS = 200;

/** Unit separator; cannot occur in a qname or org id. */
const KSEP = String.fromCharCode(31);

/** Canonical secondary-index DDL of a node / edge table. The single source for
 *  ensureNodeTable / ensureEdgeTable and the post-crash heal in init(), so a
 *  healed index has byte-identical sqlite_master SQL (SQLite stores it without
 *  the IF NOT EXISTS and the trailing semicolon). */
function nodeIndexDdl(tbl: string): string {
  return `CREATE INDEX IF NOT EXISTS ${tbl}_org ON ${tbl}(org_id);`;
}
function edgeIndexDdl(tbl: string): string {
  return `CREATE INDEX IF NOT EXISTS ${tbl}_rev ON ${tbl}(org_id, dst_qname);`;
}

/** Durable marker of an open bulk window (one row). Written before any DROP
 *  INDEX and cleared only once endBulk has rebuilt the indexes, so a process
 *  that dies inside the window is detected and healed by the next init(). */
const BULK_MARKER_DDL = `CREATE TABLE IF NOT EXISTS _sfgraph_bulk_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  host TEXT
)`;

/** Task 11c: a node's source_hash and last_modified_at. */
export interface NodeStamp {
  hash: string;
  lastModifiedAt: number;
}

/** Task 11c: an edge removed by deleteEdgesFrom. */
export interface DeletedEdge {
  relType: string;
  src: string;
  dst: string;
  firstSeenAt: number;
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** ASCII-only lowercase — exactly what SQLite's NOCASE collation folds. */
function nocaseKey(s: string): string {
  // toLowerCase is exactly the ASCII fold on an ASCII-only string (the common
  // case, and ~10x cheaper than a replace callback); non-ASCII letters must
  // stay as they are, so those strings fold A-Z only.
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  }
  return s.toLowerCase();
}

/** Parse the qnames emitted by the Apex parsers into Salesforce stack-frame keys. */
function apexFrameKey(
  qname: string,
):
  | { frameKind: "class"; ownerName: string; memberName: string }
  | { frameKind: "trigger"; ownerName: string; memberName?: undefined }
  | null {
  // Greedy owner capture deliberately leaves the final dot-separated segment
  // as the method, preserving inner classes such as Outer.Inner.run(0).
  const method = /^ApexMethod:(.+)\.([^.()]+)\(\d+\)$/i.exec(qname);
  if (method) return { frameKind: "class", ownerName: method[1]!, memberName: method[2]! };
  const trigger = /^ApexTrigger:(.+)$/i.exec(qname);
  if (trigger) return { frameKind: "trigger", ownerName: trigger[1]! };
  return null;
}

export interface BeginBulkOptions {
  /**
   * The org being rebuilt. When the store confirms this org has no nodes,
   * edges or FTS rows at beginBulk, per-member delete probes are skipped for
   * keys not yet written during the bulk window (nothing can exist to delete).
   * Keys written earlier in the same window are still reconciled, so the
   * result is identical to the slow path.
   */
  freshOrgId?: OrgId;
  /**
   * Hold one write transaction per BULK_TXN_MEMBERS members. Default true.
   * Turn off when another connection must write to the same file during the
   * bulk window (it would hit SQLITE_BUSY behind the open transaction).
   */
  batchTransactions?: boolean;
}

export interface BulkStats {
  active: boolean;
  fresh: boolean;
  members: number;
  /** Reconcile sources whose prior-edge probe was skipped (fresh org, first write). */
  reconcileSkipped: number;
  /** Reconcile sources that were probed (already written in this window, or not fresh). */
  reconcileProbed: number;
  /** FTS upserts that skipped the prior-row lookup/delete (fresh org, first write). */
  ftsDeleteSkipped: number;
}

interface BulkState {
  freshOrg: string | null;
  batchTxn: boolean;
  members: number;
  /** org|nocase(src) for every edge source written in this window. */
  edgeSrcs: Set<string>;
  /** org|qname (binary) for every FTS doc written in this window. */
  ftsKeys: Set<string>;
  /** Secondary-index CREATE statements to (re)run at endBulk, in order. */
  deferredIndexes: Array<{ name: string; table: string; sql: string }>;
  stats: BulkStats;
}

export interface BeginBatchOptions {
  /** Members per transaction. Default BATCH_TXN_MEMBERS. */
  maxMembers?: number;
  /** Commit once a transaction has been open this long (ms). Default BATCH_TXN_MAX_MS. */
  maxMs?: number;
}

export interface BatchStats {
  active: boolean;
  members: number;
  commits: number;
  /** batchMemberStart could not take the write lock; that member ran per statement. */
  beginFailures: number;
}

interface BatchState {
  maxMembers: number;
  maxMs: number;
  /** A BEGIN IMMEDIATE issued by this window is open. */
  open: boolean;
  openedAt: number;
  inTxn: number;
  timer: ReturnType<typeof setTimeout> | null;
  stats: BatchStats;
}

export interface SqliteGraphStoreOptions {
  dbPath: string;
  backupDir?: string;
  retainBackups?: number;
  db?: BetterSqlite3Database; // for sharing with VectorStore/SnapshotStore
  /**
   * Min ms between dev/ino checks of dbPath for a rebuild file swap (review
   * I2). Default 1000; 0 checks on every read; negative disables the check
   * (the MCP server handles swaps itself by evicting the whole context).
   */
  fileCheckIntervalMs?: number;
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

/** A prior outgoing edge read by mergeEdges' reconcile (t = edge-table index). */
interface PriorEdgeRow {
  t: number;
  id: number;
  s: string;
  d: string;
  a: string;
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

/**
 * rel-02: `ownerIsStale` may spawn `ps` to rule out pid reuse; readers call
 * getSyncStatus on every MCP tool call, so verdicts are memoised briefly per
 * recorded owner. A dead owner never comes back, so a stale verdict is final.
 */
const SYNC_OWNER_TTL_MS = 30_000;
const syncOwnerVerdicts = new Map<string, { stale: boolean; at: number }>();
function syncOwnerIsStale(pid: number, host: string | null, startMs: number | null): boolean {
  if (pid === process.pid && isThisHost(host)) return false;
  const key = `${host ?? ""}|${pid}|${startMs ?? ""}`;
  const now = Date.now();
  const hit = syncOwnerVerdicts.get(key);
  if (hit && (hit.stale || now - hit.at < SYNC_OWNER_TTL_MS)) return hit.stale;
  const stale = ownerIsStale({ pid, host, procStartMs: startMs });
  if (syncOwnerVerdicts.size > 256) syncOwnerVerdicts.clear();
  syncOwnerVerdicts.set(key, { stale, at: now });
  return stale;
}

export type GraphFileReadiness = { ready: true } | { ready: false; reason: string };

/**
 * review R1-1: whether the graph file at `dbPath` is a finished build that a
 * reader may switch to. `ingest --rebuild` creates the new file at dbPath and
 * fills it for minutes (indexes dropped until endBulk), so a reader that sees
 * a new inode must keep its old connection until the new file:
 *  - has no bulk-load window whose owner is alive,
 *  - has an `_sfgraph_orgs` row (for `orgId`, or every row when omitted), and
 *    each such row has a completed sync (`last_synced_at`) and is not in
 *    progress with a live owner (same rule as getSyncStatus, rel-02).
 * Opens the file read-only and never writes.
 */
export function graphFileReadiness(dbPath: string, orgId?: string): GraphFileReadiness {
  let db: BetterSqlite3Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return { ready: false, reason: "the file cannot be opened" };
  }
  try {
    const has = (t: string) =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !==
      undefined;
    if (has("_sfgraph_bulk_window")) {
      const m = db.prepare("SELECT * FROM _sfgraph_bulk_window WHERE id = 1").get() as
        | { pid: number; host?: string | null; started_at?: number | null }
        | undefined;
      if (m) {
        const marker = { pid: m.pid, host: m.host ?? null, takenAtMs: m.started_at ?? null };
        const ours = m.pid === process.pid && isThisHost(marker.host);
        if (ours || !ownerIsStale(marker))
          return { ready: false, reason: "a bulk load is running" };
      }
    }
    if (!has("_sfgraph_orgs")) return { ready: false, reason: "no _sfgraph_orgs table" };
    const rows = (
      orgId === undefined
        ? db.prepare("SELECT * FROM _sfgraph_orgs").all()
        : db.prepare("SELECT * FROM _sfgraph_orgs WHERE id = ?").all(orgId)
    ) as Array<{
      last_synced_at?: number | null;
      sync_in_progress?: number | null;
      sync_owner_pid?: number | null;
      sync_owner_host?: string | null;
      sync_owner_start_ms?: number | null;
    }>;
    if (rows.length === 0) return { ready: false, reason: "no org row yet" };
    for (const r of rows) {
      if (r.last_synced_at == null) return { ready: false, reason: "no completed sync" };
      if (
        r.sync_in_progress === 1 &&
        (r.sync_owner_pid == null ||
          !syncOwnerIsStale(
            r.sync_owner_pid,
            r.sync_owner_host ?? null,
            r.sync_owner_start_ms ?? null,
          ))
      ) {
        return { ready: false, reason: "a sync is in progress" };
      }
    }
    return { ready: true };
  } catch {
    return { ready: false, reason: "the file is not readable yet" };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

export class SqliteGraphStore implements GraphStore {
  private conn: BetterSqlite3Database;
  /** Connections replaced after a file swap; closed with the store (review I2). */
  private readonly retired: BetterSqlite3Database[] = [];
  /** `dev:ino` of dbPath for the open connection; null when not file-backed. */
  private fileId: string | null = null;
  private lastFileCheck = 0;
  private readonly ownsDb: boolean;
  private readonly opts: SqliteGraphStoreOptions;
  private nodeLabelCache: Map<string, string> = new Map();
  private edgeRelCache: Map<string, string> = new Map();
  /** `PRAGMA data_version` when the caches were last loaded (rel-01). */
  private dataVersion = -1;
  private initialized = false;
  private closed = false;
  private bulk: BulkState | null = null;
  private batch: BatchState | null = null;
  /** edgesAllTables' SQL per column, for the current edge tables. */
  private readonly unionEdgeQueries: Partial<
    Record<
      "src_qname" | "dst_qname",
      { map: Map<string, string>; size: number; rels: RelType[]; sqls: string[] }
    >
  > = {};
  /** priorOutgoingEdges' SQL for the current edge tables. */
  private priorEdgesQuery: {
    map: Map<string, string>;
    size: number;
    rels: string[];
    sqls: string[];
  } | null = null;
  private readonly stmtCache = new Map<string, Database.Statement<unknown[]>>();
  private ftsUpsertTx:
    | ((orgId: string, qname: string, label: string, body: string) => void)
    | null = null;

  constructor(opts: SqliteGraphStoreOptions) {
    this.opts = opts;
    if (opts.db) {
      this.conn = opts.db;
      this.ownsDb = false;
    } else {
      if (opts.dbPath !== ":memory:") {
        const dir = path.dirname(opts.dbPath);
        if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
      }
      try {
        this.conn = new Database(opts.dbPath);
      } catch (e) {
        const wrapped = wrapAbiError(e);
        if (wrapped) throw wrapped;
        throw e;
      }
      this.ownsDb = true;
    }
  }

  get db(): BetterSqlite3Database {
    return this.conn;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.fileId = this.readFileId();
    this.setupConnection();
    this.loadCaches();
    this.healBulkWindow();
    this.initialized = true;
  }

  /** Pragmas + pending migrations for a freshly opened connection. */
  private setupConnection(): void {
    // rel-05: explicit, not better-sqlite3's implicit default. A write that
    // still finds the lock held after this throws SQLITE_BUSY.
    this.db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma(`mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.pragma(`cache_size = -${SQLITE_CACHE_SIZE_KIB}`);
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
  }

  private readFileId(): string | null {
    if (!this.ownsDb || this.opts.dbPath === ":memory:") return null;
    try {
      const st = statSync(this.opts.dbPath);
      return `${st.dev}:${st.ino}`;
    } catch {
      return null;
    }
  }

  /**
   * review I2: `ingest --rebuild` renames dbPath away and builds a new file.
   * This connection still holds the old inode, whose data_version never
   * changes again, so compare dbPath's dev/ino and reopen when it differs.
   * The old connection stays open until close(): other holders (shared
   * snapshot/vector stores) may still have statements on it.
   */
  private checkFileSwap(): void {
    if (this.fileId === null) return;
    const every = this.opts.fileCheckIntervalMs ?? 1000;
    if (every < 0) return;
    const now = Date.now();
    if (every > 0 && now - this.lastFileCheck < every) return;
    this.lastFileCheck = now;
    if (this.bulk || this.batch || this.conn.inTransaction) return;
    const id = this.readFileId();
    if (id === null || id === this.fileId) return;
    // review R1-1: keep serving the old (complete) graph until the new file's
    // build has finished; the old inode stays readable after rename/unlink.
    if (!graphFileReadiness(this.opts.dbPath).ready) return;
    let next: BetterSqlite3Database;
    try {
      next = new Database(this.opts.dbPath);
    } catch {
      return; // mid-swap; retry on a later read
    }
    const prev = this.conn;
    this.conn = next;
    this.stmtCache.clear();
    this.ftsUpsertTx = null;
    try {
      this.setupConnection();
      this.loadCaches();
    } catch {
      // e.g. the rebuild still holds the write lock: keep the old graph for now.
      this.conn = prev;
      this.stmtCache.clear();
      try {
        next.close();
      } catch {
        /* ignore */
      }
      this.loadCaches();
      return;
    }
    this.retired.push(prev);
    this.fileId = id;
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
    if (this.bulk) {
      try {
        this.endBulk();
      } catch {
        /* best-effort; the next init() heals any missing indexes */
      }
    }
    if (this.batch) {
      try {
        this.endBatch();
      } catch {
        /* best-effort */
      }
    }
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
      for (const old of this.retired.splice(0)) {
        try {
          old.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  private loadCaches(): void {
    const labels = this.stmt("SELECT label, table_name FROM _sfgraph_node_labels").all() as Array<{
      label: string;
      table_name: string;
    }>;
    const nodeLabels = new Map<string, string>();
    for (const row of labels) nodeLabels.set(row.label, row.table_name);
    const edges = this.stmt("SELECT rel_type, table_name FROM _sfgraph_edge_types").all() as Array<{
      rel_type: string;
      table_name: string;
    }>;
    const edgeRels = new Map<string, string>();
    for (const row of edges) edgeRels.set(row.rel_type, row.table_name);
    this.nodeLabelCache = nodeLabels;
    this.edgeRelCache = edgeRels;
    this.dataVersion = this.readDataVersion();
  }

  private readDataVersion(): number {
    return (this.stmt("PRAGMA data_version").get() as { data_version: number }).data_version;
  }

  /**
   * rel-01: the label / rel-type registries can grow under a long-lived
   * reader (an ingest in another process creates a new node or edge table).
   * `PRAGMA data_version` changes only when ANOTHER connection commits, so
   * this is one cheap read per call and a reload only after a foreign write.
   * Writes through this connection keep the caches current themselves.
   */
  private syncCaches(): void {
    if (this.closed) return;
    this.checkFileSwap();
    if (this.readDataVersion() !== this.dataVersion) this.loadCaches();
  }

  /** Cached prepared statement (re-preparing per call cost ~14 s per full ingest). */
  private stmt(sql: string): Database.Statement<unknown[]> {
    let st = this.stmtCache.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmtCache.set(sql, st);
    }
    return st;
  }

  /** Run a table's secondary-index DDL now, or defer it to endBulk. */
  private createIndex(name: string, table: string, sql: string): void {
    if (this.bulk) {
      this.bulk.deferredIndexes.push({ name, table, sql });
      return;
    }
    this.db.exec(sql);
  }

  private ensureNodeTable(label: string): string {
    const cached = this.nodeLabelCache.get(label);
    if (cached) return cached;
    const tbl = nodeTableName(label);
    // qualified_name is COLLATE NOCASE: Salesforce API names are case-insensitive
    // (Account == account), so the PK dedups and all `= ?` lookups fold case while
    // the original display string is preserved. See migration 9.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${tbl} (
        org_id TEXT NOT NULL,
        qualified_name TEXT NOT NULL COLLATE NOCASE,
        attributes TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        last_modified_at INTEGER NOT NULL,
        PRIMARY KEY(org_id, qualified_name)
      );
    `);
    this.createIndex(`${tbl}_org`, tbl, nodeIndexDdl(tbl));
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
    // src/dst qnames COLLATE NOCASE so a reference's case (e.g. SOQL `from
    // account`) matches the definition node's qname and edges dedup/join
    // case-insensitively. See migration 9.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${tbl} (
        org_id TEXT NOT NULL,
        src_qname TEXT NOT NULL COLLATE NOCASE,
        dst_qname TEXT NOT NULL COLLATE NOCASE,
        attributes TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(org_id, src_qname, dst_qname)
      );
    `);
    this.createIndex(`${tbl}_rev`, tbl, edgeIndexDdl(tbl));
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

  // ─── W1.5-08: sync-generation lifecycle ────────────────────────────────────
  // Three helpers (started / complete / failed) plus a getter. The shape is
  // designed so concurrent MCP readers can answer "is the graph being
  // rewritten right now?" cheaply (one SELECT) without taking a global lock.
  // Generation only advances on success — failed ingests are invisible to
  // the counter, matching how readers would expect "the graph has been
  // updated" to be a synonym of "an ingest completed cleanly".

  markSyncStarted(orgId: OrgId, startedAtIso: string): void {
    // Validate the ISO early — better to fail loud at start than to write a
    // garbage timestamp and confuse the staleness block readers see.
    if (!Number.isFinite(Date.parse(startedAtIso))) {
      throw new StorageError(
        `markSyncStarted: invalid ISO timestamp ${JSON.stringify(startedAtIso)}`,
      );
    }
    // rel-02: record the owner so a reader can tell this run from one that
    // was killed without clearing the flag.
    this.db
      .prepare(
        `UPDATE _sfgraph_orgs
            SET sync_in_progress = 1, sync_started_at = ?,
                sync_owner_pid = ?, sync_owner_host = ?, sync_owner_start_ms = ?
          WHERE id = ?`,
      )
      .run(startedAtIso, process.pid, thisHost(), ownStartMs(), orgId);
  }

  markSyncComplete(orgId: OrgId, completedAtIso: string): void {
    const ts = Date.parse(completedAtIso);
    if (!Number.isFinite(ts)) {
      throw new StorageError(
        `markSyncComplete: invalid ISO timestamp ${JSON.stringify(completedAtIso)}`,
      );
    }
    // Single transaction so concurrent readers never observe a half-applied
    // state (e.g. generation incremented but in_progress still 1).
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE _sfgraph_orgs
             SET sync_generation = sync_generation + 1,
                 sync_in_progress = 0,
                 sync_started_at = NULL,
                 sync_owner_pid = NULL, sync_owner_host = NULL, sync_owner_start_ms = NULL,
                 last_synced_at = ?
           WHERE id = ?`,
        )
        .run(ts, orgId);
    });
    apply();
  }

  markSyncFailed(orgId: OrgId): void {
    // Generation deliberately untouched — a failed ingest is not a new
    // version of the graph, so readers polling the counter should not be
    // tricked into thinking data refreshed.
    this.db
      .prepare(
        `UPDATE _sfgraph_orgs
            SET sync_in_progress = 0, sync_started_at = NULL,
                sync_owner_pid = NULL, sync_owner_host = NULL, sync_owner_start_ms = NULL
          WHERE id = ?`,
      )
      .run(orgId);
  }

  getSyncStatus(orgId: OrgId): SyncStatus {
    const row = this.db
      .prepare(
        `SELECT sync_generation, sync_in_progress, sync_started_at, last_synced_at,
                sync_owner_pid, sync_owner_host, sync_owner_start_ms
           FROM _sfgraph_orgs WHERE id = ?`,
      )
      .get(orgId) as
      | {
          sync_generation: number | null;
          sync_in_progress: number | null;
          sync_started_at: string | null;
          last_synced_at: number | null;
          sync_owner_pid: number | null;
          sync_owner_host: string | null;
          sync_owner_start_ms: number | null;
        }
      | undefined;
    if (!row) {
      // Org row not present yet (e.g. tool fired against an MCP context
      // whose DB was just provisioned). Return sane defaults so callers
      // don't have to null-check every field.
      return { generation: 0, in_progress: false, started_at: null, last_sync_at: null };
    }
    // rel-02: a flag whose recorded owner is gone (killed before it could
    // clear it) is reported as not in progress. Report-only: the row is left
    // for the next ingest to overwrite. Legacy rows with no owner are trusted.
    const flagged = (row.sync_in_progress ?? 0) === 1;
    const dead =
      flagged &&
      row.sync_owner_pid != null &&
      syncOwnerIsStale(row.sync_owner_pid, row.sync_owner_host, row.sync_owner_start_ms);
    const inProgress = flagged && !dead;
    return {
      generation: row.sync_generation ?? 0,
      in_progress: inProgress,
      started_at: inProgress ? (row.sync_started_at ?? null) : null,
      last_sync_at: row.last_synced_at ?? null,
    };
  }

  deleteNode(orgId: OrgId, qname: QualifiedName): void {
    this.syncCaches();
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
      // Purge derived per-qname rows so a deleted node leaves no orphans that
      // would surface in explain_code (snippet) or the audits (findings /
      // governor risks / dead-code / coverage). Run unconditionally — derived
      // rows can outlive a missing index entry. The vec0 vector lives in a
      // separate extension-loaded connection and is purged by the caller via
      // VectorStore.deleteNodeVector. Each table is keyed (org_id, qualified_name, …).
      for (const t of DERIVED_QNAME_TABLES) {
        this.stmt(`DELETE FROM ${t} WHERE org_id = ? AND qualified_name = ?`).run(orgId, qname);
      }
      this.deleteNodeFts(String(orgId), String(qname));
    });
    apply();
  }

  deleteEdgesFor(orgId: OrgId, qname: QualifiedName): void {
    this.syncCaches();
    const apply = this.db.transaction(() => {
      // Two statements, not `src = ? OR dst = ?`: SQLite plans the OR as a scan of the org's
      // whole slice of the table (one `_rev (org_id=?)` search). Split, each side uses an
      // index: the PK `(org_id, src_qname, dst_qname)` and `_rev (org_id, dst_qname)`.
      // About 17x faster on a 300k-edge org; the rows removed are the same.
      for (const tbl of this.edgeRelCache.values()) {
        this.stmt(`DELETE FROM ${tbl} WHERE org_id = ? AND src_qname = ?`).run(orgId, qname);
        this.stmt(`DELETE FROM ${tbl} WHERE org_id = ? AND dst_qname = ?`).run(orgId, qname);
      }
    });
    apply();
  }

  mergeNodes(facts: NodeFact[]): MergeResult {
    if (facts.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
    this.syncCaches();
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
      // Look up a node's currently-recorded label (across all per-label tables)
      // so we can detect a label TRANSITION (e.g. ApexMethod → TestMethod when a
      // method gains @isTest, class ↔ interface). On transition the node moves
      // to a new per-label table; the stale old-label row must be deleted, or
      // the detect-deletions sweep sees it as unreferenced and deletes the LIVE
      // node + its edges (deleteNode resolves the table via the index, which now
      // points at the new label). Edges are NOT touched — the qname is unchanged.
      const indexLabelStmt = this.stmt(
        "SELECT label FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name = ?",
      );
      const deleteOldRow = (oldLabel: string, orgId: string, qname: string): void => {
        const oldTbl = this.ensureNodeTable(oldLabel);
        this.stmt(`DELETE FROM ${oldTbl} WHERE org_id = ? AND qualified_name = ?`).run(
          orgId,
          qname,
        );
      };
      for (const [label, bucket] of buckets) {
        const tbl = this.ensureNodeTable(label);
        const selectStmt = this.stmt(
          `SELECT source_hash, first_seen_at FROM ${tbl} WHERE org_id = ? AND qualified_name = ?`,
        );
        const insertStmt = this.stmt(
          `INSERT INTO ${tbl}(org_id, qualified_name, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const updateChangedStmt = this.stmt(
          `UPDATE ${tbl} SET attributes = ?, source_hash = ?, last_seen_at = ?, last_modified_at = ? WHERE org_id = ? AND qualified_name = ?`,
        );
        const updateUnchangedStmt = this.stmt(
          `UPDATE ${tbl} SET last_seen_at = ? WHERE org_id = ? AND qualified_name = ?`,
        );
        const indexStmt = this.stmt(
          `INSERT INTO _sfgraph_node_index(org_id, qualified_name, label) VALUES (?, ?, ?)
           ON CONFLICT(org_id, qualified_name) DO UPDATE SET label=excluded.label`,
        );
        for (const fact of bucket) {
          const existing = selectStmt.get(fact.orgId, fact.qualifiedName) as
            | { source_hash: string; first_seen_at: number }
            | undefined;
          const attrsJson = JSON.stringify(fact.attributes);
          if (!existing) {
            // Not present under THIS label. If the index has it under a
            // DIFFERENT label, it's a label transition — purge the stale old row
            // before inserting the new one (see the transaction-level comment).
            const prior = indexLabelStmt.get(fact.orgId, fact.qualifiedName) as
              | { label: string }
              | undefined;
            if (prior && prior.label !== label) {
              deleteOldRow(prior.label, String(fact.orgId), String(fact.qualifiedName));
            }
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

  mergeEdges(facts: EdgeFact[], opts?: MergeEdgesOptions): MergeResult {
    this.syncCaches();
    const extras =
      opts?.reconcileSources === true && opts.reconcileExtraSrcs?.qnames.length
        ? opts.reconcileExtraSrcs
        : undefined;
    if (facts.length === 0 && !extras) return { inserted: 0, updated: 0, unchanged: 0 };
    const buckets = new Map<string, EdgeFact[]>();
    for (const f of facts) {
      validateRelType(f.relType);
      const arr = buckets.get(f.relType) ?? [];
      arr.push(f);
      buckets.set(f.relType, arr);
    }
    // Reconciliation bookkeeping: the set of source qnames this batch is
    // authoritative for, plus the exact (org|src|dst|rel) edges it carries, so
    // we can prune any prior outgoing edge from those sources that is no longer
    // emitted. The delimiter is a unit-separator that cannot occur in a qname.
    const reconcile = opts?.reconcileSources === true;
    const RSEP = String.fromCharCode(31);
    // org -> set of source qnames this batch is authoritative for, plus the
    // exact (org|src|dst|rel) edges it carries. Reconciliation prunes prior
    // outgoing edges from those sources that the batch no longer emits.
    const srcByOrg = new Map<string, Set<string>>();
    const batchEdgeKeys = new Set<string>();
    // Bulk fast path: in a fresh-org bulk window, a source this window has not
    // written yet has no prior outgoing edges (the org was empty at beginBulk),
    // so its reconcile probe — one SELECT per edge table per chunk — is skipped.
    // Sources written earlier in the window are still probed (and pruned), so
    // the result is identical to the slow path. Membership is decided BEFORE
    // this batch's inserts are recorded.
    const bulk = this.bulk;
    const freshOrg = bulk?.freshOrg ?? null;
    if (reconcile) {
      for (const f of facts) {
        const org = String(f.orgId);
        const src = String(f.srcQualifiedName);
        // NOCASE-folded, like the src/dst columns: a re-emit that differs only
        // in case updates the stored row, so it must also keep it (corecorr-05).
        batchEdgeKeys.add(
          `${org}${RSEP}${nocaseKey(src)}${RSEP}${nocaseKey(String(f.dstQualifiedName))}${RSEP}${f.relType}`,
        );
        let set = srcByOrg.get(org);
        if (!set) {
          set = new Set<string>();
          srcByOrg.set(org, set);
        }
        set.add(src);
      }
      if (extras) {
        const org = String(extras.orgId);
        let set = srcByOrg.get(org);
        if (!set) {
          set = new Set<string>();
          srcByOrg.set(org, set);
        }
        for (const q of extras.qnames) set.add(q);
      }
      if (bulk && freshOrg !== null) {
        const fresh = srcByOrg.get(freshOrg);
        if (fresh) {
          // Count per distinct NOCASE source, matching how SQLite would probe.
          const seen = new Set<string>();
          for (const src of [...fresh]) {
            const k = `${freshOrg}${KSEP}${nocaseKey(src)}`;
            if (!bulk.edgeSrcs.has(k)) {
              fresh.delete(src);
              if (!seen.has(k)) bulk.stats.reconcileSkipped += 1;
            } else if (!seen.has(k)) {
              bulk.stats.reconcileProbed += 1;
            }
            seen.add(k);
          }
          if (fresh.size === 0) srcByOrg.delete(freshOrg);
        }
      }
    }
    if (bulk && freshOrg !== null) {
      for (const f of facts) {
        if (String(f.orgId) === freshOrg) {
          bulk.edgeSrcs.add(`${freshOrg}${KSEP}${nocaseKey(String(f.srcQualifiedName))}`);
        }
      }
    }
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let deleted = 0;
    const apply = this.db.transaction(() => {
      // Reconcile: read every prior outgoing edge of the owned sources once,
      // across all edge tables (one UNION ALL statement per org), BEFORE this
      // batch writes. It answers the per-fact existence probe for those
      // sources (kept current as the batch inserts / updates, so a repeat
      // within the batch sees the earlier write, as the probe would) and is
      // the prune candidate set below. Rows this batch inserts are always in
      // batchEdgeKeys, so pruning against the pre-write snapshot deletes
      // exactly the rows the old post-write scan deleted.
      const prior = new Map<string, { attributes: string; id?: number }>();
      const priorRows: Array<{ org: string; relType: string; r: PriorEdgeRow }> = [];
      const covered = new Set<string>();
      const deferredSeen = new Map<string, Map<number, number>>();
      if (reconcile && srcByOrg.size > 0) {
        for (const [org, srcSet] of srcByOrg) {
          for (const src of srcSet) covered.add(`${org}${KSEP}${nocaseKey(src)}`);
          for (const { relType, r } of this.priorOutgoingEdges(org, [...srcSet])) {
            priorRows.push({ org, relType, r });
            prior.set(`${org}${RSEP}${nocaseKey(r.s)}${RSEP}${nocaseKey(r.d)}${RSEP}${relType}`, {
              attributes: r.a,
              id: r.id,
            });
          }
        }
      }
      for (const [relType, bucket] of buckets) {
        const tbl = this.ensureEdgeTable(relType);
        const selectStmt = this.stmt(
          `SELECT attributes, first_seen_at FROM ${tbl} WHERE org_id = ? AND src_qname = ? AND dst_qname = ?`,
        );
        const insertStmt = this.stmt(
          `INSERT INTO ${tbl}(org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const updateChangedStmt = this.stmt(
          `UPDATE ${tbl} SET attributes = ?, last_seen_at = ? WHERE org_id = ? AND src_qname = ? AND dst_qname = ?`,
        );
        const updateSeenStmt = this.stmt(
          `UPDATE ${tbl} SET last_seen_at = ? WHERE org_id = ? AND src_qname = ? AND dst_qname = ?`,
        );
        // M-3: a re-parsed source re-emits its guessed dst (`(?)` arity
        // guess, `ApexClass:` interface name, formula hop guess); the edge a
        // resolver rewrote it to is still present here (pruned below), so the
        // fresh guess inherits that edge's first_seen_at. Probed only for
        // sources this reconcile batch owns and that may have prior rows.
        const rewrittenFromStmt = reconcile
          ? this.stmt(
              `SELECT MIN(first_seen_at) AS t FROM ${tbl} WHERE org_id = ? AND src_qname = ? AND (
                 json_extract(attributes, '$.arityResolvedFrom') = ? COLLATE NOCASE OR
                 json_extract(attributes, '$.retargetedFrom') = ? COLLATE NOCASE OR
                 json_extract(attributes, '$.hopResolvedFrom') = ? COLLATE NOCASE)`,
            )
          : null;
        for (const fact of bucket) {
          const org = String(fact.orgId);
          const src = String(fact.srcQualifiedName);
          const priorKey = covered.has(`${org}${KSEP}${nocaseKey(src)}`)
            ? `${org}${RSEP}${nocaseKey(src)}${RSEP}${nocaseKey(String(fact.dstQualifiedName))}${RSEP}${relType}`
            : null;
          const existing = (
            priorKey !== null
              ? prior.get(priorKey)
              : selectStmt.get(fact.orgId, fact.srcQualifiedName, fact.dstQualifiedName)
          ) as { attributes: string; id?: number } | undefined;
          const attrsJson = JSON.stringify(fact.attributes);
          if (priorKey !== null && existing?.attributes !== attrsJson) {
            prior.set(
              priorKey,
              existing?.id !== undefined
                ? { attributes: attrsJson, id: existing.id }
                : { attributes: attrsJson },
            );
          }
          if (!existing) {
            let firstSeenAt = fact.firstSeenAt;
            if (
              rewrittenFromStmt &&
              srcByOrg.get(String(fact.orgId))?.has(String(fact.srcQualifiedName))
            ) {
              const dst = String(fact.dstQualifiedName);
              if (
                dst.endsWith("(?)") ||
                dst.startsWith("ApexClass:") ||
                (fact.attributes as Record<string, unknown>).hopRelationship != null
              ) {
                const row = rewrittenFromStmt.get(
                  fact.orgId,
                  fact.srcQualifiedName,
                  dst,
                  dst,
                  dst,
                ) as { t: number | null } | undefined;
                if (row?.t != null && row.t < firstSeenAt) firstSeenAt = row.t;
              }
            }
            insertStmt.run(
              fact.orgId,
              fact.srcQualifiedName,
              fact.dstQualifiedName,
              attrsJson,
              firstSeenAt,
              fact.lastSeenAt,
            );
            inserted += 1;
          } else if (existing.attributes !== attrsJson) {
            // Runs now, so an earlier deferred last_seen_at write is moot.
            if (existing.id !== undefined) deferredSeen.get(relType)?.delete(existing.id);
            updateChangedStmt.run(
              attrsJson,
              fact.lastSeenAt,
              fact.orgId,
              fact.srcQualifiedName,
              fact.dstQualifiedName,
            );
            updated += 1;
          } else if (existing.id !== undefined) {
            // A prior row re-emitted unchanged: its last_seen_at is written
            // below, in one statement per table (Map order = last write wins).
            let ids = deferredSeen.get(relType);
            if (!ids) {
              ids = new Map();
              deferredSeen.set(relType, ids);
            }
            ids.delete(existing.id);
            ids.set(existing.id, fact.lastSeenAt);
            unchanged += 1;
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
      // Deferred last_seen_at writes, grouped by value. Nothing in this call
      // reads last_seen_at, and a later changed-attributes update of the same
      // row dropped its entry above, so the rows end exactly as per-fact
      // UPDATEs would leave them.
      for (const [relType, ids] of deferredSeen) {
        const tbl = this.edgeRelCache.get(relType) as string;
        const byValue = new Map<number, number[]>();
        for (const [id, seen] of ids) {
          let list = byValue.get(seen);
          if (!list) {
            list = [];
            byValue.set(seen, list);
          }
          list.push(id);
        }
        for (const [seen, list] of byValue) {
          this.stmt(
            `UPDATE ${tbl} SET last_seen_at = @seen WHERE rowid IN (SELECT value FROM json_each(@ids))`,
          ).run({ seen, ids: JSON.stringify(list) });
        }
      }

      // Prune immortal edges: for every source this batch owns, drop any
      // OUTGOING edge it no longer emits. Scoped to (org_id, src_qname) so it's
      // an index-served point lookup on each edge table's PK — NOT a full-table
      // scan (which would be O(members×edges) per ingest and would read other
      // orgs' rows). Edges produced by a different pass — MCD baseline / the
      // reflection walker (attributes.source) and the arity resolver
      // (attributes.resolvedBy) — are NOT touched: the parser batch never
      // contains them, and the pre-fan-out MCD pass never re-adds them, so
      // pruning them would silently destroy long-tail dependency coverage.
      // Inbound edges (dst = source) are left intact regardless.
      // Candidates are the pre-write snapshot read above (see there).
      for (const { org, relType, r } of priorRows) {
        const k = `${org}${RSEP}${nocaseKey(r.s)}${RSEP}${nocaseKey(r.d)}${RSEP}${relType}`;
        if (batchEdgeKeys.has(k)) continue; // re-emitted this batch — keep
        let attrs: Record<string, unknown> = {};
        try {
          attrs = r.a ? (JSON.parse(r.a) as Record<string, unknown>) : {};
        } catch {
          attrs = {};
        }
        // Foreign-pass edge (MCD/reflection/arity) — not this parser's to prune.
        if (attrs.source != null || attrs.resolvedBy != null) continue;
        const tbl = this.edgeRelCache.get(relType) as string;
        this.stmt(`DELETE FROM ${tbl} WHERE org_id = ? AND src_qname = ? AND dst_qname = ?`).run(
          org,
          r.s,
          r.d,
        );
        deleted += 1;
      }
    });
    apply();
    return { inserted, updated, unchanged, ...(reconcile ? { deleted } : {}) };
  }

  /**
   * Every outgoing edge of `srcs` (NOCASE, like the src_qname column) in every
   * edge table, in one statement: a UNION ALL of per-table PK range lookups
   * with the sources passed once as a JSON array, materialized as a CTE (no
   * IN-list variable cap, one cached statement whatever the number of
   * sources). Measured ~1.4x faster than one IN-list query per table.
   */
  private priorOutgoingEdges(
    org: string,
    srcs: readonly string[],
  ): Array<{ relType: string; r: PriorEdgeRow }> {
    if (this.edgeRelCache.size === 0 || srcs.length === 0) return [];
    let q = this.priorEdgesQuery;
    if (!q || q.map !== this.edgeRelCache || q.size !== this.edgeRelCache.size) {
      const tables = [...this.edgeRelCache];
      const sqls = chunks(
        tables.map(
          ([, tbl], i) =>
            `SELECT ${i} AS t, rowid AS id, src_qname AS s, dst_qname AS d, attributes AS a FROM ${tbl} WHERE org_id = @org AND src_qname IN q`,
        ),
        MAX_UNION_ARMS,
      ).map(
        (arms) =>
          `WITH q(v) AS MATERIALIZED (SELECT value FROM json_each(@srcs)) ${arms.join(" UNION ALL ")}`,
      );
      q = { map: this.edgeRelCache, size: tables.length, rels: tables.map(([r]) => r), sqls };
      this.priorEdgesQuery = q;
    }
    const rels = q.rels;
    const params = { org, srcs: JSON.stringify(srcs) };
    const out: Array<{ relType: string; r: PriorEdgeRow }> = [];
    for (const sql of q.sqls) {
      for (const r of this.stmt(sql).all(params) as PriorEdgeRow[]) {
        out.push({ relType: rels[r.t] as string, r });
      }
    }
    return out;
  }

  getNode(orgId: OrgId, qname: QualifiedName): NodeFact | null {
    this.syncCaches();
    const idx = this.stmt(
      "SELECT label FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name = ?",
    ).get(orgId, qname) as { label: string } | undefined;
    if (!idx) return null;
    const tbl = this.nodeLabelCache.get(idx.label);
    if (!tbl) return null;
    const row = this.stmt(
      `SELECT org_id, qualified_name, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at FROM ${tbl} WHERE org_id = ? AND qualified_name = ?`,
    ).get(orgId, qname) as RawNodeRow | undefined;
    if (!row) return null;
    return rowToNode(row, idx.label);
  }

  listNodesByLabel(orgId: OrgId, label: string, limit?: number): NodeFact[] {
    validateLabel(label);
    this.syncCaches();
    const tbl = this.nodeLabelCache.get(label);
    if (!tbl) return [];
    const sql = `SELECT org_id, qualified_name, attributes, source_hash, first_seen_at, last_seen_at, last_modified_at FROM ${tbl} WHERE org_id = ?${typeof limit === "number" ? " LIMIT ?" : ""}`;
    const params: unknown[] = [orgId];
    if (typeof limit === "number") params.push(limit);
    const rows = this.stmt(sql).all(...params) as RawNodeRow[];
    return rows.map((r) => rowToNode(r, label));
  }

  /**
   * listNodesByLabel's qualified names, without the attributes JSON (~6x
   * cheaper on attribute-heavy labels). `ORDER BY rowid` pins the order
   * listNodesByLabel gets from its `<tbl>_org` index scan: selecting only
   * qualified_name would otherwise make the covering PK index the cheapest
   * plan, which yields NOCASE name order (and a different LIMIT subset).
   */
  listQnamesByLabel(orgId: OrgId, label: string, limit?: number): QualifiedName[] {
    validateLabel(label);
    this.syncCaches();
    const tbl = this.nodeLabelCache.get(label);
    if (!tbl) return [];
    const sql = `SELECT qualified_name FROM ${tbl} WHERE org_id = ? ORDER BY rowid${typeof limit === "number" ? " LIMIT ?" : ""}`;
    const params: unknown[] = [orgId];
    if (typeof limit === "number") params.push(limit);
    const rows = this.stmt(sql).all(...params) as Array<{ qualified_name: string }>;
    return rows.map((r) => asQualifiedName(r.qualified_name));
  }

  /**
   * Every edge table's rows with `col = @q`, as ONE statement: a UNION ALL of
   * the per-table queries listEdgesFrom / listEdgesTo used to run one by one,
   * in edgeRelCache order. SQLite runs a UNION ALL's arms in order, each with
   * the plan it gets on its own, so the rows (and their order) are exactly
   * the concatenation of the per-table results. One statement step per
   * traversal node instead of one per edge table (~2x faster traces).
   */
  private edgesAllTables(
    col: "src_qname" | "dst_qname",
    orgId: OrgId,
    q: QualifiedName,
  ): EdgeFact[] {
    let u = this.unionEdgeQueries[col];
    if (!u || u.map !== this.edgeRelCache || u.size !== this.edgeRelCache.size) {
      const tables = [...this.edgeRelCache];
      u = {
        map: this.edgeRelCache,
        size: tables.length,
        rels: tables.map(([r]) => r as RelType),
        // Consecutive groups of tables, run in order (SQLite caps compound arms).
        sqls: chunks(
          tables.map(
            ([, tbl], i) =>
              `SELECT ${i} AS t, org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = @org AND ${col} = @q`,
          ),
          MAX_UNION_ARMS,
        ).map((arms) => arms.join(" UNION ALL ")),
      };
      this.unionEdgeQueries[col] = u;
    }
    const rels = u.rels;
    const out: EdgeFact[] = [];
    for (const sql of u.sqls) {
      const rows = this.stmt(sql).all({ org: orgId, q }) as Array<RawEdgeRow & { t: number }>;
      for (const r of rows) out.push(rowToEdge(r, rels[r.t] as RelType));
    }
    return out;
  }

  listEdgesFrom(orgId: OrgId, src: QualifiedName, relType?: RelType): EdgeFact[] {
    this.syncCaches();
    if (!relType) return this.edgesAllTables("src_qname", orgId, src);
    const out: EdgeFact[] = [];
    const types = [relType];
    for (const t of types) {
      const tbl = this.edgeRelCache.get(t);
      if (!tbl) continue;
      // perf-05: cached per table; traversals call this once per BFS node.
      const rows = this.stmt(
        `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND src_qname = ?`,
      ).all(orgId, src) as RawEdgeRow[];
      for (const r of rows) out.push(rowToEdge(r, t as RelType));
    }
    return out;
  }

  listEdgesTo(orgId: OrgId, dst: QualifiedName, relType?: RelType): EdgeFact[] {
    this.syncCaches();
    if (!relType) return this.edgesAllTables("dst_qname", orgId, dst);
    const out: EdgeFact[] = [];
    const types = [relType];
    for (const t of types) {
      const tbl = this.edgeRelCache.get(t);
      if (!tbl) continue;
      // perf-05: cached per table; traversals call this once per BFS node.
      const rows = this.stmt(
        `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND dst_qname = ?`,
      ).all(orgId, dst) as RawEdgeRow[];
      for (const r of rows) out.push(rowToEdge(r, t as RelType));
    }
    return out;
  }

  listEdgesByDstLike(orgId: OrgId, pattern: string, relType?: RelType, limit?: number): EdgeFact[] {
    this.syncCaches();
    const out: EdgeFact[] = [];
    const types = relType ? [relType] : Array.from(this.edgeRelCache.keys());
    const cap = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;
    for (const t of types) {
      if (out.length >= cap) break;
      const tbl = this.edgeRelCache.get(t);
      if (!tbl) continue;
      // LIMIT -1 is SQLite's "no limit": one cached statement per table.
      const remaining = Number.isFinite(cap) ? cap - out.length : -1;
      const rows = this.stmt(
        `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND dst_qname LIKE ? LIMIT ?`,
      ).all(orgId, pattern, remaining) as RawEdgeRow[];
      for (const r of rows) out.push(rowToEdge(r, t as RelType));
    }
    return out;
  }

  deleteEdge(orgId: OrgId, src: QualifiedName, dst: QualifiedName, relType: RelType): void {
    this.syncCaches();
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
    this.syncCaches();
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
   * Streaming form of `listDanglingEdges`: same SQL, tables and order, one
   * row at a time and without parsing attributes, so an org with ~1M
   * dangling edges never holds them all at once.
   */
  *iterateDanglingEdges(orgId: OrgId, limit?: number): IterableIterator<DanglingEdgeRow> {
    this.syncCaches();
    const cap = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;
    let seen = 0;
    for (const [relType, tbl] of [...this.edgeRelCache]) {
      if (seen >= cap) return;
      const remaining = Number.isFinite(cap) ? cap - seen : -1;
      const limitClause = remaining > 0 ? `LIMIT ${remaining}` : "";
      const rows = this.db
        .prepare(
          `SELECT e.src_qname, e.dst_qname, e.attributes
           FROM ${tbl} e
           LEFT JOIN _sfgraph_node_index n
             ON n.org_id = e.org_id AND n.qualified_name = e.dst_qname
           WHERE e.org_id = ? AND n.qualified_name IS NULL
           ${limitClause}`,
        )
        .iterate(orgId) as IterableIterator<{
        src_qname: string;
        dst_qname: string;
        attributes: string;
      }>;
      for (const r of rows) {
        seen++;
        yield { relType, src: r.src_qname, dst: r.dst_qname, attributes: r.attributes };
      }
    }
  }

  /**
   * Return every qualified name persisted for `orgId` across all label tables.
   * Used by full-sync deletion detection to compute the difference between
   * what was previously known and what the current sync touched.
   */
  listAllQnames(orgId: OrgId): QualifiedName[] {
    this.syncCaches();
    const out: QualifiedName[] = [];
    for (const tbl of this.nodeLabelCache.values()) {
      const rows = this.db
        .prepare(`SELECT qualified_name FROM ${tbl} WHERE org_id = ?`)
        .all(orgId) as Array<{ qualified_name: string }>;
      for (const r of rows) out.push(r.qualified_name as QualifiedName);
    }
    return out;
  }

  /**
   * Return every distinct node label the store currently knows about. Used
   * by find-nodes glob matching (W3-04) to enumerate label tables without
   * exposing the private nodeLabelCache. Order is undefined.
   */
  listAllLabels(): string[] {
    this.syncCaches();
    return [...this.nodeLabelCache.keys()];
  }

  countNodes(orgId: OrgId): number {
    this.syncCaches();
    let total = 0;
    for (const tbl of this.nodeLabelCache.values()) {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${tbl} WHERE org_id = ?`).get(orgId) as
        | { c: number }
        | undefined;
      total += row?.c ?? 0;
    }
    return total;
  }

  /**
   * Count nodes of `label` for `orgId`. Returns 0 if the label table has
   * not been created yet. Used by the W1.5-07 detect-deletions guard.
   *
   * Note: a similar helper `countNodes(orgId)` already exists for whole-org
   * counts, but it sums across all labels. The guard needs per-label
   * precision to compute drop ratios per deletion-target, so a dedicated
   * helper is added rather than overloading countNodes.
   */
  countNodesByLabel(orgId: OrgId, label: string): number {
    this.syncCaches();
    const tbl = this.nodeLabelCache.get(label);
    if (!tbl) return 0;
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${tbl} WHERE org_id = ?`).get(orgId) as
      | { c: number }
      | undefined;
    return row?.c ?? 0;
  }

  countEdges(orgId: OrgId): number {
    this.syncCaches();
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
    const existing = this.stmt(
      "SELECT source_hash FROM _sfgraph_snippets WHERE org_id = ? AND qualified_name = ?",
    ).get(rec.orgId, rec.qualifiedName) as { source_hash: string } | undefined;
    if (existing && existing.source_hash === rec.sourceHash) {
      return { inserted: false, updated: false, unchanged: true };
    }
    if (existing) {
      this.stmt(
        `UPDATE _sfgraph_snippets
             SET source_format = ?, source_text = ?, start_line = ?, end_line = ?,
                 source_hash = ?, llm_explanation = NULL, explained_at = NULL
           WHERE org_id = ? AND qualified_name = ?`,
      ).run(
        rec.sourceFormat,
        rec.sourceText,
        rec.startLine ?? null,
        rec.endLine ?? null,
        rec.sourceHash,
        rec.orgId,
        rec.qualifiedName,
      );
      this.upsertApexFrameIndex(rec);
      return { inserted: false, updated: true, unchanged: false };
    }
    this.stmt(
      `INSERT INTO _sfgraph_snippets
           (org_id, qualified_name, source_format, source_text, start_line, end_line, source_hash, llm_explanation, explained_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
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
    this.upsertApexFrameIndex(rec);
    return { inserted: true, updated: false, unchanged: false };
  }

  /** Keep the incident/debug lookup index in lock-step with persisted Apex source. */
  private upsertApexFrameIndex(rec: SnippetRecord): void {
    const key = apexFrameKey(String(rec.qualifiedName));
    if (!key) return;
    this.stmt(
      `INSERT INTO _sfgraph_apex_frame_index
         (org_id, qualified_name, frame_kind, owner_name, member_name, start_line, end_line, source_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, qualified_name) DO UPDATE SET
         frame_kind = excluded.frame_kind,
         owner_name = excluded.owner_name,
         member_name = excluded.member_name,
         start_line = excluded.start_line,
         end_line = excluded.end_line,
         source_hash = excluded.source_hash`,
    ).run(
      rec.orgId,
      rec.qualifiedName,
      key.frameKind,
      key.ownerName,
      key.memberName ?? null,
      rec.startLine ?? null,
      rec.endLine ?? null,
      rec.sourceHash,
    );
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

  findApexFrameCandidates(
    orgId: OrgId,
    frame: { kind: "class" | "trigger"; ownerName: string; memberName?: string },
  ): ApexFrameCandidate[] {
    if (frame.kind === "class" && !frame.memberName) return [];
    const memberClause =
      frame.kind === "class" ? "AND i.member_name = ?" : "AND i.member_name IS NULL";
    const params: unknown[] = [orgId, frame.kind, frame.ownerName];
    if (frame.kind === "class") params.push(frame.memberName);
    const rows = this.db
      .prepare(
        `SELECT i.frame_kind, i.owner_name, i.member_name,
                s.org_id, s.qualified_name, s.source_format, s.source_text, s.start_line, s.end_line,
                s.source_hash, s.llm_explanation, s.explained_at
           FROM _sfgraph_apex_frame_index i
           JOIN _sfgraph_snippets s
             ON s.org_id = i.org_id AND s.qualified_name = i.qualified_name
          WHERE i.org_id = ? AND i.frame_kind = ? AND i.owner_name = ? ${memberClause}
          ORDER BY i.start_line IS NULL, i.start_line, i.qualified_name`,
      )
      .all(...params) as Array<{
      frame_kind: "class" | "trigger";
      owner_name: string;
      member_name: string | null;
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
      const candidate: ApexFrameCandidate = {
        orgId: asOrgId(row.org_id),
        qualifiedName: asQualifiedName(row.qualified_name),
        sourceFormat: row.source_format as SnippetSourceFormat,
        sourceText: row.source_text,
        sourceHash: asSha256(row.source_hash),
        frameKind: row.frame_kind,
        ownerName: row.owner_name,
      };
      if (row.member_name != null) candidate.memberName = row.member_name;
      if (row.start_line != null) candidate.startLine = row.start_line;
      if (row.end_line != null) candidate.endLine = row.end_line;
      if (row.llm_explanation != null) candidate.llmExplanation = row.llm_explanation;
      if (row.explained_at != null) candidate.explainedAt = row.explained_at;
      return candidate;
    });
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

  /**
   * Replace the FTS doc for (org, qname). The old row is found through the
   * indexed _sfgraph_node_fts_rowid map and deleted by rowid; a WHERE on the
   * FTS5 UNINDEXED key columns would scan the whole table (O(n²) per ingest).
   * Keys compare BINARY, exactly like the old column equality, and the insert
   * sequence (hence rowids and bm25 tie order) is unchanged.
   */
  upsertNodeFts(orgId: OrgId, qname: QualifiedName, label: string, body: string): void {
    try {
      if (!this.ftsUpsertTx) {
        this.ftsUpsertTx = this.db.transaction(
          (org: string, q: string, lbl: string, text: string): void => {
            const bulk = this.bulk;
            const key = `${org}${KSEP}${q}`;
            if (bulk && bulk.freshOrg === org && !bulk.ftsKeys.has(key)) {
              // Fresh org, first write of this key in the window: nothing to delete.
              bulk.stats.ftsDeleteSkipped += 1;
            } else {
              this.deleteNodeFts(org, q);
            }
            const info = this.stmt(
              "INSERT INTO _sfgraph_node_fts(qualified_name, org_id, label, body) VALUES (?, ?, ?, ?)",
            ).run(q, org, lbl, text);
            this.stmt(
              `INSERT INTO _sfgraph_node_fts_rowid(org_id, qualified_name, fts_rowid) VALUES (?, ?, ?)
               ON CONFLICT(org_id, qualified_name) DO UPDATE SET fts_rowid = excluded.fts_rowid`,
            ).run(org, q, info.lastInsertRowid);
            if (bulk && bulk.freshOrg === org) bulk.ftsKeys.add(key);
          },
        );
      }
      this.ftsUpsertTx(String(orgId), String(qname), label, body);
    } catch {
      /* FTS5 unavailable — keyword leg degrades to empty. */
    }
  }

  /** Delete (org, qname)'s FTS doc by rowid via the side table. Best-effort when FTS5 is absent. */
  private deleteNodeFts(orgId: string, qname: string): void {
    let row: { r: number | bigint } | undefined;
    try {
      row = this.stmt(
        "SELECT fts_rowid AS r FROM _sfgraph_node_fts_rowid WHERE org_id = ? AND qualified_name = ?",
      ).get(orgId, qname) as { r: number | bigint } | undefined;
    } catch {
      return; // pre-migration / FTS-less store
    }
    if (!row) return;
    try {
      this.stmt("DELETE FROM _sfgraph_node_fts WHERE rowid = ?").run(row.r);
    } catch {
      /* FTS5 unavailable */
    }
    this.stmt("DELETE FROM _sfgraph_node_fts_rowid WHERE org_id = ? AND qualified_name = ?").run(
      orgId,
      qname,
    );
  }

  // ─── Task 10: bulk-load window for rebuilds ───────────────────────────────

  /**
   * Self-heal after a process died inside a bulk window (crash, SIGKILL, OOM,
   * native checkpoint abort): the DROP INDEXes were durable but endBulk never
   * rebuilt them. Recreates every missing canonical `_org` / `_rev` index and
   * clears the marker. Skipped unless the marker is ours or its owner is
   * stale (same host, dead pid): another live process's window, or any
   * window opened on another host, is legitimately open. Cheap when nothing is missing:
   * one sqlite_master read. Best-effort — a busy DB must not fail init().
   */
  /** Task 11c: markers written before the host column get it added (null = this host). */
  private ensureBulkMarkerHost(): void {
    const cols = this.db.prepare("PRAGMA table_info(_sfgraph_bulk_window)").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "host")) {
      try {
        this.db.exec("ALTER TABLE _sfgraph_bulk_window ADD COLUMN host TEXT");
      } catch {
        /* a concurrent opener added it */
      }
    }
  }

  private healBulkWindow(): void {
    try {
      const hasMarkerTable =
        this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sfgraph_bulk_window'",
          )
          .get() !== undefined;
      if (hasMarkerTable) this.ensureBulkMarkerHost();
      const marker = hasMarkerTable
        ? (this.db
            .prepare("SELECT pid, host, started_at FROM _sfgraph_bulk_window WHERE id = 1")
            .get() as { pid: number; host: string | null; started_at: number | null } | undefined)
        : undefined;
      // Heal only our own window or one whose owner is provably gone: same
      // host, dead pid. A window opened on another host is never touched.
      if (marker) {
        const ours = marker.pid === process.pid && isThisHost(marker.host);
        if (!ours && !ownerIsStale({ ...marker, takenAtMs: marker.started_at })) return;
      }
      const objects = this.db
        .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index')")
        .all() as Array<{ type: string; name: string }>;
      const tables = new Set(objects.filter((o) => o.type === "table").map((o) => o.name));
      const idx = new Set(objects.filter((o) => o.type === "index").map((o) => o.name));
      const missing: string[] = [];
      for (const tbl of this.nodeLabelCache.values())
        if (tables.has(tbl) && !idx.has(`${tbl}_org`)) missing.push(nodeIndexDdl(tbl));
      for (const tbl of this.edgeRelCache.values())
        if (tables.has(tbl) && !idx.has(`${tbl}_rev`)) missing.push(edgeIndexDdl(tbl));
      if (missing.length === 0 && !marker) return;
      this.db.transaction(() => {
        for (const sql of missing) this.db.exec(sql);
        if (marker) this.db.prepare("DELETE FROM _sfgraph_bulk_window WHERE id = 1").run();
      })();
    } catch {
      /* best-effort: e.g. SQLITE_BUSY; retried on the next init() */
    }
  }

  // ─── Task 11a: embedding status ───────────────────────────────────────────

  /** Mark the org's vectors as still being written (or done). Best-effort on
   *  a pre-v12 store. */
  setEmbeddingsPending(orgId: OrgId, pending: boolean): void {
    try {
      this.stmt("UPDATE _sfgraph_orgs SET embeddings_pending = ? WHERE id = ?").run(
        pending ? 1 : 0,
        orgId,
      );
    } catch {
      /* pre-v12 store */
    }
  }

  /**
   * Whether the org's vectors are still being written, and how many texts it
   * embeds in total (its FTS docs: every embedded text is also an FTS doc).
   * Null for an unknown org or a store without the v12 column.
   */
  getEmbeddingStatus(orgId: OrgId): { pending: boolean; total: number } | null {
    let row: { p: number } | undefined;
    try {
      row = this.stmt("SELECT embeddings_pending AS p FROM _sfgraph_orgs WHERE id = ?").get(
        orgId,
      ) as { p: number } | undefined;
    } catch {
      return null;
    }
    if (!row) return null;
    let total = 0;
    try {
      total = (
        this.stmt("SELECT COUNT(*) AS c FROM _sfgraph_node_fts_rowid WHERE org_id = ?").get(
          orgId,
        ) as { c: number }
      ).c;
    } catch {
      /* FTS-less store */
    }
    return { pending: row.p === 1, total };
  }

  /** Every FTS doc of the org (the exact embed text per qname), for the
   *  embedding backfill. Empty when FTS5 is unavailable. Streams in keyset
   *  pages of `pageSize` rows, so at most one page of bodies is held at once.
   *  Not `.iterate()`: the caller writes vectors between rows (backpressure
   *  can force a dispatch), and a better-sqlite3 connection with an open
   *  iterator rejects writes ("connection is busy"). */
  *listFtsDocs(
    orgId: OrgId,
    pageSize = 1000,
  ): IterableIterator<{ qname: string; label: string; body: string }> {
    type Row = { qname: string; label: string; body: string };
    // Keyset on the (org_id, qualified_name) primary key: each page is an
    // index range scan, not a re-sort of the whole org.
    let after = "";
    for (;;) {
      let rows: Row[];
      try {
        rows = this.stmt(
          `SELECT r.qualified_name AS qname, f.label AS label, f.body AS body
             FROM _sfgraph_node_fts_rowid r
             JOIN _sfgraph_node_fts f ON f.rowid = r.fts_rowid
            WHERE r.org_id = ? AND r.qualified_name > ?
            ORDER BY r.qualified_name
            LIMIT ?`,
        ).all(orgId, after, pageSize) as Row[];
      } catch {
        return;
      }
      yield* rows;
      if (rows.length < pageSize) return;
      after = (rows[rows.length - 1] as Row).qname;
    }
  }

  /** True when `orgId` has no node, edge or FTS rows. Index probes only (LIMIT 1). */
  isOrgEmpty(orgId: OrgId): boolean {
    this.syncCaches();
    const probe = (tbl: string) =>
      this.db.prepare(`SELECT 1 FROM ${tbl} WHERE org_id = ? LIMIT 1`).get(orgId) !== undefined;
    for (const tbl of this.nodeLabelCache.values()) if (probe(tbl)) return false;
    for (const tbl of this.edgeRelCache.values()) if (probe(tbl)) return false;
    if (probe("_sfgraph_node_index")) return false;
    try {
      if (probe("_sfgraph_node_fts_rowid")) return false;
    } catch {
      /* table absent */
    }
    return true;
  }

  /**
   * Open a bulk-load window for a rebuild: drop the graph tables' secondary
   * indexes (rebuilt in one pass at endBulk), set journal_mode=WAL,
   * synchronous=OFF, temp_store=MEMORY, and hold one write transaction per
   * BULK_TXN_MEMBERS members (advanced by bulkMemberDone). Not re-entrant.
   */
  beginBulk(opts: BeginBulkOptions = {}): void {
    if (this.bulk) throw new StorageError("beginBulk: a bulk window is already open");
    if (this.batch) throw new StorageError("beginBulk: a batch window is open");
    if (this.db.inTransaction) throw new StorageError("beginBulk: called inside a transaction");
    this.syncCaches();
    const fresh =
      opts.freshOrgId !== undefined && this.isOrgEmpty(opts.freshOrgId)
        ? String(opts.freshOrgId)
        : null;
    const batchTxn = opts.batchTransactions !== false;
    const graphTables = new Set([...this.nodeLabelCache.values(), ...this.edgeRelCache.values()]);
    // The _sfg_* tables are shared by every org in the file. A fresh org next
    // to other orgs' rows keeps the existing indexes (their readers, and an
    // endBulk re-index of every org's rows, would otherwise pay); only tables
    // created inside the window defer their indexes.
    const otherOrgsHaveRows =
      fresh !== null &&
      [...graphTables].some(
        (t) => this.db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get() !== undefined,
      );
    const existing = otherOrgsHaveRows
      ? []
      : (
          this.db
            .prepare(
              "SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
            )
            .all() as Array<{ name: string; tbl: string; sql: string }>
        ).filter((i) => graphTables.has(i.tbl));
    // Durable marker first (autocommit), so a crash after any DROP is healed.
    this.db.exec(BULK_MARKER_DDL);
    this.ensureBulkMarkerHost();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO _sfgraph_bulk_window(id, pid, started_at, host) VALUES (1, ?, ?, ?)",
      )
      .run(process.pid, Date.now(), thisHost());
    // Register the window before touching anything, so a failure part-way
    // through is undone by endBulk (indexes rebuilt, synchronous restored).
    this.bulk = {
      freshOrg: fresh,
      batchTxn,
      members: 0,
      edgeSrcs: new Set(),
      ftsKeys: new Set(),
      deferredIndexes: existing.map((i) => ({ name: i.name, table: i.tbl, sql: i.sql })),
      stats: {
        active: true,
        fresh: fresh !== null,
        members: 0,
        reconcileSkipped: 0,
        reconcileProbed: 0,
        ftsDeleteSkipped: 0,
      },
    };
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = OFF");
      this.db.pragma("temp_store = MEMORY");
      for (const i of existing)
        this.db.exec(`DROP INDEX IF EXISTS "${i.name.replace(/"/g, '""')}"`);
      if (batchTxn) this.db.exec("BEGIN");
    } catch (e) {
      try {
        this.endBulk();
      } catch {
        /* the original error matters more; init() heals on next open */
      }
      throw e;
    }
  }

  /** Mark one member written; commits and reopens the bulk transaction every BULK_TXN_MEMBERS. */
  bulkMemberDone(): void {
    const bulk = this.bulk;
    if (!bulk) return;
    if (bulk.batchTxn && !this.db.inTransaction) {
      // SQLite rolls back the whole outer BEGIN on SQLITE_FULL / IOERR / NOMEM
      // inside a member's savepoint: every member since the last commit is lost.
      throw new StorageError(
        "bulk transaction was rolled back by SQLite; members written since the last commit were lost",
      );
    }
    bulk.members += 1;
    bulk.stats.members = bulk.members;
    if (bulk.batchTxn && bulk.members % BULK_TXN_MEMBERS === 0 && this.db.inTransaction) {
      this.db.exec("COMMIT");
      this.db.exec("BEGIN");
    }
  }

  /**
   * Close the bulk window: commit, recreate the deferred indexes (with
   * temp_store=FILE, then the previous temp_store is restored), restore
   * synchronous=NORMAL. No-op when closed.
   */
  endBulk(): void {
    const bulk = this.bulk;
    if (!bulk) return;
    this.bulk = null;
    try {
      if (bulk.batchTxn && this.db.inTransaction) this.db.exec("COMMIT");
    } finally {
      const build = this.db.transaction(() => {
        for (const i of bulk.deferredIndexes) {
          const hasTable = this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(i.table);
          const hasIndex = this.db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
            .get(i.name);
          if (hasTable && !hasIndex) this.db.exec(i.sql);
        }
      });
      // The index sorter spills past cache_size into temp files; with
      // temp_store=MEMORY those live in RAM (+~1 GB RSS on a 2.6M-edge org,
      // never returned by malloc). Spill to disk for the rebuild only.
      // SQLite refuses to change temp_store inside a transaction.
      const prevTempStore = this.db.inTransaction
        ? null
        : Number(this.db.pragma("temp_store", { simple: true }));
      if (prevTempStore === null)
        console.warn(
          "sfgraph: endBulk is inside a transaction (the bulk commit failed?); rebuilding indexes with the connection's temp_store (MEMORY), which can use much more RAM",
        );
      try {
        if (prevTempStore !== null && prevTempStore !== 1) this.db.pragma("temp_store = FILE");
        build();
        this.db.prepare("DELETE FROM _sfgraph_bulk_window WHERE id = 1").run();
      } finally {
        try {
          if (prevTempStore !== null && prevTempStore !== 1 && !this.db.inTransaction)
            this.db.pragma(`temp_store = ${prevTempStore}`);
        } finally {
          this.db.pragma("synchronous = NORMAL");
        }
      }
    }
  }

  /** Snapshot of the current bulk window's counters (inactive zeros when closed). */
  bulkStats(): BulkStats {
    if (this.bulk) return { ...this.bulk.stats };
    return {
      active: false,
      fresh: false,
      members: 0,
      reconcileSkipped: 0,
      reconcileProbed: 0,
      ftsDeleteSkipped: 0,
    };
  }

  // ─── Live-graph write batches (non-rebuild ingests) ────────────────────────

  /**
   * Group a non-rebuild ingest's per-member writes into one transaction per
   * BATCH_TXN_MEMBERS members or BATCH_TXN_MAX_MS, whichever comes first.
   * Unlike beginBulk nothing about durability changes: indexes stay, and
   * synchronous / journal_mode keep their values, so a crash loses at most the
   * open (uncommitted) batch and leaves the last committed state intact.
   *
   * Each transaction starts lazily at batchMemberStart with BEGIN IMMEDIATE (the
   * write lock is taken up front, waiting up to BUSY_TIMEOUT_MS; a deferred
   * BEGIN could fail every later member with SQLITE_BUSY_SNAPSHOT after another
   * connection's commit) and is committed only between members, so a
   * concurrent reader sees each member whole or not at all. An idle timer
   * commits a transaction left open while the member stream is slow (a live
   * org's retrieve), so the lock is never held much past maxMs. The writes are
   * the same statements as without a batch, so the graph is identical.
   */
  beginBatch(opts: BeginBatchOptions = {}): void {
    if (this.bulk) throw new StorageError("beginBatch: a bulk window is open");
    if (this.batch) throw new StorageError("beginBatch: a batch window is already open");
    if (this.db.inTransaction) throw new StorageError("beginBatch: called inside a transaction");
    this.batch = {
      maxMembers: Math.max(1, opts.maxMembers ?? BATCH_TXN_MEMBERS),
      maxMs: Math.max(1, opts.maxMs ?? BATCH_TXN_MAX_MS),
      open: false,
      openedAt: 0,
      inTxn: 0,
      timer: null,
      stats: { active: true, members: 0, commits: 0, beginFailures: 0 },
    };
  }

  /** Before a member's writes: open the batch transaction if none is open. */
  batchMemberStart(): void {
    const batch = this.batch;
    if (!batch || batch.open || this.db.inTransaction) return;
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      // Another writer kept the lock past busy_timeout: this member is
      // written per statement, exactly as without a batch.
      batch.stats.beginFailures += 1;
      return;
    }
    batch.open = true;
    batch.openedAt = Date.now();
    batch.inTxn = 0;
    const timer = setTimeout(() => {
      batch.timer = null;
      // Fires only while the event loop is idle, i.e. between members.
      if (this.batch === batch && batch.open && this.db.inTransaction) {
        try {
          this.commitBatch(batch);
        } catch {
          /* retried at the next member boundary */
        }
      }
    }, batch.maxMs);
    timer.unref?.();
    batch.timer = timer;
  }

  /** After a member's writes: commit when the batch is full or old enough. */
  batchMemberDone(): void {
    const batch = this.batch;
    if (!batch) return;
    batch.stats.members += 1;
    if (!batch.open) return;
    if (!this.db.inTransaction) {
      // SQLite rolled back the batch (SQLITE_FULL / IOERR / NOMEM inside a
      // member's savepoint): every member since the last commit is lost.
      this.clearBatchTimer(batch);
      batch.open = false;
      throw new StorageError(
        "batch transaction was rolled back by SQLite; members written since the last commit were lost",
      );
    }
    batch.inTxn += 1;
    if (batch.inTxn >= batch.maxMembers || Date.now() - batch.openedAt >= batch.maxMs) {
      this.commitBatch(batch);
    }
  }

  private clearBatchTimer(batch: BatchState): void {
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
  }

  private commitBatch(batch: BatchState): void {
    this.clearBatchTimer(batch);
    if (batch.open && this.db.inTransaction) {
      this.db.exec("COMMIT");
      batch.stats.commits += 1;
    }
    batch.open = false;
  }

  /** Close the batch window, committing the open transaction. No-op when closed. */
  endBatch(): void {
    const batch = this.batch;
    if (!batch) return;
    this.batch = null;
    this.commitBatch(batch);
  }

  /** Snapshot of the current batch window's counters (inactive zeros when closed). */
  batchStats(): BatchStats {
    if (this.batch) return { ...this.batch.stats };
    return { active: false, members: 0, commits: 0, beginFailures: 0 };
  }

  searchNodesFts(
    orgId: OrgId,
    query: string,
    k: number,
    opts: { label?: string } = {},
  ): Array<{ qname: string; label: string }> {
    if (k <= 0) return [];
    // Build an OR of the query's word tokens (recall-oriented). splitIdentifierWords
    // applies the SAME camelCase/snake_case splitting the index body uses, so
    // `AccountController` matches the indexed "account controller". Each token is
    // a quoted FTS5 string literal so punctuation/operators can't be injected
    // into the MATCH grammar.
    const tokens = Array.from(
      new Set(splitIdentifierWords(query).map((t) => t.toLowerCase())),
    ).slice(0, 32);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"`).join(" OR ");
    try {
      const rows = this.db
        .prepare(
          `SELECT qualified_name AS qname, label
             FROM _sfgraph_node_fts
            WHERE org_id = ? AND body MATCH ?${opts.label !== undefined ? " AND lower(label) = lower(?)" : ""}
            ORDER BY bm25(_sfgraph_node_fts)
            LIMIT ?`,
        )
        .all(
          ...(opts.label !== undefined ? [orgId, match, opts.label, k] : [orgId, match, k]),
        ) as Array<{ qname: string; label: string }>;
      return rows;
    } catch {
      return [];
    }
  }

  // ─── Task 11c: delta ingestion ────────────────────────────────────────────
  //
  // `_sfgraph_members` records, per member of a filesystem source, its key
  // (sourceUri), fingerprint (file sizes + mtimes), content hash and the
  // qnames it owns (nodes it emitted plus the sources of edges it emitted).
  // `_sfgraph_delta_pending` holds the qnames an in-flight delta is
  // rewriting; it is cleared when the delta completes, so a leftover row
  // means the previous delta was interrupted. `_sfgraph_member_generation`
  // records which sfgraph build wrote the rows: a delta under a different
  // build would mix old and new parser output, so it rebuilds instead. All
  // are created on first use (no schema-version bump: an older sfgraph simply
  // ignores them).

  private deltaTablesReady = false;
  private ensureDeltaTables(): void {
    if (this.deltaTablesReady) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS _sfgraph_members (
        org_id TEXT NOT NULL,
        member_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        hash TEXT NOT NULL,
        owned TEXT NOT NULL,
        PRIMARY KEY (org_id, member_key)
      );
      CREATE TABLE IF NOT EXISTS _sfgraph_member_generation (
        org_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _sfgraph_delta_pending (
        org_id TEXT PRIMARY KEY,
        qnames TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );`);
    this.deltaTablesReady = true;
  }

  listMemberRows(orgId: OrgId): MemberRow[] {
    this.ensureDeltaTables();
    const rows = this.stmt(
      "SELECT member_key, fingerprint, hash, owned FROM _sfgraph_members WHERE org_id = ?",
    ).all(orgId) as Array<{ member_key: string; fingerprint: string; hash: string; owned: string }>;
    return rows.map((r) => {
      let owned: string[] = [];
      try {
        const v = JSON.parse(r.owned) as unknown;
        if (Array.isArray(v)) owned = v.filter((x): x is string => typeof x === "string");
      } catch {
        owned = [];
      }
      return { key: r.member_key, fingerprint: r.fingerprint, hash: r.hash, owned };
    });
  }

  /**
   * Replace every member row of the org (a full ingest), stamped with the
   * `generation` (sfgraph build) whose parsers produced them.
   */
  replaceMemberRows(orgId: OrgId, rows: readonly MemberRow[], generation?: string): void {
    this.ensureDeltaTables();
    this.db.transaction(() => {
      this.stmt("DELETE FROM _sfgraph_members WHERE org_id = ?").run(orgId);
      this.writeMemberRows(orgId, rows);
      if (generation === undefined) {
        this.stmt("DELETE FROM _sfgraph_member_generation WHERE org_id = ?").run(orgId);
      } else {
        this.stmt(
          `INSERT INTO _sfgraph_member_generation(org_id, generation) VALUES (?, ?)
           ON CONFLICT(org_id) DO UPDATE SET generation = excluded.generation`,
        ).run(orgId, generation);
      }
    })();
  }

  /** The generation the org's member rows were written by, or null when unknown. */
  getMemberRowsGeneration(orgId: OrgId): string | null {
    this.ensureDeltaTables();
    const r = this.stmt("SELECT generation FROM _sfgraph_member_generation WHERE org_id = ?").get(
      orgId,
    ) as { generation: string } | undefined;
    return r?.generation ?? null;
  }

  upsertMemberRows(orgId: OrgId, rows: readonly MemberRow[]): void {
    this.ensureDeltaTables();
    this.db.transaction(() => this.writeMemberRows(orgId, rows))();
  }

  private writeMemberRows(orgId: OrgId, rows: readonly MemberRow[]): void {
    const st = this.stmt(
      `INSERT INTO _sfgraph_members(org_id, member_key, fingerprint, hash, owned) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, member_key) DO UPDATE SET fingerprint = excluded.fingerprint,
         hash = excluded.hash, owned = excluded.owned`,
    );
    for (const r of rows) st.run(orgId, r.key, r.fingerprint, r.hash, JSON.stringify(r.owned));
  }

  deleteMemberRows(orgId: OrgId, keys: readonly string[]): void {
    this.ensureDeltaTables();
    const st = this.stmt("DELETE FROM _sfgraph_members WHERE org_id = ? AND member_key = ?");
    this.db.transaction(() => {
      for (const k of keys) st.run(orgId, k);
    })();
  }

  clearMemberRows(orgId: OrgId): void {
    this.ensureDeltaTables();
    // Rows and their generation stamp go together (final review core M-4).
    this.db.transaction(() => {
      this.stmt("DELETE FROM _sfgraph_members WHERE org_id = ?").run(orgId);
      this.stmt("DELETE FROM _sfgraph_member_generation WHERE org_id = ?").run(orgId);
    })();
  }

  getDeltaPending(orgId: OrgId): string[] | null {
    this.ensureDeltaTables();
    const row = this.stmt("SELECT qnames FROM _sfgraph_delta_pending WHERE org_id = ?").get(
      orgId,
    ) as { qnames: string } | undefined;
    if (!row) return null;
    try {
      const v = JSON.parse(row.qnames) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  setDeltaPending(orgId: OrgId, qnames: readonly string[]): void {
    this.ensureDeltaTables();
    this.stmt(
      `INSERT INTO _sfgraph_delta_pending(org_id, qnames, started_at) VALUES (?, ?, ?)
       ON CONFLICT(org_id) DO UPDATE SET qnames = excluded.qnames, started_at = excluded.started_at`,
    ).run(orgId, JSON.stringify(qnames), Date.now());
  }

  clearDeltaPending(orgId: OrgId): void {
    this.ensureDeltaTables();
    this.stmt("DELETE FROM _sfgraph_delta_pending WHERE org_id = ?").run(orgId);
  }

  /** The subset of `qnames` that exist as nodes (stored spelling). */
  existingQnames(orgId: OrgId, qnames: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const slice of chunks([...qnames], 400)) {
      const rows = this.stmt(
        `SELECT qualified_name FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name IN (${slice.map(() => "?").join(",")})`,
      ).all(orgId, ...slice) as Array<{ qualified_name: string }>;
      for (const r of rows) out.add(r.qualified_name);
    }
    return out;
  }

  /** Stored spellings of the nodes matching `qnames` case-insensitively. */
  existingQnamesNocase(orgId: OrgId, qnames: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const slice of chunks([...qnames], 400)) {
      const rows = this.stmt(
        `SELECT qualified_name FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name COLLATE NOCASE IN (${slice.map(() => "?").join(",")})`,
      ).all(orgId, ...slice) as Array<{ qualified_name: string }>;
      for (const r of rows) out.add(r.qualified_name);
    }
    return out;
  }

  /** Overwrite the source_hash of existing nodes (delta's stale sentinel). */
  setNodeSourceHash(orgId: OrgId, qnames: Iterable<string>, hash: string): number {
    this.syncCaches();
    let n = 0;
    this.db.transaction(() => {
      for (const slice of chunks([...qnames], 400)) {
        const rows = this.stmt(
          `SELECT qualified_name, label FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name IN (${slice.map(() => "?").join(",")})`,
        ).all(orgId, ...slice) as Array<{ qualified_name: string; label: string }>;
        for (const r of rows) {
          const tbl = this.nodeLabelCache.get(r.label);
          if (!tbl) continue;
          n += this.stmt(
            `UPDATE ${tbl} SET source_hash = ? WHERE org_id = ? AND qualified_name = ?`,
          ).run(hash, orgId, r.qualified_name).changes;
        }
      }
    })();
    return n;
  }

  /** source_hash and last_modified_at of existing nodes, keyed by stored qname. */
  getNodeStamps(orgId: OrgId, qnames: Iterable<string>): Map<string, NodeStamp> {
    this.syncCaches();
    const out = new Map<string, NodeStamp>();
    for (const slice of chunks([...qnames], 400)) {
      const rows = this.stmt(
        `SELECT qualified_name, label FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name IN (${slice.map(() => "?").join(",")})`,
      ).all(orgId, ...slice) as Array<{ qualified_name: string; label: string }>;
      for (const r of rows) {
        const tbl = this.nodeLabelCache.get(r.label);
        if (!tbl) continue;
        const row = this.stmt(
          `SELECT source_hash AS h, last_modified_at AS m FROM ${tbl} WHERE org_id = ? AND qualified_name = ?`,
        ).get(orgId, r.qualified_name) as { h: string; m: number } | undefined;
        if (row) out.set(r.qualified_name, { hash: row.h, lastModifiedAt: row.m });
      }
    }
    return out;
  }

  /**
   * Put recorded stamps back. `when: "hash-is"` restores both fields on nodes
   * whose source_hash is currently `hash` (a sentinel nobody re-emitted);
   * `when: "unchanged"` restores last_modified_at on nodes whose source_hash
   * equals the recorded one (re-merged with identical content).
   */
  restoreNodeStamps(
    orgId: OrgId,
    stamps: ReadonlyMap<string, NodeStamp>,
    cond: { when: "hash-is"; hash: string } | { when: "unchanged" },
  ): number {
    this.syncCaches();
    let n = 0;
    this.db.transaction(() => {
      for (const slice of chunks([...stamps.keys()], 400)) {
        const rows = this.stmt(
          `SELECT qualified_name, label FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name IN (${slice.map(() => "?").join(",")})`,
        ).all(orgId, ...slice) as Array<{ qualified_name: string; label: string }>;
        for (const r of rows) {
          const tbl = this.nodeLabelCache.get(r.label);
          const st = stamps.get(r.qualified_name);
          if (!tbl || !st) continue;
          n +=
            cond.when === "hash-is"
              ? this.stmt(
                  `UPDATE ${tbl} SET source_hash = ?, last_modified_at = ? WHERE org_id = ? AND qualified_name = ? AND source_hash = ?`,
                ).run(st.hash, st.lastModifiedAt, orgId, r.qualified_name, cond.hash).changes
              : this.stmt(
                  `UPDATE ${tbl} SET last_modified_at = ? WHERE org_id = ? AND qualified_name = ? AND source_hash = ? AND last_modified_at <> ?`,
                ).run(st.lastModifiedAt, orgId, r.qualified_name, st.hash, st.lastModifiedAt)
                  .changes;
        }
      }
    })();
    return n;
  }

  listNodesWithSourceHash(orgId: OrgId, hash: string): string[] {
    this.syncCaches();
    const out: string[] = [];
    for (const tbl of this.nodeLabelCache.values()) {
      const rows = this.stmt(
        `SELECT qualified_name FROM ${tbl} WHERE org_id = ? AND source_hash = ?`,
      ).all(orgId, hash) as Array<{ qualified_name: string }>;
      for (const r of rows) out.push(r.qualified_name);
    }
    return out;
  }

  /** Delete every outgoing edge of `srcs` (any pass); returns what was deleted. */
  deleteEdgesFrom(orgId: OrgId, srcs: Iterable<string>): DeletedEdge[] {
    this.syncCaches();
    const out: DeletedEdge[] = [];
    const all = [...srcs];
    if (all.length === 0) return out;
    this.db.transaction(() => {
      for (const [relType, tbl] of this.edgeRelCache) {
        for (const slice of chunks(all, 400)) {
          const ph = slice.map(() => "?").join(",");
          const rows = this.stmt(
            `SELECT src_qname, dst_qname, first_seen_at FROM ${tbl} WHERE org_id = ? AND src_qname IN (${ph})`,
          ).all(orgId, ...slice) as Array<{
            src_qname: string;
            dst_qname: string;
            first_seen_at: number;
          }>;
          if (rows.length === 0) continue;
          this.stmt(`DELETE FROM ${tbl} WHERE org_id = ? AND src_qname IN (${ph})`).run(
            orgId,
            ...slice,
          );
          for (const r of rows) {
            out.push({ relType, src: r.src_qname, dst: r.dst_qname, firstSeenAt: r.first_seen_at });
          }
        }
      }
    })();
    return out;
  }

  /** Edges (any rel type) whose dst is one of `dsts`. */
  listEdgesToAny(orgId: OrgId, dsts: Iterable<string>): EdgeFact[] {
    this.syncCaches();
    const out: EdgeFact[] = [];
    const all = [...dsts];
    if (all.length === 0) return out;
    for (const [relType, tbl] of this.edgeRelCache) {
      for (const slice of chunks(all, 400)) {
        const rows = this.stmt(
          `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND dst_qname IN (${slice.map(() => "?").join(",")})`,
        ).all(orgId, ...slice) as RawEdgeRow[];
        for (const r of rows) out.push(rowToEdge(r, relType as RelType));
      }
    }
    return out;
  }

  /** Edges of `relType` whose src is one of `srcs` (NOCASE, like listEdgesFrom). */
  listEdgesFromAny(orgId: OrgId, srcs: Iterable<string>, relType: RelType): EdgeFact[] {
    this.syncCaches();
    const out: EdgeFact[] = [];
    const tbl = this.edgeRelCache.get(relType);
    const all = [...srcs];
    if (!tbl || all.length === 0) return out;
    for (const slice of chunks(all, 400)) {
      const rows = this.stmt(
        `SELECT org_id, src_qname, dst_qname, attributes, first_seen_at, last_seen_at FROM ${tbl} WHERE org_id = ? AND src_qname IN (${slice.map(() => "?").join(",")})`,
      ).all(orgId, ...slice) as RawEdgeRow[];
      for (const r of rows) out.push(rowToEdge(r, relType));
    }
    return out;
  }

  /**
   * Whether any node of `labels` has attributes JSON text containing one of
   * `needles` (a plain substring test, so a superset of "has that key").
   * Reads the text only, no JSON parse; stops at the first hit.
   */
  anyNodeAttributesContain(
    orgId: OrgId,
    labels: readonly string[],
    needles: readonly string[],
  ): boolean {
    this.syncCaches();
    if (needles.length === 0) return false;
    const cond = needles.map(() => "instr(attributes, ?) > 0").join(" OR ");
    for (const label of labels) {
      const tbl = this.nodeLabelCache.get(label);
      if (!tbl) continue;
      if (
        this.stmt(`SELECT 1 FROM ${tbl} WHERE org_id = ? AND (${cond}) LIMIT 1`).get(
          orgId,
          ...needles,
        )
      )
        return true;
    }
    return false;
  }

  /** `anyNodeAttributesContain` for the edges of `relTypes`. */
  anyEdgeAttributesContain(orgId: OrgId, relTypes: readonly string[], needle: string): boolean {
    this.syncCaches();
    for (const rel of relTypes) {
      const tbl = this.edgeRelCache.get(rel);
      if (!tbl) continue;
      if (
        this.stmt(`SELECT 1 FROM ${tbl} WHERE org_id = ? AND instr(attributes, ?) > 0 LIMIT 1`).get(
          orgId,
          needle,
        )
      )
        return true;
    }
    return false;
  }

  /**
   * Sum of `attributes[attr]` over the nodes of `labels` where it is a
   * number > 0, in listNodesByLabel order (label by label).
   */
  sumPositiveNodeAttribute(orgId: OrgId, labels: readonly string[], attr: string): number {
    this.syncCaches();
    const path = `$.${JSON.stringify(attr)}`;
    let sum = 0;
    for (const label of labels) {
      const tbl = this.nodeLabelCache.get(label);
      if (!tbl) continue;
      const rows = this.stmt(
        `SELECT json_type(attributes, ?) AS t, json_extract(attributes, ?) AS v FROM ${tbl} WHERE org_id = ? AND instr(attributes, ?) > 0`,
      ).all(path, path, orgId, JSON.stringify(attr)) as Array<{ t: string | null; v: unknown }>;
      for (const r of rows) {
        if ((r.t === "integer" || r.t === "real") && typeof r.v === "number" && r.v > 0) sum += r.v;
      }
    }
    return sum;
  }

  /**
   * Stored qnames (as `_sfgraph_node_index` spells them) of the org's nodes
   * whose `attributes[attr]` is JSON `true` — exactly the nodes for which
   * `getNode(q)?.attributes[attr] === true`, read in one pass per label.
   */
  listNodesWithTrueAttribute(orgId: OrgId, attr: string): Set<string> {
    this.syncCaches();
    const out = new Set<string>();
    const path = `$.${JSON.stringify(attr)}`;
    for (const [label, tbl] of this.nodeLabelCache) {
      const rows = this.stmt(
        `SELECT i.qualified_name AS q FROM _sfgraph_node_index i
           JOIN ${tbl} t ON t.org_id = i.org_id AND t.qualified_name = i.qualified_name
          WHERE i.org_id = ? AND i.label = ? AND json_type(t.attributes, ?) = 'true'`,
      ).all(orgId, label, path) as Array<{ q: string }>;
      for (const r of rows) out.add(r.q);
    }
    return out;
  }

  /**
   * Delete reflection-walker edges (`source: "reflection"` REFERENCES) of the
   * org: those FROM `srcs` and/or INTO `dsts`; with neither, all of them.
   */
  deleteReflectionEdges(
    orgId: OrgId,
    scope: { srcs?: Iterable<string>; dsts?: Iterable<string> } = {},
  ): number {
    this.syncCaches();
    const tbl = this.edgeRelCache.get("REFERENCES");
    if (!tbl) return 0;
    const isRefl = "json_extract(attributes, '$.source') = 'reflection'";
    let n = 0;
    this.db.transaction(() => {
      if (!scope.srcs && !scope.dsts) {
        n += this.stmt(`DELETE FROM ${tbl} WHERE org_id = ? AND ${isRefl}`).run(orgId).changes;
        return;
      }
      for (const [col, list] of [
        ["src_qname", scope.srcs],
        ["dst_qname", scope.dsts],
      ] as const) {
        if (!list) continue;
        for (const slice of chunks([...list], 400)) {
          n += this.stmt(
            `DELETE FROM ${tbl} WHERE org_id = ? AND ${col} IN (${slice.map(() => "?").join(",")}) AND ${isRefl}`,
          ).run(orgId, ...slice).changes;
        }
      }
    })();
    return n;
  }

  /**
   * Qnames of nodes whose attributes JSON contains one of `needles` as a whole
   * JSON string (case-insensitive for ASCII). A superset of the nodes whose
   * attribute string values equal a needle — the reflection walker's input.
   */
  findNodesMentioning(orgId: OrgId, needles: readonly string[]): Set<string> {
    this.syncCaches();
    const out = new Set<string>();
    if (needles.length === 0) return out;
    const likeEsc = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pats = needles.map((nd) => `%${likeEsc(JSON.stringify(nd))}%`);
    for (const tbl of this.nodeLabelCache.values()) {
      for (const slice of chunks(pats, 50)) {
        const rows = this.stmt(
          `SELECT qualified_name FROM ${tbl} WHERE org_id = ? AND (${slice.map(() => "attributes LIKE ? ESCAPE '\\'").join(" OR ")})`,
        ).all(orgId, ...slice) as Array<{ qualified_name: string }>;
        for (const r of rows) out.add(r.qualified_name);
      }
    }
    return out;
  }

  /** `src|dst` (lower-cased) of every resolver-emitted (`resolvedBy`) REFERENCES edge. */
  listResolverReferencePairs(orgId: OrgId): Set<string> {
    this.syncCaches();
    const out = new Set<string>();
    const tbl = this.edgeRelCache.get("REFERENCES");
    if (!tbl) return out;
    const rows = this.stmt(
      `SELECT src_qname, dst_qname FROM ${tbl} WHERE org_id = ? AND json_extract(attributes, '$.resolvedBy') IS NOT NULL`,
    ).all(orgId) as Array<{ src_qname: string; dst_qname: string }>;
    for (const r of rows) out.add(`${r.src_qname}${KSEP}${r.dst_qname}`.toLowerCase());
    return out;
  }

  /** `src|dst` (lower-cased) of every CANONICAL_OF edge. */
  listCanonicalPairs(orgId: OrgId): Set<string> {
    this.syncCaches();
    const out = new Set<string>();
    const tbl = this.edgeRelCache.get("CANONICAL_OF");
    if (!tbl) return out;
    const rows = this.stmt(`SELECT src_qname, dst_qname FROM ${tbl} WHERE org_id = ?`).all(
      orgId,
    ) as Array<{ src_qname: string; dst_qname: string }>;
    for (const r of rows) out.add(`${r.src_qname}${KSEP}${r.dst_qname}`.toLowerCase());
    return out;
  }

  /** Lower an edge's first_seen_at to `firstSeenAt` (re-created edges keep their history). */
  restoreEdgeFirstSeen(orgId: OrgId, edges: readonly DeletedEdge[]): void {
    this.syncCaches();
    this.db.transaction(() => {
      for (const e of edges) {
        const tbl = this.edgeRelCache.get(e.relType);
        if (!tbl) continue;
        this.stmt(
          `UPDATE ${tbl} SET first_seen_at = ? WHERE org_id = ? AND src_qname = ? AND dst_qname = ? AND first_seen_at > ?`,
        ).run(e.firstSeenAt, orgId, e.src, e.dst, e.firstSeenAt);
      }
    })();
  }

  // Helpers for shared usage
  getNodeLabelTables(): Map<string, string> {
    this.syncCaches();
    return new Map(this.nodeLabelCache);
  }

  getEdgeRelTables(): Map<string, string> {
    this.syncCaches();
    return new Map(this.edgeRelCache);
  }

  // For tests/diagnostics
  _explainReverseEdgeQuery(relType: RelType): string {
    this.syncCaches();
    const tbl = this.edgeRelCache.get(relType);
    if (!tbl) throw new StorageError(`unknown rel type ${relType}`);
    const rows = this.db
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${tbl} WHERE org_id = ? AND dst_qname = ?`)
      .all("o", "x") as Array<{ detail: string }>;
    return rows.map((r) => r.detail).join(" | ");
  }
}
