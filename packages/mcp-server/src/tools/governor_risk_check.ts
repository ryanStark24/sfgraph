import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  // Cap the rendered/returned risks so a large org can't blow the MCP token
  // budget (mirrors dead_code_audit). The summary still reports the true total.
  limit: z.number().int().min(1).max(500).default(50),
});

interface CachedRisk {
  qualifiedName: string;
  risk: string;
  evidence: string;
}

function readCachedRisks(db: unknown, orgId: string): CachedRisk[] | null {
  try {
    const d = db as {
      prepare: (s: string) => {
        all: (...args: unknown[]) => Array<{
          qualified_name: string;
          risk_type: string;
          evidence: string | null;
        }>;
      };
    };
    const rows = d
      .prepare(
        "SELECT qualified_name, risk_type, evidence FROM _sfgraph_governor_risks WHERE org_id = ?",
      )
      .all(orgId);
    if (!rows || rows.length === 0) return null;
    return rows.map((r) => ({
      qualifiedName: r.qualified_name,
      risk: r.risk_type,
      evidence: r.evidence ?? "",
    }));
  } catch {
    return null;
  }
}

defineTool({
  name: "governor_risk_check",
  description:
    "USE THIS for any 'SOQL in loop' / 'will this scale' / 'performance review' / 'governor limits' question about Salesforce Apex. Returns Apex methods/triggers with SOQL-in-loop, DML-in-loop, unbounded queries, missing trigger bulkification — with line + snippet.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const cached = ctx.db ? readCachedRisks(ctx.db, ctx.orgId) : null;
    const risks = cached ?? analyze.findGovernorRisks(ctx.graphStore, ctx.orgId);
    if (risks.length === 0) {
      return {
        summary: "no risks detected",
        markdown: "_no governor risks surfaced_",
        data: { risks: [], cached: cached !== null },
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
        ? ["", `_+${risks.length - shown.length} more — raise \`limit\` or use export_sarif._`]
        : []),
    ].join("\n");
    return {
      summary: `${risks.length} governor risks${cached ? " (cached)" : ""}${truncated ? ` (showing ${shown.length})` : ""}`,
      markdown: md,
      data: { risks: shown, total: risks.length, truncated, cached: cached !== null },
      follow_up_tools: ["explain_code", "trace_downstream"],
    };
  },
});
