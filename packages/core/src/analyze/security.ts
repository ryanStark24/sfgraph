import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface SecurityAudit {
  sharingFullAccess: string[];
  fieldAccessMatrix: Array<{ field: string; grantedBy: string[] }>;
  flsGaps: string[];
  /**
   * True when one of the underlying per-label scans hit
   * `SECURITY_PER_LABEL_CAP`. When set, results are incomplete and the
   * caller should narrow the scope (`object` / `field` filter) or paginate.
   */
  truncated?: boolean;
}

export const SECURITY_PER_LABEL_CAP = 5000;

export interface SecurityAuditOptions {
  /** Restrict the field-access matrix + FLS gaps to fields of this object (qualifiedName prefix, e.g. `CustomObject:Account`). */
  object?: string;
  /** Restrict to a single field qualifiedName (e.g. `CustomField:Account.Tier__c`). Implies `object`. */
  field?: string;
}

function matchesFilter(qname: string, opts: SecurityAuditOptions | undefined): boolean {
  if (!opts) return true;
  if (opts.field) return qname === opts.field;
  if (opts.object) {
    // Match `<anything>:<object>.<field>` heuristically. Strip the label
    // prefix before `:` so the caller can pass either the full qname
    // (`CustomObject:Account`) or just the object name (`Account`).
    const objName =
      (opts.object.includes(":") ? opts.object.split(":")[1] : opts.object) ?? opts.object;
    const tail = (qname.includes(":") ? qname.split(":")[1] : qname) ?? qname;
    return tail.startsWith(`${objName}.`) || tail === objName;
  }
  return true;
}

export function securityAudit(
  store: GraphStore,
  orgId: OrgId,
  opts?: SecurityAuditOptions,
): SecurityAudit {
  const sharingFullAccess: string[] = [];
  let truncated = false;
  // SharingRule attribute scan
  const sharingRules = store.listNodesByLabel(
    orgId,
    METADATA_CATEGORY.SHARING_RULE,
    SECURITY_PER_LABEL_CAP,
  );
  if (sharingRules.length >= SECURITY_PER_LABEL_CAP) truncated = true;
  for (const n of sharingRules) {
    const a = n.attributes as Record<string, unknown>;
    if (a.access === "Edit" || a.accessLevel === "Edit" || a.accessLevel === "All") {
      sharingFullAccess.push(n.qualifiedName);
    }
  }

  // Field access matrix
  const fieldAccessMatrix = new Map<string, Set<string>>();
  const permSets = store.listNodesByLabel(
    orgId,
    METADATA_CATEGORY.PERMISSION_SET,
    SECURITY_PER_LABEL_CAP,
  );
  if (permSets.length >= SECURITY_PER_LABEL_CAP) truncated = true;
  for (const n of permSets) {
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

  // FLS gaps: fields with no grants. Honour the object/field filter.
  const flsGaps: string[] = [];
  const fields = store.listNodesByLabel(orgId, METADATA_CATEGORY.FIELD, SECURITY_PER_LABEL_CAP);
  if (fields.length >= SECURITY_PER_LABEL_CAP) truncated = true;
  for (const n of fields) {
    if (!matchesFilter(n.qualifiedName, opts)) continue;
    if (!fieldAccessMatrix.has(n.qualifiedName)) flsGaps.push(n.qualifiedName);
  }

  // Filter the matrix too so a narrowed audit returns a narrowed matrix.
  const filteredMatrix = Array.from(fieldAccessMatrix.entries())
    .filter(([field]) => matchesFilter(field, opts))
    .map(([field, set]) => ({ field, grantedBy: Array.from(set) }));

  return {
    sharingFullAccess,
    fieldAccessMatrix: filteredMatrix,
    flsGaps,
    truncated,
  };
}
