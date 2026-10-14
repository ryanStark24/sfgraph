import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { collectGovernorRisks, describeSource } from "./_analysis-cache.js";
import { defineTool, numeric, z } from "./_define.js";
import { plainKind } from "./_plain.js";
import { labelOfQname, unitOf } from "./_reach_list.js";
import {
  type Piece,
  andList,
  code,
  countNoun,
  kindCounts,
  listWithMore,
  nameOf,
  renderReport,
  tableCell,
} from "./_report.js";

type Risk = ReturnType<typeof collectGovernorRisks>["risks"][number];

/** Each risk kind in plain words: [one, many]. */
const RISK_PLAIN: Readonly<Record<Risk["risk"], [string, string]>> = {
  soql_in_loop: ["database query inside a loop", "database queries inside a loop"],
  sosl_in_loop: ["text search inside a loop", "text searches inside a loop"],
  dynamic_soql_in_loop: [
    "query built at run time inside a loop",
    "queries built at run time inside a loop",
  ],
  dml_in_loop: ["record save inside a loop", "record saves inside a loop"],
  no_bulk: [
    "trigger that handles one record at a time",
    "triggers that handle one record at a time",
  ],
  unbounded_query: ["query with no row limit", "queries with no row limit"],
};
type Severity = "high" | "medium" | "low";
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 3, medium: 2, low: 1 };
/**
 * A risk's severity from its SARIF level: `error` (a loop or a trigger that uses up a
 * per-transaction limit) is high, `warning` is medium, `note` is low.
 */
const severityOf = (r: Risk): Severity => {
  const level =
    analyze.RULE_CATALOG[`governor.${r.risk.replace(/_/g, "-")}`]?.defaultLevel ?? "warning";
  return level === "error" ? "high" : level === "note" ? "low" : "medium";
};
const isHigh = (r: Risk): boolean => severityOf(r) === "high";
const riskText = (kind: Risk["risk"], n: number): string => {
  const w = RISK_PLAIN[kind] ?? [kind.replace(/_/g, " "), kind.replace(/_/g, " ")];
  return `${n} ${n === 1 ? w[0] : w[1]}`;
};
/** "2 database queries inside a loop and 1 record save inside a loop", in the documented order. */
function byKind(risks: readonly Risk[]): string {
  const m = new Map<Risk["risk"], number>();
  for (const r of risks) m.set(r.risk, (m.get(r.risk) ?? 0) + 1);
  return andList([...m].map(([k, n]) => riskText(k, n)));
}
/** "3 high-risk spots" / "2 high-risk spots and 1 medium-risk spot". */
function bySeverity(risks: readonly Risk[]): string {
  const n = { high: 0, medium: 0, low: 0 };
  for (const r of risks) n[severityOf(r)] += 1;
  return andList(
    (["high", "medium", "low"] as const)
      .filter((s) => n[s] > 0)
      .map((s) => countNoun(n[s], `${s}-risk spot`)),
  );
}
/** The class or trigger a risk is in: a method's owning class, else the risk's own component. */
const ownerOf = (q: string) => unitOf({ qualifiedName: q, label: labelOfQname(q) });
/** A method's short name: `run` for `ApexMethod:CaseService.run(0)`. */
const methodName = (q: string): string => {
  const n = nameOf(q).replace(/\(.*$/, "");
  return n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : n;
};
/** Test classes named in the In short before "and N more". */
const TEST_NAMES_MAX = 10;
/** Spots named on a piece's line before "and N more". */
const SPOTS_NAMED_MAX = 3;
/** Names in one Technical details list before "and N more" (a large org has hundreds). */
const DETAILS_NAMES_MAX = 50;
/** Classes and triggers A to Z by name (case-insensitive), then by qname. */
const byName = (a: string, b: string): number =>
  nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()) || a.localeCompare(b);
const CHECKED =
  "Checked: Apex methods and triggers, direct only (a loop that calls another method which queries is not counted)";

/** The documented sort applied before `limit` (T15 I-5). */
const ORDER =
  "severity, then kind (soql_in_loop, sosl_in_loop, dynamic_soql_in_loop, dml_in_loop, no_bulk, unbounded_query), then qualified name, then evidence";

const inputSchema = z.object({
  org: z.string().min(1),
  // Cap the rendered/returned risks so a large org can't blow the MCP token
  // budget (mirrors dead_code_audit). The summary still reports the true total.
  limit: numeric(z.number().int().min(1).max(500).default(50)),
  /** Include test code (TestMethod / @isTest). Off by default: test code
   *  doesn't run in production, so its loops aren't governor risks there. */
  includeTests: z.boolean().default(false),
  /** Lowest severity listed. Medium by default: every current check is high or medium. */
  min_severity: z.enum(["high", "medium", "low"]).default("medium"),
});

defineTool({
  name: "governor_risk_check",
  description:
    "Use for 'SOQL in loop / governor limits'. Lists SOQL, SOSL or DML in loops, unbounded queries and unbulkified triggers, worst first.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const collected = collectGovernorRisks(ctx, { includeTests: input.includeTests });
    const { source, cache, excludedTests } = collected;
    // The classes and triggers whose test-code spots were left out, A to Z (named, so a reader
    // asking about them sees they were left out rather than clean).
    const testOwners = [
      ...new Set(collected.excludedTestQnames.map((q) => ownerOf(q).qualifiedName)),
    ].sort(byName);
    // Spots below `min_severity` are left out before `limit`, and counted.
    const floor = SEVERITY_RANK[input.min_severity];
    const risks = collected.risks.filter((r) => SEVERITY_RANK[severityOf(r)] >= floor);
    const belowFloor = collected.risks.filter((r) => SEVERITY_RANK[severityOf(r)] < floor);
    const hiddenBelowSeverity = belowFloor.length;
    const lowestHidden = belowFloor.some((r) => severityOf(r) === "low") ? "low" : "medium";
    const severityNote =
      hiddenBelowSeverity > 0
        ? ` ${bySeverity(belowFloor)} ${hiddenBelowSeverity === 1 ? "is" : "are"} not shown (set \`min_severity: "${lowestHidden}"\` to see ${hiddenBelowSeverity === 1 ? "it" : "them"}).`
        : "";
    const cached = source === "live+cache";
    const meta = {
      source,
      cache: cache.state,
      ...(cache.reason ? { cacheReason: cache.reason } : {}),
      excludedTests,
      minSeverity: input.min_severity,
      hiddenBelowSeverity,
    };
    const testNameList = testOwners.map((q) => code(nameOf(q)));
    const testNames =
      testNameList.length > TEST_NAMES_MAX + 1
        ? listWithMore(testNameList, TEST_NAMES_MAX)
        : andList(testNameList);
    const testNote =
      excludedTests > 0
        ? ` ${countNoun(excludedTests, "spot")} in test code ${excludedTests === 1 ? "was" : "were"} left out, in ${testNames} (set \`includeTests: true\` to see ${excludedTests === 1 ? "it" : "them"}).`
        : "";
    const testDetails = testOwners.length
      ? `Left out as test code: ${listWithMore(
          testOwners.map((q) => `\`${q}\``),
          DETAILS_NAMES_MAX,
        )}.`
      : "";
    const scanNotes = [
      "Scans the graph live; a cache adds rows only when it is fresh.",
      ...(input.includeTests ? [] : ["Test code is excluded unless `includeTests` is true."]),
    ];
    if (risks.length === 0) {
      const one = hiddenBelowSeverity === 1;
      return {
        summary:
          hiddenBelowSeverity > 0
            ? `no risks at or above ${input.min_severity} (${hiddenBelowSeverity} hidden below min_severity)`
            : "no risks detected",
        markdown: renderReport({
          title: "Code that may hit Salesforce limits",
          inShort: [
            hiddenBelowSeverity > 0
              ? `No spots are shown: the only ${one ? "spot found is" : "spots found are"} ${bySeverity(belowFloor)}, below \`min_severity: "${input.min_severity}"\`; set \`min_severity: "${lowestHidden}"\` to see ${one ? "it" : "them"}.`
              : "No spots found where Apex code may hit Salesforce's per-transaction limits.",
            `${CHECKED}.${testNote}`,
          ],
          details: ["_no governor risks surfaced_", ...(testDetails ? ["", testDetails] : [])].join(
            "\n",
          ),
          next: ["Use `explain_code` on a class to read its code.", ...scanNotes],
        }),
        data: { risks: [], total: 0, truncated: false, order: ORDER, cached, ...meta },
        follow_up_tools: ["explain_code", "trace_downstream"],
      };
    }
    const shown = risks.slice(0, input.limit);
    const truncated = risks.length > shown.length;
    // The listed spots grouped by the class or trigger they are in, groups A to Z (a reader scans
    // for a name); each group keeps priority order (`shown` is sorted). `limit` still keeps the
    // highest-priority spots.
    const shownByOwner = new Map<string, Risk[]>();
    for (const r of shown) {
      const o = ownerOf(r.qualifiedName).qualifiedName;
      shownByOwner.set(o, [...(shownByOwner.get(o) ?? []), r]);
    }
    const md = [
      "Grouped by class or trigger, A to Z.",
      "",
      ...[...shownByOwner]
        .sort(([a], [b]) => byName(a, b))
        .flatMap(([o, rs], i) => [
          ...(i > 0 ? [""] : []),
          `#### \`${o}\``,
          "",
          "| qname | risk | evidence |",
          "|---|---|---|",
          ...rs.map((r) => `| \`${r.qualifiedName}\` | ${r.risk} | ${tableCell(r.evidence)} |`),
        ]),
      ...(truncated
        ? [
            "",
            `_showing the ${shown.length} highest-priority of ${risks.length} risks (+${risks.length - shown.length} more) — raise \`limit\` or use export_sarif._`,
          ]
        : []),
      "",
      `_source: ${describeSource(source, cache)}${excludedTests > 0 ? `; ${excludedTests} test-code risks excluded (includeTests: true to show)` : ""}_`,
      ...(testDetails ? ["", testDetails] : []),
    ].join("\n");
    // Group by the class or trigger each spot is in, in priority order (the risks are sorted).
    const owners = new Map<string, { label: string; risks: Risk[] }>();
    for (const r of risks) {
      const o = ownerOf(r.qualifiedName);
      const g = owners.get(o.qualifiedName) ?? { label: o.label, risks: [] };
      g.risks.push(r);
      owners.set(o.qualifiedName, g);
    }
    const ownerLabels = [...owners.values()].map((g) => g.label);
    // A piece per class or trigger with a listed spot; its counts cover all of its spots.
    const listed = new Set(shown.map((r) => ownerOf(r.qualifiedName).qualifiedName));
    const pieces: Piece[] = [...owners]
      .filter(([q]) => listed.has(q))
      .sort(([a], [b]) => byName(a, b))
      .map(([q, g]) => {
        const where = (r: Risk) =>
          r.qualifiedName === q ? "" : ` in ${code(methodName(r.qualifiedName))}`;
        const spots = g.risks.map((r) => `${riskText(r.risk, 1).replace(/^1 /, "a ")}${where(r)}`);
        return {
          name: q,
          kind: g.label,
          role: `${plainKind(g.label)} with ${bySeverity(g.risks)}: ${spots.length > SPOTS_NAMED_MAX + 1 ? listWithMore(spots, SPOTS_NAMED_MAX) : andList(spots)}.`,
        };
      });
    // Classes and triggers none of whose spots made the `limit` cut: named, so a reader looking for
    // one sees it has spots (cycle 3 T9 fix 2).
    const cutOwners = [...owners].filter(([q]) => !listed.has(q)).sort(([a], [b]) => byName(a, b));
    const cutSpots = cutOwners.reduce((n, [, g]) => n + g.risks.length, 0);
    const cutLine = cutOwners.length
      ? `Not listed below (their spots rank lower), A to Z: ${listWithMore(
          cutOwners.map(([q, g]) => `\`${q}\` (${countNoun(g.risks.length, "spot")})`),
          DETAILS_NAMES_MAX,
        )}${cutOwners.length > DETAILS_NAMES_MAX + 1 ? " (`export_sarif` lists them all)" : ""}.`
      : "";
    const markdown = renderReport({
      title: "Code that may hit Salesforce limits",
      inShort: [
        `${bySeverity(risks)} in ${kindCounts(ownerLabels)} may hit Salesforce's per-transaction limits: ${byKind(risks)}.${severityNote}`,
        ...(truncated
          ? [
              `Only the ${shown.length === 1 ? "first 1 is" : `first ${shown.length} are`} listed below (the highest priority), grouped by class or trigger, A to Z.`,
              ...(cutOwners.length
                ? [
                    `${countNoun(cutSpots, "other spot")} ${cutSpots === 1 ? "is" : "are"} in ${kindCounts(cutOwners.map(([, g]) => g.label))} not listed below; Technical details names ${cutOwners.length === 1 ? "it" : "them"}.`,
                  ]
                : []),
            ]
          : []),
        `${CHECKED}.${testNote}`,
      ],
      pieces,
      details: cutLine ? `${cutLine}\n\n${md}` : md,
      next: [
        ...(truncated
          ? ["Raise `limit` to list more, or use `export_sarif` for all of them."]
          : []),
        "Use `explain_code` on a method to see the loop.",
        "Run `trace_downstream` on a class to see what the code reaches.",
        ...scanNotes,
      ],
    });
    return {
      summary: `${risks.length} governor risks${truncated ? ` (showing ${shown.length})` : ""}`,
      markdown,
      data: { risks: shown, total: risks.length, truncated, order: ORDER, cached, ...meta },
      follow_up_tools: ["explain_code", "trace_downstream"],
    };
  },
});
