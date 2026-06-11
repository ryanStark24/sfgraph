import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { GraphStore } from "../storage/interfaces.js";
import { freshnessScore } from "./freshness.js";

const SCAN_LABELS = [METADATA_CATEGORY.APEX_CLASS, METADATA_CATEGORY.LWC, METADATA_CATEGORY.FLOW];

/**
 * Count incoming edges that represent a REAL usage reference. Excludes:
 *  - permission grants (`GRANTS_*`) — being readable by a profile is not usage;
 *  - reflection-sourced edges (`attributes.source === 'reflection'`) — these are
 *    low-confidence, pattern-matched guesses, not proof the node is invoked.
 * Counting either as a reference kept genuinely dead code "alive" in the audit.
 */
export function realIncomingRefCount(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
): number {
  return store.listEdgesTo(orgId, qname).filter((e) => {
    if (String(e.relType).startsWith("GRANTS_")) return false;
    if ((e.attributes as Record<string, unknown>)?.source === "reflection") return false;
    return true;
  }).length;
}

/**
 * Dead code = low freshness AND zero real incoming references.
 */
export function findDeadCode(store: GraphStore, orgId: OrgId): NodeFact[] {
  const now = Date.now();
  const out: NodeFact[] = [];
  for (const lbl of SCAN_LABELS) {
    for (const n of store.listNodesByLabel(orgId, lbl, 5000)) {
      if (freshnessScore(n, now) >= 0.4) continue;
      if (realIncomingRefCount(store, orgId, n.qualifiedName) === 0) {
        out.push(n);
      }
    }
  }
  return out;
}
