import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface SecurityAudit {
  sharingFullAccess: string[];
  fieldAccessMatrix: Array<{ field: string; grantedBy: string[] }>;
  flsGaps: string[];
  /** FLS-gap rows suppressed as not-FLS-relevant (CMDT fields + standard
   *  system/audit fields). Surfaced so "0 real gaps" is distinguishable from
   *  "we hid everything". */
  flsGapsExcluded?: number;
  /**
   * True when one of the underlying per-label scans hit
   * `SECURITY_PER_LABEL_CAP`. When set, results are incomplete and the
   * caller should narrow the scope (`object` / `field` filter) or paginate.
   */
  truncated?: boolean;
}

export const SECURITY_PER_LABEL_CAP = 5000;

/** Standard system / audit field API names. These are never subject to the
 *  field-level security a developer cares about — flagging them as "FLS gaps"
 *  is pure noise (they dominated the gap list on a real org). */
const SYSTEM_FIELD_NAMES: ReadonlySet<string> = new Set([
  "Id",
  "Name",
  "OwnerId",
  "IsDeleted",
  "CreatedById",
  "CreatedDate",
  "LastModifiedById",
  "LastModifiedDate",
  "SystemModstamp",
  "LastViewedDate",
  "LastReferencedDate",
  "LastActivityDate",
  "RecordTypeId",
  "CurrencyIsoCode",
  // Custom Metadata Type built-ins
  "DeveloperName",
  "MasterLabel",
  "Language",
  "NamespacePrefix",
  "Label",
  "QualifiedApiName",
]);

/**
 * True when a `CustomField:<Object>.<Field>` qname names a field that real
 * field-level security applies to. Excludes:
 *  - Custom Metadata Type fields (`__mdt`) — CMDT has no per-field FLS.
 *  - Custom Settings-ish / metadata objects and standard system/audit fields.
 * Custom fields (`__c`) on real objects (standard or custom) stay in.
 */
export function isFlsRelevantField(qname: string): boolean {
  const tail = (qname.includes(":") ? qname.split(":")[1] : qname) ?? qname;
  const dot = tail.indexOf(".");
  if (dot <= 0) return false;
  const object = tail.slice(0, dot);
  const field = tail.slice(dot + 1);
  // CMDT and platform-event/big-object metadata don't use developer FLS.
  if (/__(mdt|e|b)$/i.test(object)) return false;
  if (SYSTEM_FIELD_NAMES.has(field)) return false;
  return true;
}

export interface SecurityAuditOptions {
  /** Restrict the field-access matrix + FLS gaps to fields of this object (qualifiedName prefix, e.g. `CustomObject:Account`). */
  object?: string;
  /** Restrict to a single field qualifiedName (e.g. `CustomField:Account.Tier__c`). Implies `object`. */
  field?: string;
  /** Include not-FLS-relevant fields (CMDT + system/audit) in the gap list.
   *  Default false — those are noise for an FLS review. */
  includeNonFlsFields?: boolean;
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

  // Field access matrix. FLS is granted via BOTH Profiles AND Permission Sets —
  // scanning only Permission Sets reported false FLS gaps on every field whose
  // access comes from a Profile (the most common case in older orgs). Fold both
  // grantors into the same matrix.
  const fieldAccessMatrix = new Map<string, Set<string>>();
  for (const grantorLabel of [METADATA_CATEGORY.PERMISSION_SET, METADATA_CATEGORY.PROFILE]) {
    const grantors = store.listNodesByLabel(orgId, grantorLabel, SECURITY_PER_LABEL_CAP);
    if (grantors.length >= SECURITY_PER_LABEL_CAP) truncated = true;
    for (const n of grantors) {
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
  }

  // FLS gaps: fields with no grants. Honour the object/field filter, and skip
  // not-FLS-relevant fields (CMDT + system/audit) unless explicitly requested
  // — those dominated the raw list and are never a real FLS finding.
  const flsGaps: string[] = [];
  let flsGapsExcluded = 0;
  const fields = store.listNodesByLabel(orgId, METADATA_CATEGORY.FIELD, SECURITY_PER_LABEL_CAP);
  if (fields.length >= SECURITY_PER_LABEL_CAP) truncated = true;
  for (const n of fields) {
    if (!matchesFilter(n.qualifiedName, opts)) continue;
    if (fieldAccessMatrix.has(n.qualifiedName)) continue;
    if (!opts?.includeNonFlsFields && !isFlsRelevantField(n.qualifiedName)) {
      flsGapsExcluded += 1;
      continue;
    }
    flsGaps.push(n.qualifiedName);
  }

  // Filter the matrix too so a narrowed audit returns a narrowed matrix.
  const filteredMatrix = Array.from(fieldAccessMatrix.entries())
    .filter(([field]) => matchesFilter(field, opts))
    .map(([field, set]) => ({ field, grantedBy: Array.from(set) }));

  return {
    sharingFullAccess,
    fieldAccessMatrix: filteredMatrix,
    flsGaps,
    flsGapsExcluded,
    truncated,
  };
}
