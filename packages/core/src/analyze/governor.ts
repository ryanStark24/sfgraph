import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";
import { unitSourceRisks } from "./governor-source.js";
import { type ScanCoverage, scanLabel, sumCoverage } from "./scan.js";

export interface GovernorRisk {
  qualifiedName: string;
  risk:
    | "soql_in_loop"
    | "sosl_in_loop"
    | "dynamic_soql_in_loop"
    | "dml_in_loop"
    | "no_bulk"
    | "unbounded_query";
  evidence: string;
}

/**
 * The priority order of the risk kinds (T15 I-5): the per-transaction limits
 * a loop exhausts first (100 SOQL, 20 SOSL, dynamic SOQL counting as SOQL,
 * 150 DML), then a trigger that is not bulk-safe (all `error` in the SARIF
 * rule catalog), then an unbounded query (`warning`).
 */
export const GOVERNOR_RISK_ORDER: readonly GovernorRisk["risk"][] = [
  "soql_in_loop",
  "sosl_in_loop",
  "dynamic_soql_in_loop",
  "dml_in_loop",
  "no_bulk",
  "unbounded_query",
];

/**
 * The documented order of governor risks (applied before any `limit`): the
 * risk kind by GOVERNOR_RISK_ORDER (severity first), then qualified name,
 * then evidence, each by code point. Unknown kinds sort last.
 */
export function compareGovernorRisks(a: GovernorRisk, b: GovernorRisk): number {
  const rank = (r: string): number => {
    const i = GOVERNOR_RISK_ORDER.indexOf(r as GovernorRisk["risk"]);
    return i < 0 ? GOVERNOR_RISK_ORDER.length : i;
  };
  const cp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return (
    rank(a.risk) - rank(b.risk) ||
    cp(a.qualifiedName, b.qualifiedName) ||
    cp(a.risk, b.risk) ||
    cp(a.evidence, b.evidence)
  );
}

// Source-node labels that carry EXECUTES_SOQL / EXECUTES_DML edges. Methods and
// triggers are the governor-risk-prone units (triggers added in the same wave
// that made them emit these edges).
const RISK_SOURCE_LABELS = ["ApexMethod", "TestMethod", METADATA_CATEGORY.APEX_TRIGGER];

/** The governor scan's result: the risks and how much of the graph was examined. */
export interface GovernorScan {
  risks: GovernorRisk[];
  coverage: ScanCoverage;
}

/**
 * Detect governor risks straight from the graph: SOQL/SOSL/dynamic-SOQL/DML
 * in a loop from the EXECUTES_SOQL / EXECUTES_DML edges (which the Apex +
 * trigger parsers stamp with `inLoop: true`), and `unbounded_query` /
 * `no_bulk` from the stored source snippets (governor-source.ts, the same
 * detector the cache uses). This is the no-DB-cache path used by `export_sarif`
 * and `governor_risk_check` when the analysis tables haven't been populated;
 * it reads real graph data, NOT the never-set `hasSoqlInLoop` attribute the
 * old placeholder looked for. Sorted by compareGovernorRisks.
 *
 * Every method and trigger is examined, a page at a time (keyset pagination,
 * bounded memory): there is no 20,000-node cut-off. `coverage` says how many
 * were examined of how many exist; `complete` is false only if the safety
 * limit (`scanLimits`) stopped the scan.
 *
 * Direct only: a loop that calls a method which queries is not flagged (the
 * graph's CALLS edges carry no in-loop position), and SOSL / dynamic queries
 * in trigger bodies other than dynamic SOQL are not modelled.
 */
export function scanGovernorRisks(store: GraphStore, orgId: OrgId): GovernorScan {
  const out: GovernorRisk[] = [];
  const seen = new Set<string>();
  const add = (qname: string, risk: GovernorRisk["risk"], evidence: string): void => {
    const key = `${qname}\u0000${risk}\u0000${evidence}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ qualifiedName: qname, risk, evidence });
  };
  const scan = (
    qname: string,
    relType: (typeof REL_TYPES)[keyof typeof REL_TYPES],
    risk: GovernorRisk["risk"],
    fallbackEvidence: string,
  ): void => {
    for (const e of store.listEdgesFrom(orgId, qname as never, relType as never)) {
      const a = e.attributes as Record<string, unknown>;
      if (a.inLoop !== true) continue;
      add(
        qname,
        risk,
        String(a.query ?? a.target ?? fallbackEvidence)
          .trim()
          .slice(0, 200),
      );
    }
  };
  const parts: ScanCoverage[] = [];
  for (const label of RISK_SOURCE_LABELS) {
    const labelScan = scanLabel(store, orgId, label);
    for (const page of labelScan.pages) {
      for (const n of page) {
        const qname = String(n.qualifiedName);
        scan(qname, REL_TYPES.EXECUTES_SOQL, "soql_in_loop", "SOQL in loop");
        scan(qname, REL_TYPES.EXECUTES_SOSL, "sosl_in_loop", "SOSL in loop");
        scan(qname, REL_TYPES.EXECUTES_DML, "dml_in_loop", "DML in loop");
        // Dynamic queries (`Database.query(...)` ...) in a loop body, stamped on
        // the method / trigger node by the Apex parsers.
        const dyn = (n.attributes as Record<string, unknown>).dynamicQueryInLoop;
        if (Array.isArray(dyn)) {
          for (const call of dyn) add(qname, "dynamic_soql_in_loop", String(call));
        }
        // unbounded_query / no_bulk: from the stored snippet (the method body or
        // the whole trigger), else the edges' query text.
        for (const r of unitSourceRisks(store, orgId, n.qualifiedName, {
          isTrigger: label === METADATA_CATEGORY.APEX_TRIGGER,
        })) {
          add(qname, r.risk, r.evidence);
        }
      }
    }
    parts.push(labelScan.coverage());
  }
  return { risks: out.sort(compareGovernorRisks), coverage: sumCoverage(parts) };
}

/** `scanGovernorRisks`'s risks (see there for the scan's coverage). */
export function findGovernorRisks(store: GraphStore, orgId: OrgId): GovernorRisk[] {
  return scanGovernorRisks(store, orgId).risks;
}
