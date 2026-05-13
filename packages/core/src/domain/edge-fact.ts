import type { OrgId, QualifiedName } from "@sfgraph/shared";
import type { RelType } from "./rel-types.js";

export interface EdgeFact {
  orgId: OrgId;
  srcQualifiedName: QualifiedName;
  dstQualifiedName: QualifiedName;
  relType: RelType;
  attributes: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
}
