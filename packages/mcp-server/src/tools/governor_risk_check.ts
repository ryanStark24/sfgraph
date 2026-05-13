import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({ org: z.string().min(1) });

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
  description: "List Apex with detected governor-limit risks (SOQL/DML in loop).",
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
      };
    }
    const md = [
      "| qname | risk | evidence |",
      "|---|---|---|",
      ...risks.map((r) => `| \`${r.qualifiedName}\` | ${r.risk} | ${r.evidence} |`),
    ].join("\n");
    return {
      summary: `${risks.length} governor risks${cached ? " (cached)" : ""}`,
      markdown: md,
      data: { risks, cached: cached !== null },
    };
  },
});
