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
  if (opts.excludeSecurity !== false && SECURITY_GRANT_RELTYPES.has(e.relType)) return false;
  if (opts.excludeReflection !== false && isReflectionEdge(e)) return false;
  return true;
}
