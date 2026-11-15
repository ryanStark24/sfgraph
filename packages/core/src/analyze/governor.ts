import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import { REL_TYPES } from "../domain/rel-types.js";
import type { GraphStore } from "../storage/interfaces.js";
import { detectAsyncInLoop } from "./apex-code-checks.js";
import { detectFlowDmlInLoop } from "./flow-dml-loop.js";
import { unitSourceRisks } from "./governor-source.js";
import { type ScanCoverage, scanLabel, sumCoverage } from "./scan.js";
import { normalizeSourceUri } from "./source-uri.js";

export interface GovernorRisk {
  qualifiedName: string;
  risk:
    | "soql_in_loop"
    | "sosl_in_loop"
    | "dynamic_soql_in_loop"
    | "dml_in_loop"
    | "no_bulk"
    | "unbounded_query"
    | "async_in_loop"
    | "flow_dml_in_loop";
  evidence: string;
  /** Rule id (`governor.async-in-loop`). Set on `async_in_loop` and `flow_dml_in_loop` risks. */
  ruleId?: string;
  /** high, medium or low. Set where `ruleId` is. */
  severity?: "high" | "medium" | "low";
  /** The source file (a `file://` or `sf://` URI), when the node has one. */
  file?: string;
  /** 1-based line in the file (Apex) or in the Flow XML. */
  line?: number;
  /** One-line problem statement. */
  message?: string;
  /** Flow risks: the Create / Update / Delete Records element and the Loop it is in. */
  element?: string;
  loop?: string;
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
  "async_in_loop",
  "flow_dml_in_loop",
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

/** Lower-cased `Class.method` of every `@future` method, from the stored method nodes. */
function futureMethodKeys(store: GraphStore, orgId: OrgId): Set<string> {
  const out = new Set<string>();
  const add = (q: string): void => {
    const k = classMethodKey(q);
    if (k) out.add(k);
  };
  if (store.listNodesWithTrueAttribute) {
    for (const q of store.listNodesWithTrueAttribute(orgId, "isFuture")) add(q);
    return out;
  }
  const scan = scanLabel(store, orgId, "ApexMethod");
  for (const page of scan.pages) {
    for (const n of page) {
      if ((n.attributes as Record<string, unknown>).isFuture === true) add(String(n.qualifiedName));
    }
  }
  return out;
}

/** `ApexMethod:Outer.Inner.run(0)` to `outer.inner.run`. */
function classMethodKey(qname: string): string | null {
  const m = /^ApexMethod:(.+?)(?:\(.*\))?$/.exec(qname);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** `ApexMethod:Outer.Inner.run(0)` to `outer.inner`. */
function ownerClassOf(qname: string): string | undefined {
  const k = classMethodKey(qname);
  const dot = k ? k.lastIndexOf(".") : -1;
  return k && dot > 0 ? k.slice(0, dot) : undefined;
}

/** The governor scan's result: the risks and how much of the graph was examined. */
export interface GovernorScan {
  risks: GovernorRisk[];
  /** Methods and triggers examined; `complete` is also false when the flow scan stopped early. */
  coverage: ScanCoverage;
  /** Flows examined (for the flow_dml_in_loop check), counted apart from `coverage`. */
  flows: ScanCoverage;
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
  const add = (
    qname: string,
    risk: GovernorRisk["risk"],
    evidence: string,
    extra: Partial<GovernorRisk> = {},
  ): void => {
    const key = `${qname}\u0000${risk}\u0000${evidence}\u0000${extra.line ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ qualifiedName: qname, risk, evidence, ...extra });
  };
  const future = futureMethodKeys(store, orgId);
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
        // Async work in a loop, from the same stored snippet.
        const snip = store.getSnippet(orgId, n.qualifiedName);
        if (snip?.sourceText) {
          const file = (n.attributes as Record<string, unknown>).sourceUri;
          const base = (snip.startLine ?? 1) - 1;
          for (const spot of detectAsyncInLoop(snip.sourceText, {
            futureMethods: future,
            ...(ownerClassOf(qname) ? { ownerClass: ownerClassOf(qname) as string } : {}),
          })) {
            add(qname, "async_in_loop", spot.evidence, {
              ruleId: "governor.async-in-loop",
              severity: "high",
              ...(typeof file === "string" ? { file: normalizeSourceUri(file) } : {}),
              line: base + spot.line,
              message: `${spot.kind} runs inside a loop; each iteration uses the transaction's async limits`,
            });
          }
        }
      }
    }
    parts.push(labelScan.coverage());
  }
  // Record Create / Update / Delete elements inside a Flow loop, from the stored Flow XML.
  const flowScan = scanLabel(store, orgId, METADATA_CATEGORY.FLOW);
  for (const page of flowScan.pages) {
    for (const n of page) {
      const xml = store.getSnippet(orgId, n.qualifiedName)?.sourceText;
      if (!xml) continue;
      const file = (n.attributes as Record<string, unknown>).sourceUri;
      for (const d of detectFlowDmlInLoop(xml)) {
        add(
          String(n.qualifiedName),
          "flow_dml_in_loop",
          `${d.element} (${d.action}${d.object ? ` on ${d.object}` : ""}) inside loop ${d.loop}`,
          {
            ruleId: "governor.flow-dml-in-loop",
            severity: "high",
            ...(typeof file === "string" ? { file: normalizeSourceUri(file) } : {}),
            ...(d.line > 0 ? { line: d.line } : {}),
            message: `${d.action} element ${d.element} runs once per iteration of loop ${d.loop}; collect the records and save once after the loop`,
            element: d.element,
            loop: d.loop,
          },
        );
      }
    }
  }
  const flows = flowScan.coverage();
  // `coverage` keeps counting methods and triggers only (its pre-1.9.0 meaning); a flow scan that
  // stopped early still makes the answer incomplete.
  const coverage = sumCoverage(parts);
  if (!flows.complete) coverage.complete = false;
  return { risks: out.sort(compareGovernorRisks), coverage, flows };
}

/** `scanGovernorRisks`'s risks (see there for the scan's coverage). */
export function findGovernorRisks(store: GraphStore, orgId: OrgId): GovernorRisk[] {
  return scanGovernorRisks(store, orgId).risks;
}
