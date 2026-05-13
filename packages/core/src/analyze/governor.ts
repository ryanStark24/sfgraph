import type { OrgId } from "@sfgraph/shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface GovernorRisk {
  qualifiedName: string;
  risk: "soql_in_loop" | "dml_in_loop" | "no_bulk" | "unbounded_query";
  evidence: string;
}

/**
 * Placeholder implementation. Real impl Phase 6. We scan ApexClass attribute
 * hints (`hasSoqlInLoop`, `hasDmlInLoop`) if parsers ever emit them, otherwise
 * empty.
 */
export function findGovernorRisks(store: GraphStore, orgId: OrgId): GovernorRisk[] {
  const out: GovernorRisk[] = [];
  for (const n of store.listNodesByLabel(orgId, METADATA_CATEGORY.APEX_CLASS, 5000)) {
    const a = n.attributes as Record<string, unknown>;
    if (a.hasSoqlInLoop === true) {
      out.push({
        qualifiedName: n.qualifiedName,
        risk: "soql_in_loop",
        evidence: "attribute hasSoqlInLoop=true",
      });
    }
    if (a.hasDmlInLoop === true) {
      out.push({
        qualifiedName: n.qualifiedName,
        risk: "dml_in_loop",
        evidence: "attribute hasDmlInLoop=true",
      });
    }
  }
  return out;
}
