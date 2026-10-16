import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { REL_TYPES } from "../domain/index.js";
import type { ApexRefResolveResult } from "../parsers/apex/ref-resolver.js";
import { APEX_REF_RESOLVER } from "../parsers/apex/ref-resolver.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Cheap pre-checks that prove a post-merge resolver would do nothing, so the
 * ingest can skip its whole-graph reads (every node of its labels parsed,
 * every edge of its rel types read) and use the result it would return.
 * Each check is conservative: any doubt, and the resolver runs.
 */

interface GateStore {
  anyNodeAttributesContain?(
    orgId: OrgId,
    labels: readonly string[],
    needles: readonly string[],
  ): boolean;
  anyEdgeAttributesContain?(orgId: OrgId, relTypes: readonly string[], needle: string): boolean;
  sumPositiveNodeAttribute?(orgId: OrgId, labels: readonly string[], attr: string): number;
}

/** resolveApexReferences' node labels (its PATH_LABELS; ApexMethod / TestMethod / ApexClass are subsets). */
const APEX_REF_LABELS = ["ApexMethod", "TestMethod", "ApexClass", "ApexTrigger"] as const;
/** The node attributes resolveApexReferences derives edges from. */
const APEX_REF_INPUTS = [
  "apexRelationshipPaths",
  "apexChildRelationships",
  "apexFieldNameLiterals",
  "testTargetCandidates",
] as const;
/** Rel types of the edges it emits (and so may have to prune). */
const APEX_REF_RELS = [
  REL_TYPES.READS_FIELD,
  REL_TYPES.WRITES_FIELD,
  REL_TYPES.REFERENCES,
  REL_TYPES.IS_TEST_FOR,
] as const;

/**
 * The result resolveApexReferences would return when it has nothing to do:
 * no node carries any of its input attributes (so it emits no edge) and no
 * edge of its rel types carries its owner tag (so it prunes nothing). Its
 * only other output, `dynamicSoqlFieldsSkipped`, is summed the same way.
 * Null when that cannot be shown (or the store lacks the probes): run it.
 */
export function apexRefNoWorkResult(store: GraphStore, orgId: OrgId): ApexRefResolveResult | null {
  const s = store as GraphStore & GateStore;
  if (
    typeof s.anyNodeAttributesContain !== "function" ||
    typeof s.anyEdgeAttributesContain !== "function" ||
    typeof s.sumPositiveNodeAttribute !== "function"
  ) {
    return null;
  }
  // Substring probes: a key name anywhere in the JSON text counts as input.
  const keys = APEX_REF_INPUTS.map((k) => JSON.stringify(k));
  if (s.anyNodeAttributesContain(orgId, APEX_REF_LABELS, keys)) return null;
  if (s.anyEdgeAttributesContain(orgId, APEX_REF_RELS, JSON.stringify(APEX_REF_RESOLVER))) {
    return null;
  }
  return {
    pathsResolved: 0,
    pathsUnresolved: 0,
    childRelationshipsResolved: 0,
    childRelationshipsUnresolved: 0,
    testTargetsResolved: 0,
    testTargetsUnresolved: 0,
    fieldLiteralsResolved: 0,
    fieldLiteralsUnresolved: 0,
    dynamicSoqlFieldsSkipped: s.sumPositiveNodeAttribute(
      orgId,
      APEX_REF_LABELS,
      "dynamicSoqlFieldsSkipped",
    ),
    edgesEmitted: 0,
  };
}
