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

export interface GraphStore {
  init(): Promise<void>;
  close(): Promise<void>;
  upsertOrg(org: Org): void;
  getOrg(id: OrgId): Org | null;
  touchSync(orgId: OrgId, iso: string): void;
  deleteNode(orgId: OrgId, qname: QualifiedName): void;
  deleteEdgesFor(orgId: OrgId, qname: QualifiedName): void;
  mergeNodes(facts: NodeFact[]): MergeResult;
  mergeEdges(facts: EdgeFact[]): MergeResult;
  getNode(orgId: OrgId, qname: QualifiedName): NodeFact | null;
  listNodesByLabel(orgId: OrgId, label: string, limit?: number): NodeFact[];
  listEdgesFrom(orgId: OrgId, src: QualifiedName, relType?: RelType): EdgeFact[];
  listEdgesTo(orgId: OrgId, dst: QualifiedName, relType?: RelType): EdgeFact[];
  /** Find edges whose dst_qname matches a SQL LIKE pattern (e.g. `ApexMethod:%(?)`).
   *  Optional relType narrows the search to a single edge table; otherwise every
   *  known table is scanned. Used by post-merge resolvers (arity, dangling-edge audit). */
  listEdgesByDstLike(
    orgId: OrgId,
    pattern: string,
    relType?: RelType,
    limit?: number,
  ): EdgeFact[];
  /** Delete a specific edge. No-op if it doesn't exist. */
  deleteEdge(
    orgId: OrgId,
    src: QualifiedName,
    dst: QualifiedName,
    relType: RelType,
  ): void;
  /** Edges whose dst_qname has no row in `_sfgraph_node_index`. Used by the
   *  dangling-edge audit and `sfgraph audit` CLI. */
  listDanglingEdges(orgId: OrgId, limit?: number): EdgeFact[];
  listAllQnames(orgId: OrgId): QualifiedName[];
  /** Distinct node labels known to the store (across all orgs). Used by
   *  find-nodes glob matching to enumerate label tables. */
  listAllLabels(): string[];
  countNodes(orgId: OrgId): number;
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
