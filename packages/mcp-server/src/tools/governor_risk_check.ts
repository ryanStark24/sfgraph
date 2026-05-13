import { analyze } from "@sfgraph/core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({ org: z.string().min(1) });

defineTool({
  name: "governor_risk_check",
  description: "List Apex with detected governor-limit risks (SOQL/DML in loop).",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const risks = analyze.findGovernorRisks(ctx.graphStore, ctx.orgId);
    if (risks.length === 0) {
      return {
        summary: "no risks detected",
        markdown:
          "_no governor risks surfaced. Note: detection relies on parser-emitted attributes; deeper static analysis is a Phase 6 deliverable._",
        data: { risks: [] },
      };
    }
    const md = [
      "| qname | risk | evidence |",
      "|---|---|---|",
      ...risks.map((r) => `| \`${r.qualifiedName}\` | ${r.risk} | ${r.evidence} |`),
    ].join("\n");
    return {
      summary: `${risks.length} governor risks`,
      markdown: md,
      data: { risks },
    };
  },
});
