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
}
