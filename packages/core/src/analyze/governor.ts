import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";

export interface GovernorRisk {
  qualifiedName: string;
  risk: "soql_in_loop" | "dml_in_loop" | "no_bulk" | "unbounded_query";
  evidence: string;
}

// Source-node labels that carry EXECUTES_SOQL / EXECUTES_DML edges. Methods and
// triggers are the governor-risk-prone units (triggers added in the same wave
// that made them emit these edges).
const RISK_SOURCE_LABELS = ["ApexMethod", "TestMethod", METADATA_CATEGORY.APEX_TRIGGER];
const RISK_SOURCE_CAP = 20000;

/**
 * Detect SOQL/DML-in-loop governor risks straight from the graph's
 * EXECUTES_SOQL / EXECUTES_DML edges (which the Apex + trigger parsers stamp
 * with `inLoop: true`). This is the no-DB-cache path used by `export_sarif` and
 * `governor_risk_check` when the analysis tables haven't been populated — it
 * reads real graph data, NOT the never-set `hasSoqlInLoop` attribute the old
 * placeholder looked for (which made SARIF always empty and the no-cache path
 * fabricate "no risks detected").
 */
export function findGovernorRisks(store: GraphStore, orgId: OrgId): GovernorRisk[] {
  const out: GovernorRisk[] = [];
  const seen = new Set<string>();
  const scan = (
    qname: string,
    relType: (typeof REL_TYPES)[keyof typeof REL_TYPES],
    risk: GovernorRisk["risk"],
    fallbackEvidence: string,
  ): void => {
    for (const e of store.listEdgesFrom(orgId, qname as never, relType as never)) {
      const a = e.attributes as Record<string, unknown>;
      if (a.inLoop !== true) continue;
      const evidence = String(a.query ?? a.target ?? fallbackEvidence)
        .trim()
        .slice(0, 200);
      const key = `${qname}${risk}${evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ qualifiedName: qname, risk, evidence });
    }
  };
  for (const label of RISK_SOURCE_LABELS) {
    for (const n of store.listNodesByLabel(orgId, label, RISK_SOURCE_CAP)) {
      const qname = String(n.qualifiedName);
      scan(qname, REL_TYPES.EXECUTES_SOQL, "soql_in_loop", "SOQL in loop");
      scan(qname, REL_TYPES.EXECUTES_DML, "dml_in_loop", "DML in loop");
    }
  }
  return out;
}
