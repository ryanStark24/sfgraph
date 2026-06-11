import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";
import type Database from "better-sqlite3";
import type { EdgeFact, NodeFact, Org, RelType, Snapshot } from "../domain/index.js";

export type BetterSqlite3Database = Database.Database;

export interface Migration {
  version: number;
  description: string;
  up(db: BetterSqlite3Database): void;
}

export interface MergeResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /**
   * Outgoing edges pruned by source reconciliation (see
   * {@link MergeEdgesOptions.reconcileSources}). Absent/0 when reconciliation
   * was not requested.
   */
  deleted?: number;
}

export interface MergeEdgesOptions {
  /**
   * Treat this batch as the COMPLETE authoritative set of OUTGOING edges for
   * every source qname it contains. After upserting, any pre-existing outgoing
   * edge from one of those sources that is NOT in this batch is pruned —
   * fixing "immortal edges" (a SOQL/DML/CALLS edge that lingers forever after
   * the source method stops emitting it on re-ingest).
   *
   * Only safe when the caller passes a source's FULL outgoing edge set (e.g. a
   * single parser's per-member ParseResult). Additive callers (arity / overlap
   * / reflection resolvers, which contribute partial edges for already-ingested
   * sources) must leave this off, or they would delete each other's edges.
   * Inbound edges (dst = one of these sources) are never touched, so edges from
   * other not-yet-reparsed callers survive.
   */
  reconcileSources?: boolean;
}

export type SnippetSourceFormat = "apex" | "js" | "html" | "xml" | "json" | "flow" | "soql";

export interface SnippetRecord {
  orgId: OrgId;
  qualifiedName: QualifiedName;
  sourceFormat: SnippetSourceFormat;
  sourceText: string;
  startLine?: number;
  endLine?: number;
  sourceHash: Sha256;
  llmExplanation?: string;
  explainedAt?: number;
}

export interface SnippetUpsertResult {
  inserted: boolean;
  updated: boolean;
  unchanged: boolean;
}

/**
 * W1.5-08: combined sync-state snapshot read by MCP tool responses so
 * concurrent readers can detect "the graph is currently being rewritten"
 * without requiring a global ingest transaction or snapshot isolation.
 *
 * - `generation` is monotonic across successful ingests. It does NOT
 *   change when an ingest fails (markSyncFailed leaves it alone).
 * - `in_progress` is true while an ingest holds the org (between
 *   markSyncStarted and markSyncComplete/Failed).
 * - `started_at` is the ISO timestamp of the in-flight ingest, or null
 *   when no ingest is running.
 * - `last_sync_at` is the unix-ms timestamp of the last successful
 *   completion (the existing `last_synced_at` column).
 */
export interface SyncStatus {
  generation: number;
  in_progress: boolean;
  started_at: string | null;
  last_sync_at: number | null;
}

export interface GraphStore {
  init(): Promise<void>;
  close(): Promise<void>;
  upsertOrg(org: Org): void;
  getOrg(id: OrgId): Org | null;
  touchSync(orgId: OrgId, iso: string): void;
  /**
   * W1.5-08 lifecycle: flag the start of an ingest. Sets `sync_in_progress = 1`
   * and `sync_started_at = NOW_ISO`. Does NOT increment `sync_generation`
   * yet — the counter only advances on successful completion via
   * `markSyncComplete`. Called from the very top of the ingest function so
   * concurrent MCP readers see `staleness.in_progress: true` for the entire
   * sync duration.
   */
  markSyncStarted(orgId: OrgId, startedAtIso: string): void;
  /**
   * W1.5-08 lifecycle: flag a successful ingest completion. In one
   * transaction: increments `sync_generation` by 1, clears
   * `sync_in_progress`, clears `sync_started_at`, and updates
   * `last_synced_at` to the supplied completion timestamp. Pairs with
   * `markSyncStarted`; intentionally distinct from `markSyncFailed`
   * because the generation counter must only advance on success.
   */
  markSyncComplete(orgId: OrgId, completedAtIso: string): void;
  /**
   * W1.5-08 lifecycle: flag an ingest that threw. Clears
   * `sync_in_progress` and `sync_started_at` but leaves both
   * `sync_generation` and `last_synced_at` unchanged so failed runs do
   * not look like fresh data to readers.
   */
  markSyncFailed(orgId: OrgId): void;
  /**
   * W1.5-08: combined sync-state read used by the MCP tool dispatcher to
   * attach a `staleness` block on every response. Returns sensible
   * defaults (generation=0, in_progress=false, both timestamps null) when
   * the org row does not exist yet so callers do not need to special-case
   * "first ingest hasn't run".
   */
  getSyncStatus(orgId: OrgId): SyncStatus;
  deleteNode(orgId: OrgId, qname: QualifiedName): void;
  deleteEdgesFor(orgId: OrgId, qname: QualifiedName): void;
  mergeNodes(facts: NodeFact[]): MergeResult;
  mergeEdges(facts: EdgeFact[], opts?: MergeEdgesOptions): MergeResult;
  getNode(orgId: OrgId, qname: QualifiedName): NodeFact | null;
  listNodesByLabel(orgId: OrgId, label: string, limit?: number): NodeFact[];
  listEdgesFrom(orgId: OrgId, src: QualifiedName, relType?: RelType): EdgeFact[];
  listEdgesTo(orgId: OrgId, dst: QualifiedName, relType?: RelType): EdgeFact[];
  /** Find edges whose dst_qname matches a SQL LIKE pattern (e.g. `ApexMethod:%(?)`).
   *  Optional relType narrows the search to a single edge table; otherwise every
   *  known table is scanned. Used by post-merge resolvers (arity, dangling-edge audit). */
  listEdgesByDstLike(orgId: OrgId, pattern: string, relType?: RelType, limit?: number): EdgeFact[];
  /** Delete a specific edge. No-op if it doesn't exist. */
  deleteEdge(orgId: OrgId, src: QualifiedName, dst: QualifiedName, relType: RelType): void;
  /** Edges whose dst_qname has no row in `_sfgraph_node_index`. Used by the
   *  dangling-edge audit and `sfgraph audit` CLI. */
  listDanglingEdges(orgId: OrgId, limit?: number): EdgeFact[];
  listAllQnames(orgId: OrgId): QualifiedName[];
  /** Distinct node labels known to the store (across all orgs). Used by
   *  find-nodes glob matching to enumerate label tables. */
  listAllLabels(): string[];
  countNodes(orgId: OrgId): number;
  /** Count nodes of a given label for `orgId`. Returns 0 if the label table
   *  has not yet been created. Used by the W1.5-07 detect-deletions guard
   *  to compute per-label drop ratios before mass-wiping nodes. */
  countNodesByLabel(orgId: OrgId, label: string): number;
  countEdges(orgId: OrgId): number;
  transaction<T>(fn: () => T): T;
  upsertSnippet(rec: SnippetRecord): SnippetUpsertResult;
  getSnippet(orgId: OrgId, qname: QualifiedName): SnippetRecord | null;
  updateSnippetExplanation(
    orgId: OrgId,
    qname: QualifiedName,
    llmExplanation: string,
    explainedAt: number,
  ): boolean;
  listSnippetsMissingExplanation(orgId: OrgId, limit?: number): SnippetRecord[];
  /** Upsert a node's FTS keyword document (the embed-text body). No-op if FTS5
   *  is unavailable. Keyed by (orgId, qname). */
  upsertNodeFts(orgId: OrgId, qname: QualifiedName, label: string, body: string): void;
  /** Keyword search over node FTS docs, ranked best-first (bm25). Returns up to
   *  `k` hits; [] if FTS5 is unavailable or the query is empty. */
  searchNodesFts(orgId: OrgId, query: string, k: number): Array<{ qname: string; label: string }>;
}

export interface VectorUpsertResult {
  inserted: boolean;
  deduped: boolean;
}

export interface NodeSearchHit {
  qname: QualifiedName;
  label: string;
  distance: number;
}

export interface BundleSearchHit {
  bundleId: string;
  distance: number;
}

export interface VectorStore {
  init(): Promise<void>;
  close(): Promise<void>;
  upsertNodeVector(
    orgId: OrgId,
    qname: QualifiedName,
    label: string,
    vector: Float32Array,
    contentHash: Sha256,
  ): VectorUpsertResult;
  upsertBundleVector(
    orgId: OrgId,
    bundleId: string,
    vector: Float32Array,
    contentHash: Sha256,
  ): VectorUpsertResult;
  searchNodes(
    orgId: OrgId,
    query: Float32Array,
    k: number,
    opts?: { label?: string },
  ): NodeSearchHit[];
  searchBundles(orgId: OrgId, query: Float32Array, k: number): BundleSearchHit[];
  countNodeVectors(orgId: OrgId): number;
  /** Return the stored embedding for a node, or null if no vector exists
   *  for this (orgId, qname). Used by tools that find "more like this"
   *  starting from an existing graph node rather than a free-text query. */
  getNodeVector(orgId: OrgId, qname: QualifiedName): Float32Array | null;
  /** Delete a node's vector + meta row. Returns true if a vector existed.
   *  Called when a node is removed from the graph so it stops appearing as a
   *  phantom "similar" result. */
  deleteNodeVector(orgId: OrgId, qname: QualifiedName): boolean;
  /** content_hash of the node's stored vector, or null. Lets the embedding
   *  queue skip re-running the model when the text is unchanged. */
  getContentHash(orgId: OrgId, qname: QualifiedName): Sha256 | null;
}

export interface NodeDiff {
  added: NodeFact[];
  removed: NodeFact[];
  changed: Array<{ before: NodeFact; after: NodeFact }>;
}

export interface EdgeDiff {
  added: EdgeFact[];
  removed: EdgeFact[];
}

export interface SnapshotStore {
  init(): Promise<void>;
  createSnapshot(orgId: OrgId, label: string, isAuto: boolean): Snapshot;
  listSnapshots(orgId: OrgId): Snapshot[];
  getSnapshot(id: string): Snapshot | null;
  deleteSnapshot(id: string): void;
  diffNodes(orgId: OrgId, fromId: string | "current", toId: string | "current"): NodeDiff;
  diffEdges(orgId: OrgId, fromId: string | "current", toId: string | "current"): EdgeDiff;
  prune(orgId: OrgId, retainDays: number): number;
}
