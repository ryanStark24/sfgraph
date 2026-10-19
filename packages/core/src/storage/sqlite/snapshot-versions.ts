import type { BetterSqlite3Database } from "../interfaces.js";

/**
 * audit perf-02/03: snapshots are stored as row *versions* with a validity
 * interval over snapshot sequence numbers instead of one full copy per
 * snapshot. A version row is visible in the snapshot with sequence `s` when
 * `from_seq <= s AND (to_seq IS NULL OR to_seq > s)`. Open rows
 * (`to_seq IS NULL`) are the state recorded by the org's latest snapshot, so a
 * new snapshot only closes rows that changed and inserts their replacements:
 * an unchanged graph costs zero rows.
 *
 * A row is a new version when anything but `last_seen_at` changed. Every
 * ingest bumps `last_seen_at` on every node it re-merges, so including it
 * would copy the whole graph per snapshot again; a snapshot's `last_seen_at`
 * is therefore the value when that version was first recorded.
 *
 * Semantic change (review I6, schema v14): before v14 each snapshot stored the
 * `last_seen_at` its ingest wrote, so snapshot N could report a later value
 * than snapshot N-1 for an otherwise identical row. From v14, a node or edge
 * that did not change keeps the `last_seen_at` of the snapshot that first
 * recorded its current version, in diffs (NodeFact.lastSeenAt) and in the
 * `_sfgraph_node_snapshots` / `_sfgraph_edge_snapshots` views. The v14
 * migration applies the same rule to existing snapshots. Every other column
 * is preserved, and a change to `last_seen_at` alone was never reported as a
 * diff, so added / removed / changed sets are unaffected.
 *
 * Qualified names are compared BINARY here (as the old full-copy tables and
 * the old JS diff did); the live tables are NOCASE.
 */

const SNAPSHOT_VERSION_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS _sfgraph_snap_nodes (
    org_id TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    label TEXT NOT NULL,
    attributes TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    last_modified_at INTEGER NOT NULL,
    from_seq INTEGER NOT NULL,
    to_seq INTEGER
  );
  CREATE INDEX IF NOT EXISTS _sfgraph_snap_nodes_key
    ON _sfgraph_snap_nodes(org_id, qualified_name, label, to_seq);
  CREATE INDEX IF NOT EXISTS _sfgraph_snap_nodes_label
    ON _sfgraph_snap_nodes(org_id, label, to_seq);
  CREATE TABLE IF NOT EXISTS _sfgraph_snap_edges (
    org_id TEXT NOT NULL,
    src_qname TEXT NOT NULL,
    dst_qname TEXT NOT NULL,
    rel_type TEXT NOT NULL,
    attributes TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    from_seq INTEGER NOT NULL,
    to_seq INTEGER
  );
`;

/**
 * The snapshot edge version indexes (the one definition: created by
 * {@link SNAPSHOT_VERSION_DDL}, reshaped by {@link ensureSnapshotEdgeIndexes}).
 * Covering for the edge-diff anti-joins (schema v15, T14 batch L): the key
 * index ends in `from_seq`, so a probe "is key K visible at seq S" never reads
 * the version row; the rel index adds `from_seq, src_qname, dst_qname`, so
 * scanning one rel type's versions visible at S (to probe the live table)
 * reads the index only. Before v15 they were (org_id, src_qname, dst_qname,
 * rel_type, to_seq) and (org_id, rel_type, to_seq): the same prefixes, so
 * every plan that used them still applies.
 */
export const SNAP_EDGE_INDEXES: Readonly<Record<string, readonly string[]>> = {
  _sfgraph_snap_edges_key: ["org_id", "src_qname", "dst_qname", "rel_type", "to_seq", "from_seq"],
  _sfgraph_snap_edges_rel: ["org_id", "rel_type", "to_seq", "from_seq", "src_qname", "dst_qname"],
};

const createEdgeIndex = (name: string, cols: readonly string[]) =>
  `CREATE INDEX IF NOT EXISTS ${name} ON _sfgraph_snap_edges(${cols.join(", ")});`;

/** Tables and indexes of the versioned snapshot storage. */
export const SNAPSHOT_VERSION_DDL = `${SNAPSHOT_VERSION_TABLES_DDL}
  ${Object.entries(SNAP_EDGE_INDEXES)
    .map(([name, cols]) => createEdgeIndex(name, cols))
    .join("\n  ")}
`;

/**
 * Give each snapshot edge index the shape in {@link SNAP_EDGE_INDEXES},
 * rebuilding only an index whose columns differ (or that is missing).
 */
export function ensureSnapshotEdgeIndexes(db: BetterSqlite3Database): void {
  for (const [name, cols] of Object.entries(SNAP_EDGE_INDEXES)) {
    const have = (
      db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ seqno: number; name: string }>
    )
      .sort((x, y) => x.seqno - y.seqno)
      .map((r) => r.name);
    if (have.join(",") === cols.join(",")) continue;
    db.exec(`DROP INDEX IF EXISTS ${name}`);
    db.exec(createEdgeIndex(name, cols));
  }
}

/** Read-only views with the old full-copy table names and columns. */
export const SNAPSHOT_COMPAT_VIEWS_DDL = `
  CREATE VIEW IF NOT EXISTS _sfgraph_node_snapshots AS
    SELECT s.id AS snapshot_id, v.org_id, v.qualified_name, v.label, v.attributes,
           v.source_hash, v.first_seen_at, v.last_seen_at, v.last_modified_at
      FROM _sfgraph_snapshots s
      JOIN _sfgraph_snap_nodes v
        ON v.org_id = s.org_id AND v.from_seq <= s.seq AND (v.to_seq IS NULL OR v.to_seq > s.seq);
  CREATE VIEW IF NOT EXISTS _sfgraph_edge_snapshots AS
    SELECT s.id AS snapshot_id, v.org_id, v.src_qname, v.dst_qname, v.rel_type, v.attributes,
           v.first_seen_at, v.last_seen_at
      FROM _sfgraph_snapshots s
      JOIN _sfgraph_snap_edges v
        ON v.org_id = s.org_id AND v.from_seq <= s.seq AND (v.to_seq IS NULL OR v.to_seq > s.seq);
`;

/** SQL predicate: version alias `a` is visible at the seq bound to `@<param>`. */
export function visibleAt(a: string, param: string): string {
  return `(${a}.from_seq <= @${param} AND (${a}.to_seq IS NULL OR ${a}.to_seq > @${param}))`;
}

const NODE_MATCH = (a: string, b: string) =>
  `${a}.qualified_name = ${b}.qualified_name COLLATE BINARY
   AND ${a}.attributes = ${b}.attributes AND ${a}.source_hash = ${b}.source_hash
   AND ${a}.first_seen_at = ${b}.first_seen_at AND ${a}.last_modified_at = ${b}.last_modified_at`;
const EDGE_MATCH = (a: string, b: string) =>
  `${a}.src_qname = ${b}.src_qname COLLATE BINARY AND ${a}.dst_qname = ${b}.dst_qname COLLATE BINARY
   AND ${a}.attributes = ${b}.attributes AND ${a}.first_seen_at = ${b}.first_seen_at`;

/**
 * Advance the org's open versions to seq `@seq` from one source of node rows:
 * close open rows (of `labelFilter`) with no identical source row, then open
 * a version for each source row with no open row. `src` is a table/subquery
 * aliased `c` exposing the node columns (and `label` when `labelExpr` is
 * `c.label`); `srcWhere` restricts it.
 */
export function advanceNodes(
  db: BetterSqlite3Database,
  p: {
    src: string;
    srcWhere: string;
    labelExpr: string;
    labelFilter: string;
  },
  params: Record<string, unknown>,
): void {
  // `c.qualified_name = v.qualified_name` takes c's collation, so it uses the
  // live table's NOCASE key index; NODE_MATCH then requires a BINARY match.
  db.prepare(
    `UPDATE _sfgraph_snap_nodes AS v SET to_seq = @seq
      WHERE v.org_id = @org AND v.to_seq IS NULL AND ${p.labelFilter}
        AND NOT EXISTS (SELECT 1 FROM ${p.src} WHERE ${p.srcWhere} AND c.org_id = v.org_id
                          AND c.qualified_name = v.qualified_name AND ${p.labelExpr} = v.label AND ${NODE_MATCH("c", "v")})`,
  ).run(params);
  db.prepare(
    `INSERT INTO _sfgraph_snap_nodes(org_id, qualified_name, label, attributes, source_hash,
                                     first_seen_at, last_seen_at, last_modified_at, from_seq, to_seq)
     SELECT c.org_id, c.qualified_name, ${p.labelExpr}, c.attributes, c.source_hash,
            c.first_seen_at, c.last_seen_at, c.last_modified_at, @seq, NULL
       FROM ${p.src}
      WHERE ${p.srcWhere}
        AND NOT EXISTS (SELECT 1 FROM _sfgraph_snap_nodes w
                         WHERE w.org_id = c.org_id AND w.qualified_name = c.qualified_name
                           AND w.label = ${p.labelExpr} AND w.to_seq IS NULL)`,
  ).run(params);
}

/** Edge counterpart of {@link advanceNodes}; `relExpr` is the source's rel type. */
export function advanceEdges(
  db: BetterSqlite3Database,
  p: { src: string; srcWhere: string; relExpr: string; relFilter: string },
  params: Record<string, unknown>,
): void {
  db.prepare(
    `UPDATE _sfgraph_snap_edges AS v SET to_seq = @seq
      WHERE v.org_id = @org AND v.to_seq IS NULL AND ${p.relFilter}
        AND NOT EXISTS (SELECT 1 FROM ${p.src} WHERE ${p.srcWhere} AND c.org_id = v.org_id
                          AND c.src_qname = v.src_qname AND c.dst_qname = v.dst_qname
                          AND ${p.relExpr} = v.rel_type AND ${EDGE_MATCH("c", "v")})`,
  ).run(params);
  db.prepare(
    `INSERT INTO _sfgraph_snap_edges(org_id, src_qname, dst_qname, rel_type, attributes,
                                     first_seen_at, last_seen_at, from_seq, to_seq)
     SELECT c.org_id, c.src_qname, c.dst_qname, ${p.relExpr}, c.attributes,
            c.first_seen_at, c.last_seen_at, @seq, NULL
       FROM ${p.src}
      WHERE ${p.srcWhere}
        AND NOT EXISTS (SELECT 1 FROM _sfgraph_snap_edges w
                         WHERE w.org_id = c.org_id AND w.src_qname = c.src_qname
                           AND w.dst_qname = c.dst_qname AND w.rel_type = ${p.relExpr}
                           AND w.to_seq IS NULL)`,
  ).run(params);
}

/**
 * Migration body: number existing snapshots, convert their full copies into
 * versions (oldest first, same algorithm as createSnapshot), then replace the
 * old tables with compatibility views.
 */
export function migrateFullCopySnapshots(db: BetterSqlite3Database): void {
  db.exec("ALTER TABLE _sfgraph_snapshots ADD COLUMN seq INTEGER");
  const snaps = db
    .prepare("SELECT id, org_id FROM _sfgraph_snapshots ORDER BY created_at, id")
    .all() as Array<{ id: string; org_id: string }>;
  const setSeq = db.prepare("UPDATE _sfgraph_snapshots SET seq = ? WHERE id = ?");
  snaps.forEach((s, i) => setSeq.run(i + 1, s.id));
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS _sfgraph_snapshots_seq ON _sfgraph_snapshots(seq)");
  db.exec(SNAPSHOT_VERSION_DDL);
  const isTable = (name: string) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
  const hasNodes = isTable("_sfgraph_node_snapshots");
  const hasEdges = isTable("_sfgraph_edge_snapshots");
  // review I1: progress goes to stderr only (stdout is the MCP stdio channel).
  const t0 = Date.now();
  const log = (msg: string) => process.stderr.write(`sfgraph: ${msg}\n`);
  if (snaps.length > 0) {
    log(`schema v14: converting ${snaps.length} snapshot(s) to versioned storage...`);
  }
  snaps.forEach((s, i) => {
    const params = { org: s.org_id, seq: i + 1, sid: s.id };
    if (hasNodes) {
      advanceNodes(
        db,
        {
          src: "_sfgraph_node_snapshots c",
          srcWhere: "c.snapshot_id = @sid AND c.org_id = @org",
          labelExpr: "c.label",
          labelFilter: "1",
        },
        params,
      );
    }
    if (hasEdges) {
      advanceEdges(
        db,
        {
          src: "_sfgraph_edge_snapshots c",
          srcWhere: "c.snapshot_id = @sid AND c.org_id = @org",
          relExpr: "c.rel_type",
          relFilter: "1",
        },
        params,
      );
    }
    if (snaps.length > 1) log(`schema v14: snapshot ${i + 1}/${snaps.length} converted`);
  });
  if (snaps.length > 0) log(`schema v14: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  db.exec(
    "DROP TABLE IF EXISTS _sfgraph_node_snapshots; DROP TABLE IF EXISTS _sfgraph_edge_snapshots;",
  );
  db.exec(SNAPSHOT_COMPAT_VIEWS_DDL);
}
