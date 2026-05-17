/**
 * Canonical finding shape for everything in sfgraph that produces
 * actionable diagnostics: governor-risk scan, security audit, dead-code
 * audit, dangling-edge audit, future rule-engine outputs. Aligned with
 * PMD's rule metadata vocabulary (name / message / description /
 * priority / externalInfoUrl / properties) so the SARIF emitter can
 * map a single shape rather than a switch over every producer.
 *
 * NOTE: the YAML files in parsers/rules/* are NOT lint rules — they're
 * declarative metadata-to-graph extraction shortcuts. The Wave 3 plan's
 * "PMD-aligned YAML rule schema" was a category error from the
 * competitive analysis. The real PMD-aligned schema is this Finding
 * type plus the rule catalog below — the producers stay where they are
 * (analyze/governor.ts, analyze/security.ts, etc.) and emit Findings
 * via the adapters in `findingAdapters` below.
 */

export type Severity = "error" | "warning" | "note";

export interface FindingLocation {
  /** Graph node qualified name that the finding is anchored to. */
  qualifiedName: string;
  /** Optional: file URI when the finding maps to a parsed source artifact. */
  sourceUri?: string;
  /** Optional: 1-indexed line / column for SARIF physicalLocation. */
  line?: number;
  column?: number;
}

export interface Finding {
  /** PMD-style stable rule identifier, e.g. `governor.soql-in-loop`. */
  ruleId: string;
  /** One-line problem statement shown verbatim in SARIF / IDE diagnostics. */
  message: string;
  level: Severity;
  /** Where the finding lives in the graph (and optionally in source). */
  location: FindingLocation;
  /** Free-form key/value pairs for downstream consumers (SARIF
   *  `properties` bag carries this verbatim). */
  properties?: Record<string, string | number | boolean | null>;
}

/**
 * Static catalog of every rule sfgraph emits today. SARIF requires a rule
 * definition (`reportingDescriptor`) for each unique `ruleId` referenced
 * by a result, so we index findings against this map at emit time. New
 * audits register their ruleIds here so SARIF stays valid without per-emit
 * boilerplate.
 *
 * Fields mirror PMD's `name / description / priority / externalInfoUrl`:
 * - `name`: short display name
 * - `shortDescription`: 1-line summary
 * - `fullDescription`: paragraph-length explanation (markdown ok)
 * - `defaultLevel`: severity floor; per-Finding `level` can downgrade
 * - `helpUri`: optional documentation link
 */
export interface RuleDescriptor {
  id: string;
  name: string;
  shortDescription: string;
  fullDescription: string;
  defaultLevel: Severity;
  helpUri?: string;
}

export const RULE_CATALOG: Record<string, RuleDescriptor> = {
  "governor.soql-in-loop": {
    id: "governor.soql-in-loop",
    name: "SOQL in loop",
    shortDescription: "Apex method executes SOQL inside a loop.",
    fullDescription:
      "Detected via the `hasSoqlInLoop` attribute set by Apex parsing. Each loop iteration consumes one of the 100 SOQL queries the platform allows per transaction — bulkify by moving the query outside the loop and consuming the results inline.",
    defaultLevel: "error",
  },
  "governor.dml-in-loop": {
    id: "governor.dml-in-loop",
    name: "DML in loop",
    shortDescription: "Apex method executes DML inside a loop.",
    fullDescription:
      "Detected via the `hasDmlInLoop` attribute set by Apex parsing. Each loop iteration consumes one of the 150 DML statements the platform allows per transaction — bulkify by collecting records into a list and committing once after the loop.",
    defaultLevel: "error",
  },
  "governor.unbounded-query": {
    id: "governor.unbounded-query",
    name: "Unbounded query",
    shortDescription: "Apex method runs SOQL with no LIMIT or WHERE.",
    fullDescription:
      "Queries without a LIMIT or selective WHERE clause hit the 50,000-row query-row governor on large objects. Add a LIMIT or filter even if the developer believes the underlying data set is small.",
    defaultLevel: "warning",
  },
  "governor.no-bulk": {
    id: "governor.no-bulk",
    name: "Trigger not bulk-safe",
    shortDescription: "Trigger touches a single record per fire — fails on bulk DML.",
    fullDescription:
      "Bulk DML produces triggers with up to 200 records in `Trigger.new`. Triggers that assume a single record will silently mis-process the other 199 — refactor to iterate over the collection.",
    defaultLevel: "error",
  },
  "security.fls-gap": {
    id: "security.fls-gap",
    name: "Field-level security gap",
    shortDescription: "CustomField has no FLS grant on any profile/permission set.",
    fullDescription:
      "Fields with no FLS grant are invisible to every user in API and UI alike. Either remove the field if unused or grant access on the appropriate permission set.",
    defaultLevel: "warning",
  },
  "security.sharing-full-access": {
    id: "security.sharing-full-access",
    name: "Object granted full access via sharing",
    shortDescription: "OWD or sharing rule grants Modify All / View All to a broad audience.",
    fullDescription:
      "Granting full access via OWD or sharing rules bypasses field-level security and CRUD checks. Review whether the audience genuinely needs unrestricted access; prefer scoped permission sets.",
    defaultLevel: "warning",
  },
  "dead-code.unreferenced": {
    id: "dead-code.unreferenced",
    name: "Unreferenced metadata",
    shortDescription: "Node has no incoming edges and is not an obvious entry point.",
    fullDescription:
      "Apex/LWC/Flow components with no incoming references are candidates for deletion. Note that some entry points (AuraEnabled, REST endpoints, scheduled jobs) are only reachable from outside the org and will show up here legitimately — verify before deleting.",
    defaultLevel: "note",
  },
  "graph.dangling-edge": {
    id: "graph.dangling-edge",
    name: "Dangling edge",
    shortDescription: "Edge points to a destination node that doesn't exist in the graph.",
    fullDescription:
      "Dangling edges usually indicate ingest gaps (a metadata type that didn't get extracted) or stale references (managed-package targets no longer installed). Investigate which extractor would own the missing dst label.",
    defaultLevel: "note",
  },
};

// ---------------------------------------------------------------------------
// Adapters: convert each audit's native return shape into Finding[].
// ---------------------------------------------------------------------------

import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import { findDeadCode } from "./dead-code.js";
import type { AuditResult } from "./audit-graph.js";
import type { GovernorRisk } from "./governor.js";
import type { SecurityAudit } from "./security.js";

export function governorRisksToFindings(risks: GovernorRisk[]): Finding[] {
  return risks.map((r) => ({
    ruleId: `governor.${r.risk.replace(/_/g, "-")}`,
    message: `${r.qualifiedName}: ${r.evidence}`,
    level: RULE_CATALOG[`governor.${r.risk.replace(/_/g, "-")}`]?.defaultLevel ?? "warning",
    location: { qualifiedName: r.qualifiedName },
    properties: { evidence: r.evidence },
  }));
}

export function securityAuditToFindings(audit: SecurityAudit): Finding[] {
  const out: Finding[] = [];
  for (const gap of audit.flsGaps) {
    out.push({
      ruleId: "security.fls-gap",
      message: `${gap}: no FLS grant on any profile/permission set`,
      level: "warning",
      location: { qualifiedName: gap },
    });
  }
  for (const obj of audit.sharingFullAccess) {
    out.push({
      ruleId: "security.sharing-full-access",
      message: `${obj}: granted full access via sharing rule or OWD`,
      level: "warning",
      location: { qualifiedName: obj },
    });
  }
  return out;
}

export function deadCodeToFindings(nodes: NodeFact[]): Finding[] {
  return nodes.map((n) => ({
    ruleId: "dead-code.unreferenced",
    message: `${n.qualifiedName}: no incoming references`,
    level: "note",
    location: {
      qualifiedName: String(n.qualifiedName),
      ...(typeof n.attributes.sourceUri === "string"
        ? { sourceUri: n.attributes.sourceUri }
        : {}),
    },
    properties: { label: n.label },
  }));
}

export function danglingEdgesToFindings(audit: AuditResult): Finding[] {
  return audit.sample.map((s) => ({
    ruleId: "graph.dangling-edge",
    message: `${s.src} --${s.rel}--> ${s.dst}: dst node missing`,
    level: "note",
    location: { qualifiedName: s.src },
    properties: { relType: s.rel, danglingDst: s.dst },
  }));
}

/**
 * Convenience: run every adapter against an org and return a unified
 * Finding[]. Caller controls which audits to invoke and threads the
 * GraphStore + orgId. SARIF emitter consumes this directly.
 */
export interface AllFindingsOpts {
  governor?: GovernorRisk[];
  security?: SecurityAudit;
  deadCode?: NodeFact[];
  dangling?: AuditResult;
}

export function collectFindings(opts: AllFindingsOpts): Finding[] {
  const out: Finding[] = [];
  if (opts.governor) out.push(...governorRisksToFindings(opts.governor));
  if (opts.security) out.push(...securityAuditToFindings(opts.security));
  if (opts.deadCode) out.push(...deadCodeToFindings(opts.deadCode));
  if (opts.dangling) out.push(...danglingEdgesToFindings(opts.dangling));
  return out;
}

// Re-export findDeadCode reference so callers don't need a separate import
// when wiring up `collectFindings({ deadCode: findDeadCode(store, orgId), ... })`.
export { findDeadCode };
export type { OrgId };
