import { analyze } from "@sfgraph/core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({ org: z.string().min(1) });

defineTool({
  name: "security_audit",
  description: "Security posture: full-access sharing rules, FLS gaps, field access matrix.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const audit = analyze.securityAudit(ctx.graphStore, ctx.orgId);
    const md = [
      `**Full-access sharing rules:** ${audit.sharingFullAccess.length}`,
      ...audit.sharingFullAccess.slice(0, 20).map((q) => `- \`${q}\``),
      "",
      `**FLS gaps (fields with no permission-set grant):** ${audit.flsGaps.length}`,
      ...audit.flsGaps.slice(0, 20).map((q) => `- \`${q}\``),
    ].join("\n");
    return {
      summary: `${audit.flsGaps.length} FLS gaps, ${audit.sharingFullAccess.length} full-access rules`,
      markdown: md,
      data: audit,
    };
  },
});
