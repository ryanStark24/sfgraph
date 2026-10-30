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
  /**
   * Task 11c (N-5): extra source qnames this reconcile batch is authoritative
   * for even though it carries no edge from them (a method whose only call
   * was removed). Their outgoing parser edges are pruned like any batch
   * source's. A batch with no facts but extras still reconciles.
   */
  reconcileExtraSrcs?: { orgId: OrgId | string; qnames: readonly string[] };
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

/** A source-bearing Apex unit addressable from a Salesforce stack frame. */
export interface ApexFrameCandidate extends SnippetRecord {
  /** `class` for an `Class.Foo.method: line N` frame; `trigger` for `Trigger.Foo: line N`. */
  frameKind: "class" | "trigger";
  /** The Apex class or trigger name exactly as indexed. */
  ownerName: string;
  /** The method name for a class frame; absent for a trigger frame. */
  memberName?: string;
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

/** One dangling edge as stored: `attributes` is the raw JSON text. */
export interface DanglingEdgeRow {
  relType: string;
  src: string;
  dst: string;
  attributes: string;
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
  /** The qualified names `listNodesByLabel` would return, in the same order,
   *  without reading the rest of each row. Optional. */
  listQnamesByLabel?(orgId: OrgId, label: string, limit?: number): QualifiedName[];
  listEdgesFrom(orgId: OrgId, src: QualifiedName, relType?: RelType): EdgeFact[];
  listEdgesTo(orgId: OrgId, dst: QualifiedName, relType?: RelType): EdgeFact[];
  /** Edges (any rel type) whose dst is one of `dsts` (NOCASE, like listEdgesTo).
   *  Optional: callers fall back to one listEdgesTo per dst. */
  listEdgesToAny?(orgId: OrgId, dsts: Iterable<string>): EdgeFact[];
  /** Edges of `relType` whose src is one of `srcs` (NOCASE, like listEdgesFrom).
   *  Optional: callers fall back to one listEdgesFrom per src. */
  listEdgesFromAny?(orgId: OrgId, srcs: Iterable<string>, relType: RelType): EdgeFact[];
  /** Stored qnames of nodes whose `attributes[attr]` is JSON `true` (the nodes
   *  for which `getNode(q)?.attributes[attr] === true`). Optional. */
  listNodesWithTrueAttribute?(orgId: OrgId, attr: string): Set<string>;
  /** Find edges whose dst_qname matches a SQL LIKE pattern (e.g. `ApexMethod:%(?)`).
   *  Optional relType narrows the search to a single edge table; otherwise every
   *  known table is scanned. Used by post-merge resolvers (arity, dangling-edge audit). */
  listEdgesByDstLike(orgId: OrgId, pattern: string, relType?: RelType, limit?: number): EdgeFact[];
  /** Delete a specific edge. No-op if it doesn't exist. */
  deleteEdge(orgId: OrgId, src: QualifiedName, dst: QualifiedName, relType: RelType): void;
  /** Edges whose dst_qname has no row in `_sfgraph_node_index`. Used by the
   *  dangling-edge audit and `sfgraph audit` CLI. */
  listDanglingEdges(orgId: OrgId, limit?: number): EdgeFact[];
  /** The same edges, in the same order, as `listDanglingEdges`, streamed one
   *  row at a time with the attributes left as JSON text. The connection is
   *  busy until the iterator finishes or is closed: do not query the store
   *  from inside the loop. */
  iterateDanglingEdges(orgId: OrgId, limit?: number): IterableIterator<DanglingEdgeRow>;
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
  /**
   * Read source-bearing Apex units by their stack-frame identity. The lookup
   * uses a persistent SQLite index, not a qname glob, so it stays bounded on
   * large org graphs and can discriminate overloads by source line.
   */
  findApexFrameCandidates(
    orgId: OrgId,
    frame: { kind: "class" | "trigger"; ownerName: string; memberName?: string },
  ): ApexFrameCandidate[];
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
  /** `opts.label` (case-insensitive) filters before the LIMIT (T15 I-7). */
  searchNodesFts(
    orgId: OrgId,
    query: string,
    k: number,
    opts?: { label?: string },
  ): Array<{ qname: string; label: string }>;
  /** Rebuild bulk-load window (Task 10). Optional: lightweight/mock stores omit
   *  it and ingest takes the per-member path. See SqliteGraphStore.beginBulk. */
  beginBulk?(opts?: { freshOrgId?: OrgId; batchTransactions?: boolean }): void;
  /** Close the bulk window (commit, rebuild deferred indexes, synchronous=NORMAL). */
  endBulk?(): void;
  /** Advance the bulk window by one member (commits every 2,000). */
  bulkMemberDone?(): void;
  /** Live-graph write batches for non-rebuild ingests. Optional, like the bulk
   *  window. See SqliteGraphStore.beginBatch. */
  beginBatch?(opts?: { maxMembers?: number; maxMs?: number }): void;
  /** Open the batch transaction (if none is open) before a member's writes. */
  batchMemberStart?(): void;
  /** After a member's writes: commit when the batch is full or old enough. */
  batchMemberDone?(): void;
  /** Close the batch window, committing the open transaction. */
  endBatch?(): void;
  /** True when the org has no nodes, edges or FTS docs. */
  isOrgEmpty?(orgId: OrgId): boolean;
  /** Task 11a: flag the org's vectors as still being written. */
  setEmbeddingsPending?(orgId: OrgId, pending: boolean): void;
  /** Task 11a: pending flag plus the org's embedded-text total (FTS docs). */
  getEmbeddingStatus?(orgId: OrgId): { pending: boolean; total: number } | null;
  /** Task 11a: the org's FTS docs (qname, label, exact embed text). */
  listFtsDocs?(orgId: OrgId): Iterable<{ qname: string; label: string; body: string }>;
  /** Task 11c: per-member rows of a filesystem source (delta ingest). */
  listMemberRows?(orgId: OrgId): MemberRow[];
  /** Task 11c: replace every member row of the org (a full ingest), stamped with its generation. */
  replaceMemberRows?(orgId: OrgId, rows: readonly MemberRow[], generation?: string): void;
  /** Task 11c: drop every member row of the org (an aborted full ingest). */
  clearMemberRows?(orgId: OrgId): void;
  /** Task 11c: delete every outgoing edge (any pass) of `srcs`. */
  deleteEdgesFrom?(
    orgId: OrgId,
    srcs: Iterable<string>,
  ): Array<{ relType: string; src: string; dst: string; firstSeenAt: number }>;
  /** Task 11c: delete reflection-walker edges from `srcs` / into `dsts` (neither: all). */
  deleteReflectionEdges?(
    orgId: OrgId,
    scope?: { srcs?: Iterable<string>; dsts?: Iterable<string> },
  ): number;
}

/**
 * Task 11c: one member of a filesystem source as recorded by the last
 * ingest: its key (sourceUri), fingerprint (file sizes + mtimes), content
 * hash and the qnames it owns (nodes it emitted plus sources of edges it
 * emitted). An errored member has empty fingerprint and hash.
 */
export interface MemberRow {
  key: string;
  fingerprint: string;
  hash: string;
  owned: string[];
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
  /** Run `fn` in one transaction, so a batch of upserts costs one commit. */
  transaction?<T>(fn: () => T): T;
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

/** The first `limit` entries of each {@link EdgeDiff} bucket (same order) plus
 *  the buckets' exact sizes. */
export interface EdgeDiffPage extends EdgeDiff {
  addedCount: number;
  removedCount: number;
}

export interface SnapshotStore {
  init(): Promise<void>;
  createSnapshot(orgId: OrgId, label: string, isAuto: boolean): Snapshot;
  listSnapshots(orgId: OrgId): Snapshot[];
  getSnapshot(id: string): Snapshot | null;
  deleteSnapshot(id: string): void;
  diffNodes(orgId: OrgId, fromId: string | "current", toId: string | "current"): NodeDiff;
  diffEdges(orgId: OrgId, fromId: string | "current", toId: string | "current"): EdgeDiff;
  /** {@link diffEdges} cut to the first `limit` rows per bucket, with exact
   *  counts; cheaper than diffEdges on large graphs. */
  diffEdgesPage(
    orgId: OrgId,
    fromId: string | "current",
    toId: string | "current",
    limit: number,
  ): EdgeDiffPage;
  prune(orgId: OrgId, retainDays: number): number;
}
