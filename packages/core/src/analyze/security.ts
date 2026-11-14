import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { nameKey } from "../domain/name-key.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";
import { isEffectiveGrant } from "./edge-filters.js";

export { isEffectiveGrant };

/** One sharing rule that gives record-level Edit or All access, as the rule stores it. */
export interface SharingRuleAccess {
  qualifiedName: string;
  /** `Edit` for edit access; `All` for the stored access level `All`. Kept apart on purpose. */
  access: "Edit" | "All";
  /** Who the rule shares with (group, role, guest user, ...), as stored on the rule; absent when not stored. */
  audience?: string;
}

export interface SecurityAudit {
  /**
   * Sharing rules that give record-level Edit or All access. This is record sharing only: it does
   * not say the audience has object (CRUD) or field-level permissions, and it is not Modify All /
   * View All, which are permission-set and profile facts.
   */
  sharingEditAccess: string[];
  /** The same rules with their access level and audience. */
  sharingRuleAccess?: SharingRuleAccess[];
  /**
   * @deprecated Alias of `sharingEditAccess`, kept for consumers of the old field. The name
   * overstated what a sharing rule is; read `sharingEditAccess`.
   */
  sharingFullAccess?: string[];
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

function audienceOf(a: Record<string, unknown>): string | undefined {
  const v = a.sharedTo ?? a.shareTo ?? a.audience;
  if (typeof v === "string" && v) return v;
  if (v && typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => typeof x === "string" || typeof x === "number")
      .map(([k, x]) => `${k}: ${String(x)}`);
    if (parts.length) return parts.join(", ");
  }
  return undefined;
}

/**
 * The audience of an ingested rule. The parser stores the recipients as SHARING_TO_GROUP and
 * SHARING_TO_ROLE edges (not as node attributes), and marks guest rules with `kind: "guest"`
 * (the guest user's site name is not stored). Several recipients are joined with "; ".
 */
function audienceFromEdges(store: GraphStore, orgId: OrgId, n: NodeFact): string | undefined {
  const parts: string[] = [];
  const bare = (q: string) => q.slice(q.indexOf(":") + 1);
  for (const e of store.listEdgesFrom(orgId, n.qualifiedName, REL_TYPES.SHARING_TO_GROUP))
    parts.push(`group: ${bare(e.dstQualifiedName)}`);
  for (const e of store.listEdgesFrom(orgId, n.qualifiedName, REL_TYPES.SHARING_TO_ROLE)) {
    const sub =
      (e.attributes as Record<string, unknown> | undefined)?.includesSubordinates === true;
    parts.push(`${sub ? "role and subordinates" : "role"}: ${bare(e.dstQualifiedName)}`);
  }
  if ((n.attributes as Record<string, unknown>).kind === "guest") parts.push("guest users");
  return parts.length ? parts.join("; ") : undefined;
}

/**
 * Sharing rules that give record-level Edit or All access. Shared by `securityAudit` and the
 * single-field path of the `security_audit` tool so both report the same rules.
 */
export function sharingEditRules(
  store: GraphStore,
  orgId: OrgId,
): { rules: SharingRuleAccess[]; truncated: boolean } {
  const nodes = store.listNodesByLabel(
    orgId,
    METADATA_CATEGORY.SHARING_RULE,
    SECURITY_PER_LABEL_CAP,
  );
  const rules: SharingRuleAccess[] = [];
  for (const n of nodes) {
    const a = n.attributes as Record<string, unknown>;
    const access =
      a.accessLevel === "All"
        ? "All"
        : a.access === "Edit" || a.accessLevel === "Edit"
          ? "Edit"
          : null;
    if (!access) continue;
    const audience = audienceFromEdges(store, orgId, n) ?? audienceOf(a);
    rules.push({
      qualifiedName: n.qualifiedName,
      access,
      ...(audience !== undefined ? { audience } : {}),
    });
  }
  return { rules, truncated: nodes.length >= SECURITY_PER_LABEL_CAP };
}

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

const SYSTEM_FIELD_KEYS: ReadonlySet<string> = new Set([...SYSTEM_FIELD_NAMES].map(nameKey));

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
  // Compared without case, like every other name the store holds.
  if (SYSTEM_FIELD_KEYS.has(nameKey(field))) return false;
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
  // Names are compared by the store's NOCASE identity (`nameKey`), not by exact string.
  if (opts.field) return nameKey(qname) === nameKey(opts.field);
  if (opts.object) {
    // Match `<anything>:<object>.<field>` heuristically. Strip the label
    // prefix before `:` so the caller can pass either the full qname
    // (`CustomObject:Account`) or just the object name (`Account`).
    const objName =
      (opts.object.includes(":") ? opts.object.split(":")[1] : opts.object) ?? opts.object;
    const tail = (qname.includes(":") ? qname.split(":")[1] : qname) ?? qname;
    const tailKey = nameKey(tail);
    const objKey = nameKey(objName);
    return tailKey.startsWith(`${objKey}.`) || tailKey === objKey;
  }
  return true;
}

export function securityAudit(
  store: GraphStore,
  orgId: OrgId,
  opts?: SecurityAuditOptions,
): SecurityAudit {
  const sharing = sharingEditRules(store, orgId);
  let truncated = sharing.truncated;

  // Field access matrix. FLS is granted via BOTH Profiles AND Permission Sets —
  // scanning only Permission Sets reported false FLS gaps on every field whose
  // access comes from a Profile (the most common case in older orgs). Fold both
  // grantors into the same matrix.
  // Keyed by the store's NOCASE identity (`nameKey`), so a grant to `account.secret__c` and a
  // field `Account.Secret__c` are one field. `spelling` keeps one display name per key.
  const fieldAccessMatrix = new Map<string, Set<string>>();
  const spelling = new Map<string, string>();
  for (const grantorLabel of [METADATA_CATEGORY.PERMISSION_SET, METADATA_CATEGORY.PROFILE]) {
    const grantors = store.listNodesByLabel(orgId, grantorLabel, SECURITY_PER_LABEL_CAP);
    if (grantors.length >= SECURITY_PER_LABEL_CAP) truncated = true;
    for (const n of grantors) {
      // An all-false entry (`<readable>false</readable>`) grants nothing.
      const grants = store
        .listEdgesFrom(orgId, n.qualifiedName, REL_TYPES.GRANTS_FIELD_ACCESS)
        .filter(isEffectiveGrant);
      for (const e of grants) {
        const key = nameKey(e.dstQualifiedName);
        let set = fieldAccessMatrix.get(key);
        if (!set) {
          set = new Set();
          fieldAccessMatrix.set(key, set);
          spelling.set(key, e.dstQualifiedName);
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
  // The cap bounds the fields IN SCOPE: with an object/field filter, filter
  // first and cap after, so narrowing (the advice the cap gives) can reach
  // fields past the first SECURITY_PER_LABEL_CAP rows of the label.
  let fields: NodeFact[];
  if (opts?.field) {
    const one = store.getNode(orgId, opts.field as QualifiedName);
    fields = one && one.label === METADATA_CATEGORY.FIELD ? [one] : [];
  } else if (opts?.object) {
    fields = store
      .listNodesByLabel(orgId, METADATA_CATEGORY.FIELD)
      .filter((n) => matchesFilter(n.qualifiedName, opts));
    if (fields.length > SECURITY_PER_LABEL_CAP) {
      fields = fields.slice(0, SECURITY_PER_LABEL_CAP);
      truncated = true;
    }
  } else {
    fields = store.listNodesByLabel(orgId, METADATA_CATEGORY.FIELD, SECURITY_PER_LABEL_CAP);
    if (fields.length >= SECURITY_PER_LABEL_CAP) truncated = true;
  }
  for (const n of fields) {
    if (!matchesFilter(n.qualifiedName, opts)) continue;
    if (fieldAccessMatrix.has(nameKey(n.qualifiedName))) continue;
    if (!opts?.includeNonFlsFields && !isFlsRelevantField(n.qualifiedName)) {
      flsGapsExcluded += 1;
      continue;
    }
    flsGaps.push(n.qualifiedName);
  }

  // Filter the matrix too so a narrowed audit returns a narrowed matrix. The display name is the
  // field node's own spelling when the field exists, else the spelling of the first grant.
  const filteredMatrix = Array.from(fieldAccessMatrix.entries())
    .map(([key, set]) => ({
      field:
        store.getNode(orgId, spelling.get(key) as QualifiedName)?.qualifiedName ??
        spelling.get(key)!,
      grantedBy: Array.from(set),
    }))
    .filter(({ field }) => matchesFilter(field, opts));

  return {
    sharingEditAccess: sharing.rules.map((r) => r.qualifiedName),
    sharingRuleAccess: sharing.rules,
    sharingFullAccess: sharing.rules.map((r) => r.qualifiedName),
    fieldAccessMatrix: filteredMatrix,
    flsGaps,
    flsGapsExcluded,
    truncated,
  };
}
