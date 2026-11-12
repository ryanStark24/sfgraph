import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { parserRegistry } from "../parsers/registry.js";
import { RuleBasedParser } from "../parsers/rules/_engine.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Coverage report: per metadata type, how much of the org the graph really
 * understands. Consumers use it to spot unknown families (a new cloud's types)
 * that are present as names only.
 *
 *  - `opaque`            members stored as a node with no parsed content
 *                        (no dedicated parser, no YAML rule)
 *  - `withGenericEdges`  opaque members that earned at least one
 *                        GENERIC_REFERENCES_* edge from the generic scanner
 *  - `nameOnly`          opaque members with no generic edge: `opaque -
 *                        withGenericEdges`. Vlocity DataPack members carry
 *                        their own REFERENCES edges and are counted here too.
 *  - `ruleParsed`        nodes labelled with the type name for a type that has
 *                        a YAML rule (built-in or from SFGRAPH_RULES_DIR)
 */
export interface TypeCoverage {
  opaque: number;
  nameOnly: number;
  withGenericEdges: number;
  ruleParsed: number;
}

export interface CoverageReport {
  generatedAt: string;
  byType: Record<string, TypeCoverage>;
  totals: TypeCoverage & { types: number };
  /** Types with name-only members and nothing parsed: likely unknown families, biggest first. */
  unknownTypes: string[];
}

type ProbeStore = GraphStore & {
  findNodesMentioning?(orgId: OrgId, needles: readonly string[]): Set<string>;
};

/** qnames of opaque nodes (the only nodes carrying `rawSize`). */
function opaqueQnames(store: ProbeStore, orgId: OrgId): Iterable<string> {
  if (typeof store.findNodesMentioning === "function") {
    return store.findNodesMentioning(orgId, ["rawSize"]);
  }
  const out: string[] = [];
  for (const label of store.listAllLabels()) {
    for (const n of store.listNodesByLabel(orgId, label)) {
      if ("rawSize" in (n.attributes as Record<string, unknown>)) out.push(String(n.qualifiedName));
    }
  }
  return out;
}

const blank = (): TypeCoverage => ({ opaque: 0, nameOnly: 0, withGenericEdges: 0, ruleParsed: 0 });

export function computeCoverage(
  store: GraphStore,
  orgId: OrgId,
  withGenericEdgesByType: Record<string, number>,
  now: Date = new Date(),
): CoverageReport {
  const byType: Record<string, TypeCoverage> = {};
  const row = (t: string): TypeCoverage => {
    let r = byType[t];
    if (!r) {
      r = blank();
      byType[t] = r;
    }
    return r;
  };
  for (const q of opaqueQnames(store as ProbeStore, orgId)) {
    const colon = q.indexOf(":");
    if (colon > 0) row(q.slice(0, colon)).opaque += 1;
  }
  for (const [type, n] of Object.entries(withGenericEdgesByType)) {
    const r = byType[type];
    if (r) r.withGenericEdges = Math.min(n, r.opaque);
  }
  // Rule-parsed: count the nodes a rule emits, by the labels it emits. An alias
  // parser (GenAiPlannerBundle) shares its primary's labels, so it lands on the
  // same row once; a rule whose label differs from its type (CustomLabels ->
  // CustomLabel) is counted under that label.
  const seen = new Set<string>();
  for (const p of parserRegistry.all()) {
    if (!(p instanceof RuleBasedParser)) continue;
    const labels = p.nodeLabels.length > 0 ? p.nodeLabels : [p.type];
    const key = labels.includes(p.type) ? p.type : (labels[0] as string);
    if (seen.has(key)) continue;
    seen.add(key);
    const n = labels.reduce((a, l) => a + store.countNodesByLabel(orgId, l), 0);
    if (n > 0) row(key).ruleParsed = Math.max(0, n - (byType[key]?.opaque ?? 0));
  }
  const totals = { ...blank(), types: 0 };
  for (const r of Object.values(byType)) {
    r.nameOnly = r.opaque - r.withGenericEdges;
    totals.opaque += r.opaque;
    totals.nameOnly += r.nameOnly;
    totals.withGenericEdges += r.withGenericEdges;
    totals.ruleParsed += r.ruleParsed;
    totals.types += 1;
  }
  const unknownTypes = Object.entries(byType)
    .filter(([, r]) => r.nameOnly > 0 && r.ruleParsed === 0)
    .sort((a, b) => b[1].nameOnly - a[1].nameOnly || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  return { generatedAt: now.toISOString(), byType, totals, unknownTypes };
}

/** One-line digest for the ingest log. */
export function coverageSummaryLine(r: CoverageReport): string {
  const t = r.totals;
  const top = r.unknownTypes.slice(0, 5).join(", ");
  return `coverage: ${t.ruleParsed} rule-parsed, ${t.withGenericEdges} with generic edges, ${t.nameOnly} name-only (opaque) members${
    top ? `; name-only types: ${top}${r.unknownTypes.length > 5 ? ", …" : ""}` : ""
  }`;
}
