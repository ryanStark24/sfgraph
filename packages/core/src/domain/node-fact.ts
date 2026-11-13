import type { OrgId, QualifiedName, Sha256 } from "@ryanstark24/sfgraph-shared";

export interface NodeFact {
  orgId: OrgId;
  qualifiedName: QualifiedName;
  label: string;
  attributes: Record<string, unknown>;
  sourceHash: Sha256;
  firstSeenAt: number;
  lastSeenAt: number;
  lastModifiedAt: number;
  /**
   * True when `lastModifiedAt` is the source's own change time (a commit time,
   * a file mtime, an org LastModifiedDate), false/absent when it is only the
   * ingest-time fallback. Merge-time only, never stored: an unchanged-hash
   * node takes an authoritative stamp (heal or advance) and keeps its stored
   * value against a fallback.
   */
  lastModifiedAuthoritative?: boolean;
}
