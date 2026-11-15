import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { METADATA_CATEGORY } from "../domain/metadata-category.js";
import type { DomInjectionSpot } from "../parsers/lwc/dom-injection.js";
import type { GraphStore } from "../storage/interfaces.js";
import { type ScanCoverage, scanLabel, sumCoverage } from "./scan.js";

/**
 * Security findings read from component and Apex source: SOQL / SOSL injection in
 * Apex and DOM injection in LWC and Aura JavaScript. One finding shape, additive to
 * the field-access audit (`securityAudit`), which stays as it was.
 */
export interface CodeSecurityFinding {
  /** `security.soql-injection` or `security.dom-injection`. */
  ruleId: "security.soql-injection" | "security.dom-injection";
  severity: "high" | "medium" | "low";
  /** The method, trigger, LWC or Aura component the finding is in. */
  qualifiedName: string;
  /** The source file (a `file://` or `sf://` URI), when known. */
  file?: string;
  /** 1-based line in that file. */
  line?: number;
  /** One-line problem statement. */
  message: string;
  /** The source line, trimmed. */
  evidence: string;
  /** The variable that carries unescaped text into the query (injection only). */
  variable?: string;
  /** DOM injection: the JS file inside the bundle, and the DOM API used. */
  bundleFile?: string;
  kind?: string;
}

export interface CodeSecurityScan {
  findings: CodeSecurityFinding[];
  coverage: ScanCoverage;
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Where a bundle file lives: the bundle's folder URI plus the file name. */
function bundleFileUri(sourceUri: unknown, file: string): string | undefined {
  if (typeof sourceUri !== "string") return undefined;
  const base = sourceUri.replace(/\/+$/, "");
  return /\.(?:js|cmp|html)$/i.test(base) ? base.replace(/[^/]+$/, file) : `${base}/${file}`;
}

/**
 * SOQL / SOSL injection in every Apex method and trigger (the `soqlInjection` attribute
 * the Apex parsers stamp, test code excluded) and DOM injection in every LWC and Aura
 * component (the `domInjection` attribute). Every unit is read, a page at a time;
 * `coverage` says how many were examined of how many exist. Both attributes are
 * written at parse time: a graph ingested before 1.9.0 has neither, so it needs a
 * re-ingest to get these findings.
 */
export function scanCodeSecurity(store: GraphStore, orgId: OrgId): CodeSecurityScan {
  const findings: CodeSecurityFinding[] = [];
  const parts: ScanCoverage[] = [];
  for (const label of ["ApexMethod", METADATA_CATEGORY.APEX_TRIGGER]) {
    const scan = scanLabel(store, orgId, label);
    for (const page of scan.pages) {
      for (const n of page) {
        const attrs = n.attributes as Record<string, unknown>;
        if (attrs.isTest === true) continue;
        const spots = attrs.soqlInjection;
        if (!Array.isArray(spots)) continue;
        for (const spot of spots as Array<{
          line?: number;
          evidence: string;
          variable?: string;
          kind: string;
        }>) {
          findings.push({
            ruleId: "security.soql-injection",
            severity: "high",
            qualifiedName: String(n.qualifiedName),
            ...(typeof attrs.sourceUri === "string" ? { file: attrs.sourceUri } : {}),
            ...(spot.line != null ? { line: spot.line } : {}),
            message: `${spot.kind} builds its query from ${spot.variable ?? "a value"} without String.escapeSingleQuotes or a bind variable`,
            evidence: spot.evidence,
            ...(spot.variable ? { variable: spot.variable } : {}),
            kind: spot.kind,
          });
        }
      }
    }
    parts.push(scan.coverage());
  }
  for (const label of ["LWC", "AuraComponent"]) {
    const scan = scanLabel(store, orgId, label);
    for (const page of scan.pages) {
      for (const n of page) {
        const attrs = n.attributes as Record<string, unknown>;
        const spots = attrs.domInjection;
        if (!Array.isArray(spots)) continue;
        for (const s of spots as DomInjectionSpot[]) {
          const file = bundleFileUri(attrs.sourceUri, s.file);
          const manual = s.lwcDomManual === true ? ' in a template with lwc:dom="manual"' : "";
          findings.push({
            ruleId: "security.dom-injection",
            severity: s.severity,
            qualifiedName: String(n.qualifiedName),
            ...(file ? { file } : {}),
            line: s.line,
            message:
              s.severity === "low"
                ? `${s.kind} is set to a fixed string${manual}; no data flows in, but it bypasses template escaping`
                : `${s.kind} is set from a non-literal value${manual}; HTML in the data runs as markup`,
            evidence: s.evidence,
            bundleFile: s.file,
            kind: s.kind,
          });
        }
      }
    }
    parts.push(scan.coverage());
  }
  findings.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.qualifiedName.localeCompare(b.qualifiedName) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  return { findings, coverage: sumCoverage(parts) };
}
