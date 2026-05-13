import type { OrgId } from "@sfgraph/shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface SecurityAudit {
  sharingFullAccess: string[];
  fieldAccessMatrix: Array<{ field: string; grantedBy: string[] }>;
  flsGaps: string[];
}

export function securityAudit(store: GraphStore, orgId: OrgId): SecurityAudit {
  const sharingFullAccess: string[] = [];
  // SharingRule attribute scan
  for (const n of store.listNodesByLabel(orgId, METADATA_CATEGORY.SHARING_RULE, 5000)) {
    const a = n.attributes as Record<string, unknown>;
    if (a.access === "Edit" || a.accessLevel === "Edit" || a.accessLevel === "All") {
      sharingFullAccess.push(n.qualifiedName);
    }
  }

  // Field access matrix
  const fieldAccessMatrix = new Map<string, Set<string>>();
  for (const n of store.listNodesByLabel(orgId, METADATA_CATEGORY.PERMISSION_SET, 5000)) {
    const grants = store.listEdgesFrom(orgId, n.qualifiedName, REL_TYPES.GRANTS_FIELD_ACCESS);
    for (const e of grants) {
      let set = fieldAccessMatrix.get(e.dstQualifiedName);
      if (!set) {
        set = new Set();
        fieldAccessMatrix.set(e.dstQualifiedName, set);
      }
      set.add(n.qualifiedName);
    }
  }

  // FLS gaps: fields with no grants
  const flsGaps: string[] = [];
  for (const n of store.listNodesByLabel(orgId, METADATA_CATEGORY.FIELD, 5000)) {
    if (!fieldAccessMatrix.has(n.qualifiedName)) flsGaps.push(n.qualifiedName);
  }

  return {
    sharingFullAccess,
    fieldAccessMatrix: Array.from(fieldAccessMatrix.entries()).map(([field, set]) => ({
      field,
      grantedBy: Array.from(set),
    })),
    flsGaps,
  };
}
