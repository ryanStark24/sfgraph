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
  "governor.sosl-in-loop": {
    id: "governor.sosl-in-loop",
    name: "SOSL in loop",
    shortDescription: "Apex method executes SOSL inside a loop.",
    fullDescription:
      "Detected from the EXECUTES_SOSL edge the Apex parser stamps `inLoop`. Each loop iteration consumes one of the 20 SOSL queries the platform allows per transaction — search once outside the loop.",
    defaultLevel: "error",
  },
  "governor.dynamic-soql-in-loop": {
    id: "governor.dynamic-soql-in-loop",
    name: "Dynamic SOQL in loop",
    shortDescription:
      "Apex method or trigger runs a dynamic query (Database.query, ...) inside a loop.",
    fullDescription:
      "Detected from the `dynamicQueryInLoop` attribute the Apex parsers stamp on a method or trigger. Each iteration consumes one of the 100 SOQL queries allowed per transaction — build one query outside the loop.",
    defaultLevel: "error",
  },
  "governor.unbounded-query": {
    id: "governor.unbounded-query",
    name: "Unbounded query",
    shortDescription: "Apex method runs SOQL with no LIMIT or WHERE.",
    fullDescription:
      "Detected from the stored source of an Apex method or trigger: an inline query with no LIMIT and no WHERE in its own clause (a WHERE on any field counts as a filter; selectivity is not judged; COUNT() queries and Custom Metadata Type queries are not flagged). Queries without a LIMIT or selective WHERE clause hit the 50,000-row query-row governor on large objects. Add a LIMIT or filter even if the developer believes the underlying data set is small.",
    defaultLevel: "warning",
  },
  "governor.no-bulk": {
    id: "governor.no-bulk",
    name: "Trigger not bulk-safe",
    shortDescription: "Trigger touches a single record per fire — fails on bulk DML.",
    fullDescription:
      "Detected from the stored trigger source: it reads one record of `Trigger.new` / `Trigger.old` by a literal position (`Trigger.new[0]`, `Trigger.new.get(0)`), has no loop over the trigger's records, and does not pass the collections anywhere else. A trigger that delegates to a handler is not judged. Bulk DML produces triggers with up to 200 records in `Trigger.new`; a trigger that assumes a single record will silently mis-process the other 199 — refactor to iterate over the collection.",
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
  "security.sharing-edit-access": {
    id: "security.sharing-edit-access",
    name: "Sharing rule gives record Edit access",
    shortDescription:
      "A sharing rule gives its audience Edit (or All) access to records of the object.",
    fullDescription:
      "Record-level access granted by a sharing rule, with the audience the rule stores (a group, role or guest user, for example). This is record sharing only. It does not show that the audience has object (CRUD) or field-level permissions, and it is not Modify All or View All, which are permission set and profile settings. Check that the audience should be able to edit these records. The analysis does not read org-wide defaults or work out any one user's effective access.",
    defaultLevel: "note",
  },
  "dead-code.unreferenced": {
    id: "dead-code.unreferenced",
    name: "Unreferenced metadata",
    shortDescription: "Node has no captured incoming references in the graph.",
    fullDescription:
      "Apex/LWC/Flow components with no captured incoming references in the graph. This does not show that nothing uses them: callers outside the graph (integrations calling a REST endpoint or global method, the UI, schedules, batch jobs, managed packages) are not captured. Results marked `externalEntryPoint` are known entry points of that kind and are not deletion candidates on this evidence alone. Verify against logs, API clients and schedules before deleting anything.",
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
import type { AuditResult } from "./audit-graph.js";
import { findDeadCode } from "./dead-code.js";
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
  const details = new Map((audit.sharingRuleAccess ?? []).map((r) => [r.qualifiedName, r]));
  for (const obj of audit.sharingEditAccess ?? audit.sharingFullAccess ?? []) {
    const d = details.get(obj);
    const what = d ? `${d.access} access` : "Edit or All access";
    const who = d?.audience ? ` to ${d.audience}` : "";
    out.push({
      ruleId: "security.sharing-edit-access",
      message: `${obj}: sharing rule gives ${what} to records${who} (record sharing only; says nothing about object or field permissions)`,
      level: "note",
      location: { qualifiedName: obj },
      ...(d
        ? { properties: { access: d.access, ...(d.audience ? { audience: d.audience } : {}) } }
        : {}),
    });
  }
  return out;
}

/** The caveat every dead-code finding carries. */
export const DEAD_CODE_CAVEAT =
  "Callers outside the graph (integrations, the UI, schedules) are not captured.";

export function deadCodeToFindings(
  nodes: NodeFact[],
  entryPoints: ReadonlyMap<string, readonly string[]> = new Map(),
): Finding[] {
  return nodes.map((n) => {
    const eps = entryPoints.get(String(n.qualifiedName)) ?? [];
    return {
      ruleId: "dead-code.unreferenced",
      message:
        eps.length > 0
          ? `${n.qualifiedName}: no captured incoming references, but it is a known external entry point (${eps.join(", ")}). ${DEAD_CODE_CAVEAT}`
          : `${n.qualifiedName}: no captured incoming references. ${DEAD_CODE_CAVEAT}`,
      level: "note",
      location: {
        qualifiedName: String(n.qualifiedName),
        ...(typeof n.attributes.sourceUri === "string"
          ? { sourceUri: n.attributes.sourceUri }
          : {}),
      },
      properties: {
        label: n.label,
        externalEntryPoint: eps.length > 0,
        ...(eps.length > 0 ? { entryPointKinds: eps.join(",") } : {}),
      },
    };
  });
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
  /** Known external entry points of the dead-code nodes, by qualified name. */
  deadCodeEntryPoints?: ReadonlyMap<string, readonly string[]>;
  dangling?: AuditResult;
}

export function collectFindings(opts: AllFindingsOpts): Finding[] {
  const out: Finding[] = [];
  if (opts.governor) out.push(...governorRisksToFindings(opts.governor));
  if (opts.security) out.push(...securityAuditToFindings(opts.security));
  if (opts.deadCode) out.push(...deadCodeToFindings(opts.deadCode, opts.deadCodeEntryPoints));
  if (opts.dangling) out.push(...danglingEdgesToFindings(opts.dangling));
  return out;
}

// Re-export findDeadCode reference so callers don't need a separate import
// when wiring up `collectFindings({ deadCode: findDeadCode(store, orgId), ... })`.
export { findDeadCode };
export type { OrgId };
