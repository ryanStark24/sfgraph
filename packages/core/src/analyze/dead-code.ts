import type { OrgId } from "@sfgraph/shared";
import type { NodeFact } from "../domain/index.js";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { GraphStore } from "../storage/interfaces.js";
import { freshnessScore } from "./freshness.js";

const SCAN_LABELS = [METADATA_CATEGORY.APEX_CLASS, METADATA_CATEGORY.LWC, METADATA_CATEGORY.FLOW];

/**
 * Dead code = low freshness AND zero incoming edges.
 */
export function findDeadCode(store: GraphStore, orgId: OrgId): NodeFact[] {
  const now = Date.now();
  const out: NodeFact[] = [];
  for (const lbl of SCAN_LABELS) {
    for (const n of store.listNodesByLabel(orgId, lbl, 5000)) {
      if (freshnessScore(n, now) >= 0.4) continue;
      if (store.listEdgesTo(orgId, n.qualifiedName).length === 0) {
        out.push(n);
      }
    }
  }
  return out;
}
