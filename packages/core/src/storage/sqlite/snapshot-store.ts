import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { StorageError, asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import Database from "better-sqlite3";
import type { EdgeFact, NodeFact, RelType, Snapshot } from "../../domain/index.js";
import type {
  BetterSqlite3Database,
  EdgeDiff,
  EdgeDiffPage,
  NodeDiff,
  SnapshotStore,
} from "../interfaces.js";
import { wrapAbiError } from "./load-better-sqlite3.js";
import { MIGRATIONS, MigrationRunner } from "./migrations.js";
import { advanceEdges, advanceNodes, visibleAt } from "./snapshot-versions.js";

// any[]: statements take positional or named (@param) bindings.
type Statement = Database.Statement<any[]>;
type Side = typeof CURRENT | { seq: number };
const CURRENT = Symbol("current");

const NODE_COLS = (a: string, prefix = "") =>
  [
    "org_id",
    "qualified_name",
    "label",
    "attributes",
    "source_hash",
    "first_seen_at",
    "last_seen_at",
    "last_modified_at",
  ]
    .map((c) => `${a}.${c}${prefix ? ` AS ${prefix}${c}` : ""}`)
    .join(", ");
const EDGE_COLS = (a: string) =>
  ["org_id", "src_qname", "dst_qname", "rel_type", "attributes", "first_seen_at", "last_seen_at"]
    .map((c) => `${a}.${c}`)
    .join(", ");

const EDGE_ORDER = "src_qname COLLATE BINARY, dst_qname COLLATE BINARY, rel_type";

/** One query of an edge diff: `SELECT ${cols} ${body}` (see edgeParts). */
interface EdgePart {
  cols: string;
  body: string;
  params: Record<string, unknown>;
}

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

/**
 * Code-point order of two keys (= SQLite BINARY on UTF-8). UTF-16 code-unit
 * order differs only where a surrogate meets U+E000..U+FFFF; remap those.
 */
function cmp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const fix = (c: number) =>
        c >= 0xd800 && c <= 0xdfff ? c + 0x2000 : c >= 0xe000 ? c - 0x800 : c;
      return fix(x) - fix(y);
    }
  }
  return a.length - b.length;
}
const byNodeKey = (a: NodeSnapshotRow, b: NodeSnapshotRow): number =>
  cmp(a.qualified_name, b.qualified_name) || cmp(a.label, b.label);
const byEdgeKey = (a: EdgeSnapshotRow, b: EdgeSnapshotRow): number =>
  cmp(a.src_qname, b.src_qname) || cmp(a.dst_qname, b.dst_qname) || cmp(a.rel_type, b.rel_type);

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

  private readonly stmts = new Map<string, Statement>();
  private stmt(sql: string): Statement {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  private getNodeLabelTables(): Map<string, string> {
    const out = new Map<string, string>();
    const rows = this.stmt("SELECT label, table_name FROM _sfgraph_node_labels").all() as Array<{
      label: string;
      table_name: string;
    }>;
    for (const r of rows) out.set(r.label, r.table_name);
    return out;
  }

  private getEdgeRelTables(): Map<string, string> {
    const out = new Map<string, string>();
    const rows = this.stmt("SELECT rel_type, table_name FROM _sfgraph_edge_types").all() as Array<{
      rel_type: string;
      table_name: string;
    }>;
    for (const r of rows) out.set(r.rel_type, r.table_name);
    return out;
  }

  /**
   * perf-03: record only what changed since the org's previous snapshot
   * (see snapshot-versions.ts). An unchanged graph adds no version rows.
   */
  createSnapshot(orgId: OrgId, label: string, isAuto: boolean): Snapshot {
    const id = `snap_${randomUUID()}`;
    const createdAt = Date.now();
    const apply = this.db.transaction(() => {
      const seq = (
        this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM _sfgraph_snapshots").get() as {
          s: number;
        }
      ).s;
      this.db
        .prepare(
          "INSERT INTO _sfgraph_snapshots(id, org_id, label, created_at, is_auto, seq) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, orgId, label, createdAt, isAuto ? 1 : 0, seq);
      const params = { org: orgId, seq };
      // Versions whose label / rel type no longer has a live table are gone.
      this.db
        .prepare(
          `UPDATE _sfgraph_snap_nodes SET to_seq = @seq
            WHERE org_id = @org AND to_seq IS NULL
              AND label NOT IN (SELECT label FROM _sfgraph_node_labels)`,
        )
        .run(params);
      this.db
        .prepare(
          `UPDATE _sfgraph_snap_edges SET to_seq = @seq
            WHERE org_id = @org AND to_seq IS NULL
              AND rel_type NOT IN (SELECT rel_type FROM _sfgraph_edge_types)`,
        )
        .run(params);
      for (const [lbl, tbl] of this.getNodeLabelTables()) {
        advanceNodes(
          this.db,
          {
            src: `${tbl} c`,
            srcWhere: "c.org_id = @org",
            labelExpr: "@lbl",
            labelFilter: "v.label = @lbl",
          },
          { ...params, lbl },
        );
      }
      for (const [rt, tbl] of this.getEdgeRelTables()) {
        advanceEdges(
          this.db,
          {
            src: `${tbl} c`,
            srcWhere: "c.org_id = @org",
            relExpr: "@rt",
            relFilter: "v.rel_type = @rt",
          },
          { ...params, rt },
        );
      }
    });
    // review minor 1: take the write lock at BEGIN (the seq read and the
    // version writes must not race another writer; a deferred upgrade can BUSY).
    apply.immediate();
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

  /**
   * Drop the snapshot, garbage-collect versions no remaining snapshot can see
   * (only those visible at the deleted seq can have become unreachable), and
   * reopen versions closed after the org's new latest snapshot so the open set
   * is again that snapshot's state.
   */
  deleteSnapshot(id: string): void {
    const apply = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT org_id, seq FROM _sfgraph_snapshots WHERE id = ?")
        .get(id) as { org_id: string; seq: number } | undefined;
      this.db.prepare("DELETE FROM _sfgraph_snapshots WHERE id = ?").run(id);
      if (!row) return;
      const params = { org: row.org_id, seq: row.seq };
      for (const t of ["_sfgraph_snap_nodes", "_sfgraph_snap_edges"]) {
        this.db
          .prepare(
            `DELETE FROM ${t} AS v
              WHERE v.org_id = @org AND ${visibleAt("v", "seq")}
                AND NOT EXISTS (SELECT 1 FROM _sfgraph_snapshots s
                                 WHERE s.org_id = v.org_id AND s.seq >= v.from_seq
                                   AND (v.to_seq IS NULL OR s.seq < v.to_seq))`,
          )
          .run(params);
        this.db
          .prepare(
            `UPDATE ${t} SET to_seq = NULL
              WHERE org_id = @org AND to_seq IS NOT NULL
                AND to_seq > (SELECT COALESCE(MAX(seq), 0) FROM _sfgraph_snapshots WHERE org_id = @org)`,
          )
          .run({ org: row.org_id });
      }
    });
    // review minor 1: take the write lock at BEGIN (the seq read and the
    // version writes must not race another writer; a deferred upgrade can BUSY).
    apply.immediate();
  }

  /**
   * A diff side: the live graph, or a snapshot's seq. A snapshot of another
   * org reads as empty (seq -1 matches no version), as the old
   * `snapshot_id AND org_id` filter did.
   */
  private side(orgId: OrgId, id: string | "current"): Side {
    if (id === "current") return CURRENT;
    const row = this.db
      .prepare("SELECT org_id, seq FROM _sfgraph_snapshots WHERE id = ?")
      .get(id) as { org_id: string; seq: number } | undefined;
    if (!row) throw new StorageError(`snapshot ${id} not found`);
    return { seq: row.org_id === orgId ? row.seq : -1 };
  }

  // perf-02: diffs run in SQL; only differing rows reach JS (and JSON.parse).
  // review I6: every query has an explicit ORDER BY, and results combined
  // across label / rel tables are sorted by key (byNodeKey / byEdgeKey), so
  // truncated tool output (point_in_time_diff, what_broke) is stable.

  /** Node rows of side `x` whose qualified name (BINARY) is absent from side `y`. */
  private nodesOnlyIn(orgId: OrgId, x: Side, y: Side): NodeSnapshotRow[] {
    if (x === CURRENT && y === CURRENT) return [];
    const labels = this.getNodeLabelTables();
    const out: NodeSnapshotRow[] = [];
    if (x === CURRENT) {
      const ys = (y as { seq: number }).seq;
      for (const [lbl, tbl] of labels) {
        const rows = this.stmt(
          `SELECT c.org_id, c.qualified_name, @lbl AS label, c.attributes, c.source_hash,
                  c.first_seen_at, c.last_seen_at, c.last_modified_at
             FROM ${tbl} c
            WHERE c.org_id = @org
              AND NOT EXISTS (SELECT 1 FROM _sfgraph_snap_nodes w
                               WHERE w.org_id = c.org_id AND w.qualified_name = c.qualified_name
                                 AND ${visibleAt("w", "ys")})
            ORDER BY qualified_name COLLATE BINARY, label`,
        ).all({ org: orgId, lbl, ys }) as NodeSnapshotRow[];
        out.push(...rows);
      }
      return out.sort(byNodeKey);
    }
    const xs = x.seq;
    if (y !== CURRENT) {
      return (
        this.stmt(
          `SELECT ${NODE_COLS("v")} FROM _sfgraph_snap_nodes v
          WHERE v.org_id = @org AND ${visibleAt("v", "xs")}
            AND NOT EXISTS (SELECT 1 FROM _sfgraph_snap_nodes w
                             WHERE w.org_id = v.org_id AND w.qualified_name = v.qualified_name
                               AND ${visibleAt("w", "ys")})
            ORDER BY qualified_name COLLATE BINARY, label`,
        ).all({ org: orgId, xs, ys: y.seq }) as NodeSnapshotRow[]
      ).sort(byNodeKey);
    }
    // Snapshot rows missing from the live graph. Probe the row's own label
    // table first; a candidate may still be live under another label (a label
    // change), which the node index tells us.
    const candidates: NodeSnapshotRow[] = [];
    for (const [lbl, tbl] of labels) {
      const rows = this.stmt(
        `SELECT ${NODE_COLS("v")} FROM _sfgraph_snap_nodes v
          WHERE v.org_id = @org AND v.label = @lbl AND ${visibleAt("v", "xs")}
            AND NOT EXISTS (SELECT 1 FROM ${tbl} c
                             WHERE c.org_id = v.org_id AND c.qualified_name = v.qualified_name
                               AND c.qualified_name = v.qualified_name COLLATE BINARY)
            ORDER BY qualified_name COLLATE BINARY, label`,
      ).all({ org: orgId, lbl, xs }) as NodeSnapshotRow[];
      candidates.push(...rows);
    }
    candidates.push(
      ...(this.stmt(
        `SELECT ${NODE_COLS("v")} FROM _sfgraph_snap_nodes v
          WHERE v.org_id = @org AND ${visibleAt("v", "xs")}
            AND v.label NOT IN (SELECT label FROM _sfgraph_node_labels)
            ORDER BY qualified_name COLLATE BINARY, label`,
      ).all({ org: orgId, xs }) as NodeSnapshotRow[]),
    );
    const idx = this.stmt(
      "SELECT label FROM _sfgraph_node_index WHERE org_id = ? AND qualified_name = ?",
    );
    for (const r of candidates) {
      const live = idx.get(orgId, r.qualified_name) as { label: string } | undefined;
      const tbl = live && live.label !== r.label ? labels.get(live.label) : undefined;
      const present =
        tbl !== undefined &&
        this.stmt(
          `SELECT 1 FROM ${tbl} WHERE org_id = ? AND qualified_name = ?
              AND qualified_name = ? COLLATE BINARY`,
        ).get(orgId, r.qualified_name, r.qualified_name) !== undefined;
      if (!present) out.push(r);
    }
    return out.sort(byNodeKey);
  }

  /** Pairs present on both sides whose source hash differs. */
  private nodesChanged(
    orgId: OrgId,
    from: Side,
    to: Side,
  ): Array<{ before: NodeSnapshotRow; after: NodeSnapshotRow }> {
    if (from === CURRENT && to === CURRENT) return [];
    const out: Array<{ before: NodeSnapshotRow; after: NodeSnapshotRow }> = [];
    const split = (r: Record<string, unknown>) => {
      const a: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (k.startsWith("a_")) a[k.slice(2)] = v;
        else if (k.startsWith("b_")) b[k.slice(2)] = v;
      }
      return [a as unknown as NodeSnapshotRow, b as unknown as NodeSnapshotRow] as const;
    };
    if (from !== CURRENT && to !== CURRENT) {
      if (from.seq === to.seq) return [];
      const rows = this.stmt(
        `SELECT ${NODE_COLS("a", "a_")}, ${NODE_COLS("b", "b_")}
           FROM _sfgraph_snap_nodes a
           JOIN _sfgraph_snap_nodes b
             ON b.org_id = a.org_id AND b.qualified_name = a.qualified_name
            AND ${visibleAt("b", "ts")}
          WHERE a.org_id = @org AND ${visibleAt("a", "fs")} AND NOT ${visibleAt("a", "ts")}
            AND b.source_hash <> a.source_hash COLLATE BINARY
          ORDER BY a.qualified_name, a.label, b.label`,
      ).all({ org: orgId, fs: from.seq, ts: to.seq }) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const [before, after] = split(r);
        out.push({ before, after });
      }
      return out.sort((p, q) => byNodeKey(p.before, q.before) || byNodeKey(p.after, q.after));
    }
    // CROSS JOIN pins the live table as the outer loop: with v outer, the
    // BINARY `v.qualified_name` cannot seek c's NOCASE key and every version
    // row scanned the whole label table (50k nodes: ~230 s). Pairs match by
    // qname across labels on purpose: a label move with a new hash is
    // "changed", as with the old full copies.
    const snapSeq = (from === CURRENT ? to : from) as { seq: number };
    for (const [lbl, tbl] of this.getNodeLabelTables()) {
      const rows = this.stmt(
        `SELECT c.org_id AS a_org_id, c.qualified_name AS a_qualified_name, @lbl AS a_label,
                c.attributes AS a_attributes, c.source_hash AS a_source_hash,
                c.first_seen_at AS a_first_seen_at, c.last_seen_at AS a_last_seen_at,
                c.last_modified_at AS a_last_modified_at, ${NODE_COLS("v", "b_")}
           FROM ${tbl} c
           CROSS JOIN _sfgraph_snap_nodes v
             ON v.org_id = c.org_id AND v.qualified_name = c.qualified_name
            AND ${visibleAt("v", "ss")}
          WHERE c.org_id = @org AND c.source_hash <> v.source_hash COLLATE BINARY
          ORDER BY c.qualified_name COLLATE BINARY, v.label`,
      ).all({ org: orgId, lbl, ss: snapSeq.seq }) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const [live, snapped] = split(r);
        out.push(
          from === CURRENT ? { before: live, after: snapped } : { before: snapped, after: live },
        );
      }
    }
    return out.sort((p, q) => byNodeKey(p.before, q.before) || byNodeKey(p.after, q.after));
  }

  /**
   * The queries whose union is the edge rows of side `x` whose (src, dst, rel)
   * key (BINARY) is absent from side `y`. Each part is `FROM ... WHERE ...`
   * plus its select list and bindings, so a caller can fetch all rows, the
   * first n rows (`ORDER BY ... LIMIT`) or a `COUNT(*)` from the same SQL.
   * The version key / rel indexes cover every column these predicates read
   * (schema v15), so a count never touches the version table's rows.
   */
  private edgeParts(orgId: OrgId, x: Side, y: Side): EdgePart[] {
    if (x === CURRENT && y === CURRENT) return [];
    const rels = this.getEdgeRelTables();
    const parts: EdgePart[] = [];
    if (x === CURRENT) {
      const ys = (y as { seq: number }).seq;
      for (const [rt, tbl] of rels) {
        parts.push({
          cols: `c.org_id, c.src_qname, c.dst_qname, @rt AS rel_type, c.attributes,
                    c.first_seen_at, c.last_seen_at`,
          body: `FROM ${tbl} c
              WHERE c.org_id = @org
                AND NOT EXISTS (SELECT 1 FROM _sfgraph_snap_edges w
                                 WHERE w.org_id = c.org_id AND w.src_qname = c.src_qname
                                   AND w.dst_qname = c.dst_qname AND w.rel_type = @rt
                                   AND ${visibleAt("w", "ys")})`,
          params: { org: orgId, rt, ys },
        });
      }
      return parts;
    }
    const xs = x.seq;
    if (y !== CURRENT) {
      return [
        {
          cols: EDGE_COLS("v"),
          body: `FROM _sfgraph_snap_edges v
          WHERE v.org_id = @org AND ${visibleAt("v", "xs")}
            AND NOT EXISTS (SELECT 1 FROM _sfgraph_snap_edges w
                             WHERE w.org_id = v.org_id AND w.src_qname = v.src_qname
                               AND w.dst_qname = v.dst_qname AND w.rel_type = v.rel_type
                               AND ${visibleAt("w", "ys")})`,
          params: { org: orgId, xs, ys: y.seq },
        },
      ];
    }
    // INDEXED BY: with ORDER BY ... LIMIT the planner may prefer walking the
    // key index (already in src/dst order) over the whole org's versions,
    // once per rel type; the rel index reads only this rel's rows.
    for (const [rt, tbl] of rels) {
      parts.push({
        cols: EDGE_COLS("v"),
        body: `FROM _sfgraph_snap_edges v INDEXED BY _sfgraph_snap_edges_rel
            WHERE v.org_id = @org AND v.rel_type = @rt AND ${visibleAt("v", "xs")}
              AND NOT EXISTS (SELECT 1 FROM ${tbl} c
                               WHERE c.org_id = v.org_id AND c.src_qname = v.src_qname
                                 AND c.dst_qname = v.dst_qname
                                 AND c.src_qname = v.src_qname COLLATE BINARY
                                 AND c.dst_qname = v.dst_qname COLLATE BINARY)`,
        params: { org: orgId, rt, xs },
      });
    }
    parts.push({
      cols: EDGE_COLS("v"),
      body: `FROM _sfgraph_snap_edges v
          WHERE v.org_id = @org AND ${visibleAt("v", "xs")}
            AND v.rel_type NOT IN (SELECT rel_type FROM _sfgraph_edge_types)`,
      params: { org: orgId, xs },
    });
    return parts;
  }

  /** Edge rows of side `x` whose (src, dst, rel) key (BINARY) is absent from side `y`. */
  private edgesOnlyIn(orgId: OrgId, x: Side, y: Side): EdgeSnapshotRow[] {
    const out: EdgeSnapshotRow[] = [];
    for (const p of this.edgeParts(orgId, x, y)) {
      out.push(
        ...(this.stmt(`SELECT ${p.cols} ${p.body} ORDER BY ${EDGE_ORDER}`).all(
          p.params,
        ) as EdgeSnapshotRow[]),
      );
    }
    return out.sort(byEdgeKey);
  }

  /**
   * The first `limit` rows of {@link edgesOnlyIn} (same order) and its exact
   * length, without materialising the rest: each part is counted in SQL and,
   * when non-empty, returns at most `limit` rows in key order. `counts` holds
   * per-part counts already known: `exact` ones are used as is; an `upper`
   * bound of 0 proves the part empty, any other bound is recounted.
   */
  private edgesOnlyInPage(
    orgId: OrgId,
    x: Side,
    y: Side,
    limit: number,
    counts?: { exact?: ReadonlyArray<number>; upper?: ReadonlyArray<number> },
  ): { rows: EdgeSnapshotRow[]; count: number } {
    const lim = Math.max(0, Math.floor(limit));
    const rows: EdgeSnapshotRow[] = [];
    let count = 0;
    for (const [i, p] of this.edgeParts(orgId, x, y).entries()) {
      // Count first (index-only); most parts are empty and need no page.
      const n =
        counts?.exact?.[i] ??
        (counts?.upper?.[i] === 0
          ? 0
          : (this.stmt(`SELECT COUNT(*) AS n ${p.body}`).get(p.params) as { n: number }).n);
      count += n;
      if (n === 0 || lim === 0) continue;
      rows.push(
        ...(this.stmt(`SELECT ${p.cols} ${p.body} ORDER BY ${EDGE_ORDER} LIMIT @lim`).all({
          ...p.params,
          lim,
        }) as EdgeSnapshotRow[]),
      );
    }
    return { rows: rows.sort(byEdgeKey).slice(0, lim), count };
  }

  /**
   * Per rel type (the order of `edgeParts(snap, CURRENT)`, without its last
   * unregistered-rel part), an upper bound on the number of snapshot edges
   * absent from the live table, from the live-only count `curOnly` (the order
   * of `edgeParts(CURRENT, snap)`): |snap| - (|live| - |live \ snap|).
   * |live| - |live \ snap| counts live rows with a matching snapshot row;
   * live keys are unique, so at least as many snapshot rows match, and the
   * bound holds whatever the snapshot holds. A bound of 0 proves the part
   * empty without the anti-join; any other bound is recounted.
   */
  private snapOnlyUpperBounds(
    orgId: OrgId,
    snapSeq: number,
    curOnly: ReadonlyArray<number>,
  ): number[] {
    return [...this.getEdgeRelTables()].map(([rt, tbl], i) => {
      const live = (
        this.stmt(`SELECT COUNT(*) AS n FROM ${tbl} WHERE org_id = @org`).get({ org: orgId }) as {
          n: number;
        }
      ).n;
      const snap = (
        this.stmt(
          `SELECT COUNT(*) AS n FROM _sfgraph_snap_edges v INDEXED BY _sfgraph_snap_edges_rel
            WHERE v.org_id = @org AND v.rel_type = @rt AND ${visibleAt("v", "xs")}`,
        ).get({ org: orgId, rt, xs: snapSeq }) as { n: number }
      ).n;
      return Math.max(0, snap - (live - (curOnly[i] ?? 0)));
    });
  }

  /** Index-only count of every part of {@link edgeParts}(x, y). */
  private edgePartCounts(orgId: OrgId, x: Side, y: Side): number[] {
    return this.edgeParts(orgId, x, y).map(
      (p) => (this.stmt(`SELECT COUNT(*) AS n ${p.body}`).get(p.params) as { n: number }).n,
    );
  }

  diffNodes(orgId: OrgId, fromId: string | "current", toId: string | "current"): NodeDiff {
    const from = this.side(orgId, fromId);
    const to = this.side(orgId, toId);
    return {
      added: this.nodesOnlyIn(orgId, to, from).map(nodeFromSnapshotRow),
      removed: this.nodesOnlyIn(orgId, from, to).map(nodeFromSnapshotRow),
      changed: this.nodesChanged(orgId, from, to).map((c) => ({
        before: nodeFromSnapshotRow(c.before),
        after: nodeFromSnapshotRow(c.after),
      })),
    };
  }

  diffEdges(orgId: OrgId, fromId: string | "current", toId: string | "current"): EdgeDiff {
    const from = this.side(orgId, fromId);
    const to = this.side(orgId, toId);
    return {
      added: this.edgesOnlyIn(orgId, to, from).map(edgeFromSnapshotRow),
      removed: this.edgesOnlyIn(orgId, from, to).map(edgeFromSnapshotRow),
    };
  }

  diffEdgesPage(
    orgId: OrgId,
    fromId: string | "current",
    toId: string | "current",
    limit: number,
  ): EdgeDiffPage {
    // One read transaction: every count and page sees the same state.
    return this.db.transaction((): EdgeDiffPage => {
      const from = this.side(orgId, fromId);
      const to = this.side(orgId, toId);
      // Against the live graph, count the live-only side by anti-join and
      // bound the snapshot-only side's per-rel counts (`snapOnlyUpperBounds`).
      type Counts = { exact?: number[]; upper?: number[] };
      let addedCounts: Counts | undefined;
      let removedCounts: Counts | undefined;
      if (from !== CURRENT && to === CURRENT) {
        const exact = this.edgePartCounts(orgId, to, from);
        addedCounts = { exact };
        removedCounts = { upper: this.snapOnlyUpperBounds(orgId, from.seq, exact) };
      } else if (from === CURRENT && to !== CURRENT) {
        const exact = this.edgePartCounts(orgId, from, to);
        removedCounts = { exact };
        addedCounts = { upper: this.snapOnlyUpperBounds(orgId, to.seq, exact) };
      }
      const added = this.edgesOnlyInPage(orgId, to, from, limit, addedCounts);
      const removed = this.edgesOnlyInPage(orgId, from, to, limit, removedCounts);
      return {
        added: added.rows.map(edgeFromSnapshotRow),
        removed: removed.rows.map(edgeFromSnapshotRow),
        addedCount: added.count,
        removedCount: removed.count,
      };
    })();
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
