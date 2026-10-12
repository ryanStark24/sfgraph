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
  nameOf,
  renderReport,
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
/** High risk: the SARIF `error` kinds (a loop or a trigger that uses up a per-transaction limit). */
const isHigh = (r: Risk): boolean =>
  (analyze.RULE_CATALOG[`governor.${r.risk.replace(/_/g, "-")}`]?.defaultLevel ?? "warning") ===
  "error";
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
  const high = risks.filter(isHigh).length;
  const medium = risks.length - high;
  return andList([
    ...(high ? [countNoun(high, "high-risk spot")] : []),
    ...(medium ? [countNoun(medium, "medium-risk spot")] : []),
  ]);
}
/** The class or trigger a risk is in: a method's owning class, else the risk's own component. */
const ownerOf = (q: string) => unitOf({ qualifiedName: q, label: labelOfQname(q) });
/** A method's short name: `run` for `ApexMethod:CaseService.run(0)`. */
const methodName = (q: string): string => {
  const n = nameOf(q).replace(/\(.*$/, "");
  return n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : n;
};
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
});

defineTool({
  name: "governor_risk_check",
  description:
    "Use for 'SOQL in loop / governor limits'. Lists Apex with SOQL, SOSL or DML in a loop, unbounded queries and unbulkified triggers, worst first.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const { risks, source, cache, excludedTests } = collectGovernorRisks(ctx, {
      includeTests: input.includeTests,
    });
    const cached = source === "live+cache";
    const meta = {
      source,
      cache: cache.state,
      ...(cache.reason ? { cacheReason: cache.reason } : {}),
      excludedTests,
    };
    const testNote =
      excludedTests > 0
        ? ` ${countNoun(excludedTests, "spot")} in test code ${excludedTests === 1 ? "was" : "were"} left out (set \`includeTests: true\` to see ${excludedTests === 1 ? "it" : "them"}).`
        : "";
    const scanNotes = [
      "Scans the graph live; a cache adds rows only when it is fresh.",
      ...(input.includeTests ? [] : ["Test code is excluded unless `includeTests` is true."]),
    ];
    if (risks.length === 0) {
      return {
        summary: "no risks detected",
        markdown: renderReport({
          title: "Code that may hit Salesforce limits",
          inShort: [
            "No spots found where Apex code may hit Salesforce's per-transaction limits.",
            `${CHECKED}.${testNote}`,
          ],
          details: "_no governor risks surfaced_",
          next: ["Use `explain_code` on a class to read its code.", ...scanNotes],
        }),
        data: { risks: [], total: 0, truncated: false, order: ORDER, cached, ...meta },
        follow_up_tools: ["explain_code", "trace_downstream"],
      };
    }
    const shown = risks.slice(0, input.limit);
    const truncated = risks.length > shown.length;
    const md = [
      "| qname | risk | evidence |",
      "|---|---|---|",
      ...shown.map((r) => `| \`${r.qualifiedName}\` | ${r.risk} | ${r.evidence} |`),
      ...(truncated
        ? [
            "",
            `_showing the ${shown.length} highest-priority of ${risks.length} risks (+${risks.length - shown.length} more) — raise \`limit\` or use export_sarif._`,
          ]
        : []),
      "",
      `_source: ${describeSource(source, cache)}${excludedTests > 0 ? `; ${excludedTests} test-code risks excluded (includeTests: true to show)` : ""}_`,
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
      .map(([q, g]) => {
        const where = (r: Risk) =>
          r.qualifiedName === q ? "" : ` in ${code(methodName(r.qualifiedName))}`;
        const spots = g.risks.map((r) => `${riskText(r.risk, 1).replace(/^1 /, "a ")}${where(r)}`);
        return {
          name: q,
          kind: g.label,
          role: `${plainKind(g.label)} with ${bySeverity(g.risks)}: ${spots.length > 3 ? `${spots.slice(0, 3).join(", ")} and ${spots.length - 3} more` : andList(spots)}.`,
        };
      });
    const markdown = renderReport({
      title: "Code that may hit Salesforce limits",
      inShort: [
        `${bySeverity(risks)} in ${kindCounts(ownerLabels)} may hit Salesforce's per-transaction limits: ${byKind(risks)}.`,
        ...(truncated
          ? [
              `Only the ${shown.length === 1 ? "first 1 is" : `first ${shown.length} are`} listed below, highest priority first.`,
            ]
          : []),
        `${CHECKED}.${testNote}`,
      ],
      pieces,
      details: md,
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
