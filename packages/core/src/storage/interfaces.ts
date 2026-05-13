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
  listAllQnames(orgId: OrgId): QualifiedName[];
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
