import type { Finding, RuleDescriptor } from "../analyze/findings.js";
import { RULE_CATALOG } from "../analyze/findings.js";

/**
 * SARIF 2.1.0 emitter. Output validates against the OASIS schema
 * (https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) and
 * round-trips cleanly into GitHub Code Scanning and the VS Code SARIF
 * Viewer extension.
 *
 * Implementation choices:
 * - Hand-rolled (no `node-sarif-builder` or similar). The Stack research
 *   found those wrappers add a layer with no value over plain object
 *   literals for our emit needs.
 * - `properties.tags` carries the sfgraph rule family (`governor`,
 *   `security`, `dead-code`, `graph`) for filtering in code-scanning.
 * - `physicalLocation` is populated when the Finding has a `sourceUri`;
 *   absent otherwise (some findings are graph-only, with no real source
 *   artifact — SARIF allows this).
 * - Rule definitions come from RULE_CATALOG; only rules actually
 *   referenced by emitted results land in the output's `rules` array
 *   (SARIF spec allows but doesn't require unused rule definitions).
 */

export interface SarifReport {
  $schema: string;
  version: "2.1.0";
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifToolDriver };
  results: SarifResult[];
}

interface SarifToolDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  defaultConfiguration: { level: "error" | "warning" | "note" };
  helpUri?: string;
  properties: { tags: string[] };
}

interface SarifResult {
  ruleId: string;
  level: "error" | "warning" | "note";
  message: { text: string };
  locations: SarifLocation[];
  properties?: Record<string, string | number | boolean | null>;
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation: { uri: string };
    region?: { startLine: number; startColumn?: number };
  };
  logicalLocations?: Array<{ fullyQualifiedName: string; kind: string }>;
}

const TOOL_NAME = "sfgraph";
const TOOL_INFORMATION_URI = "https://github.com/ryanStark24/sfgraph";

function ruleFamily(ruleId: string): string {
  const dot = ruleId.indexOf(".");
  return dot > 0 ? ruleId.slice(0, dot) : ruleId;
}

function descriptorToSarifRule(desc: RuleDescriptor): SarifRule {
  const rule: SarifRule = {
    id: desc.id,
    name: desc.name,
    shortDescription: { text: desc.shortDescription },
    fullDescription: { text: desc.fullDescription },
    defaultConfiguration: { level: desc.defaultLevel },
    properties: { tags: [ruleFamily(desc.id)] },
  };
  if (desc.helpUri) rule.helpUri = desc.helpUri;
  return rule;
}

function findingToSarifResult(f: Finding): SarifResult {
  const locations: SarifLocation[] = [];
  const physical: SarifLocation = {};
  if (f.location.sourceUri) {
    physical.physicalLocation = {
      artifactLocation: { uri: f.location.sourceUri },
    };
    if (f.location.line != null) {
      physical.physicalLocation.region = {
        startLine: f.location.line,
        ...(f.location.column != null ? { startColumn: f.location.column } : {}),
      };
    }
  }
  // Always include the graph node as a logicalLocation — SARIF allows
  // results without a physicalLocation as long as a logicalLocation
  // identifies the subject.
  physical.logicalLocations = [
    { fullyQualifiedName: f.location.qualifiedName, kind: "module" },
  ];
  locations.push(physical);

  const result: SarifResult = {
    ruleId: f.ruleId,
    level: f.level,
    message: { text: f.message },
    locations,
  };
  if (f.properties && Object.keys(f.properties).length > 0) {
    result.properties = f.properties;
  }
  return result;
}

export interface EmitSarifOpts {
  /** sfgraph version string. Filled into the tool driver block. */
  version: string;
  findings: Finding[];
}

export function emitSarif(opts: EmitSarifOpts): SarifReport {
  const referencedRuleIds = new Set<string>();
  for (const f of opts.findings) referencedRuleIds.add(f.ruleId);

  const rules: SarifRule[] = [];
  for (const id of [...referencedRuleIds].sort()) {
    const desc = RULE_CATALOG[id];
    if (!desc) {
      // Unknown rule — emit a stub definition so the SARIF stays valid
      // rather than dropping the result. Catalog hygiene is a separate
      // concern; the emitter doesn't enforce it.
      rules.push({
        id,
        name: id,
        shortDescription: { text: id },
        fullDescription: { text: `No catalog entry for ${id}` },
        defaultConfiguration: { level: "note" },
        properties: { tags: [ruleFamily(id)] },
      });
    } else {
      rules.push(descriptorToSarifRule(desc));
    }
  }

  const report: SarifReport = {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: opts.version,
            informationUri: TOOL_INFORMATION_URI,
            rules,
          },
        },
        results: opts.findings.map(findingToSarifResult),
      },
    ],
  };
  return report;
}

/**
 * Validate that a SARIF report has the structural pieces required by
 * GitHub Code Scanning's accept criteria. Returns an array of human-
 * readable error strings (empty when the report is valid). This is a
 * subset check, not a full schema validation — the spec is too large
 * for inline validation, and `ajv` is a build-time dependency only.
 */
export function lintSarifReport(report: SarifReport): string[] {
  const errors: string[] = [];
  if (report.version !== "2.1.0") errors.push(`expected version=2.1.0, got ${report.version}`);
  if (!report.$schema || !report.$schema.includes("sarif-schema-2.1.0")) {
    errors.push("missing or non-2.1.0 $schema");
  }
  if (!Array.isArray(report.runs) || report.runs.length === 0) {
    errors.push("at least one run required");
    return errors;
  }
  for (const [i, run] of report.runs.entries()) {
    if (!run.tool?.driver?.name) errors.push(`runs[${i}].tool.driver.name missing`);
    if (!run.tool?.driver?.rules) errors.push(`runs[${i}].tool.driver.rules missing`);
    if (!Array.isArray(run.results)) errors.push(`runs[${i}].results not an array`);
    const ruleIds = new Set(run.tool?.driver?.rules?.map((r) => r.id) ?? []);
    for (const [j, r] of (run.results ?? []).entries()) {
      if (!ruleIds.has(r.ruleId)) {
        errors.push(`runs[${i}].results[${j}].ruleId '${r.ruleId}' has no rule definition`);
      }
      if (!r.locations || r.locations.length === 0) {
        errors.push(`runs[${i}].results[${j}] has no locations`);
      }
    }
  }
  return errors;
}
