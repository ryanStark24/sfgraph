import type { EdgeFact } from "../domain/index.js";
import { REL_TYPES } from "../domain/index.js";

/**
 * Edge classification + filtering shared by the traversal tools
 * (trace_upstream / trace_downstream).
 *
 * Real-org traces are dominated by two kinds of edge that are technically
 * correct but almost never what "what depends on X / what does X depend on"
 * is asking for:
 *
 *   1. Security grants — every Profile/PermissionSet that can see an Apex
 *      class emits a GRANTS_APEX_ACCESS edge. A class used by 111 profiles
 *      buries its single IS_TEST_FOR / CALLS edge under 111 grant edges.
 *   2. Reflection-walker inferences — low-confidence REFERENCES edges tagged
 *      `source: "reflection"`, emitted when a node's blob string happens to
 *      match another node's bare name. On Vlocity nodes these produce
 *      spurious links like DataRaptor:Foo → CustomApplication:DataRaptor.
 *
 * Dependency/dependent traces exclude both by default; callers can opt back
 * in (a dedicated security view, or "show inferred references").
 */

/** Security / sharing grant edges — relationship of access, not of code dependency. */
export const SECURITY_GRANT_RELTYPES: ReadonlySet<string> = new Set([
  REL_TYPES.GRANTS_OBJECT_ACCESS,
  REL_TYPES.GRANTS_FIELD_ACCESS,
  REL_TYPES.GRANTS_APEX_ACCESS,
  REL_TYPES.GRANTS_PAGE_ACCESS,
  REL_TYPES.GRANTS_TAB_ACCESS,
  REL_TYPES.GRANTS_USER_PERMISSION,
  REL_TYPES.SHARING_GRANTS,
  REL_TYPES.SHARING_TO_GROUP,
  REL_TYPES.SHARING_TO_ROLE,
  REL_TYPES.SHARING_FROM_OWNER_GROUP,
]);

/**
 * False for a Profile/PermissionSet entry that grants nothing. Retrieved profiles list most
 * fields, objects and classes with every flag false (`<readable>false</readable>`); the parsers
 * keep those entries as GRANTS_* edges with the flags as attributes. Counting them as access
 * inflated "who can see this field" and hid real FLS gaps. An edge without the flags (another
 * source, an older graph) still counts.
 */
export function isEffectiveGrant(e: Pick<EdgeFact, "relType" | "attributes">): boolean {
  const a = (e.attributes ?? {}) as Record<string, unknown>;
  const anyTrue = (keys: readonly string[]): boolean => {
    const present = keys.filter((k) => a[k] !== undefined);
    return present.length === 0 || present.some((k) => a[k] === true);
  };
  switch (e.relType) {
    case REL_TYPES.GRANTS_FIELD_ACCESS:
      return anyTrue(["readable", "editable"]);
    case REL_TYPES.GRANTS_OBJECT_ACCESS:
      return anyTrue([
        "allowRead",
        "allowEdit",
        "allowCreate",
        "allowDelete",
        "viewAllRecords",
        "modifyAllRecords",
      ]);
    case REL_TYPES.GRANTS_APEX_ACCESS:
    case REL_TYPES.GRANTS_PAGE_ACCESS:
      return a.enabled !== false;
    case REL_TYPES.GRANTS_TAB_ACCESS:
      return a.visibility !== "Hidden";
    default:
      return true;
  }
}

/** True for a low-confidence reflection-walker REFERENCES edge. */
export function isReflectionEdge(e: EdgeFact): boolean {
  return (
    e.relType === REL_TYPES.REFERENCES &&
    (e.attributes as { source?: unknown } | undefined)?.source === "reflection"
  );
}

export interface EdgeFilterOpts {
  /** Only keep these relTypes (applied before excludes). */
  includeRelTypes?: ReadonlySet<string>;
  /** Drop these relTypes. */
  excludeRelTypes?: ReadonlySet<string>;
  /** Drop security/sharing grant edges. Default true for dependency traces. */
  excludeSecurity?: boolean;
  /** Drop reflection-inferred REFERENCES edges. Default true for traces. */
  excludeReflection?: boolean;
}

/** Decide whether an edge survives the filter. */
export function keepEdge(e: EdgeFact, opts: EdgeFilterOpts): boolean {
  if (opts.includeRelTypes && !opts.includeRelTypes.has(e.relType)) return false;
  if (opts.excludeRelTypes?.has(e.relType)) return false;
  if (SECURITY_GRANT_RELTYPES.has(e.relType)) {
    if (opts.excludeSecurity !== false) return false;
    if (!isEffectiveGrant(e)) return false;
  }
  if (opts.excludeReflection !== false && isReflectionEdge(e)) return false;
  return true;
}

/**
 * Downstream "containment is not a dependency" rule.
 *
 * A trace that reaches a CustomObject would otherwise walk DEFINES_FIELD to
 * every field of the object (hundreds on a standard object), then field ->
 * field formula READS_FIELD, then HAS_VALIDATION_RULE etc. None of that is
 * something the traced component depends on — the object *contains* those
 * members. When `leafStructure` is on, a non-root node whose label is in
 * STRUCTURE_LEAF_LABELS is not expanded along STRUCTURAL_RELTYPES; the node
 * itself stays in the result as a leaf.
 */
export const STRUCTURE_LEAF_LABELS: ReadonlySet<string> = new Set([
  "CustomObject",
  "CustomField",
  "ValidationRule",
  "RecordType",
  "NamedCredential",
]);

export const STRUCTURAL_RELTYPES: ReadonlySet<string> = new Set([
  REL_TYPES.DEFINES_FIELD,
  REL_TYPES.HAS_VALIDATION_RULE,
  REL_TYPES.HAS_RECORD_TYPE,
  REL_TYPES.CONTAINS,
  // field -> field (formula) and ValidationRule -> field reads
  REL_TYPES.READS_FIELD,
  // dependent picklist -> controlling field
  REL_TYPES.DEPENDS_ON_FIELD,
]);

/** Label of a qname from its `<Label>:` prefix ("" when there is none). */
export function labelOfQname(qname: string): string {
  const i = qname.indexOf(":");
  return i > 0 ? qname.slice(0, i) : "";
}

/** True when `e` is a containment edge out of an object/field-like node. */
export function isStructuralEdge(e: EdgeFact): boolean {
  return (
    STRUCTURAL_RELTYPES.has(e.relType) &&
    STRUCTURE_LEAF_LABELS.has(labelOfQname(e.srcQualifiedName))
  );
}
