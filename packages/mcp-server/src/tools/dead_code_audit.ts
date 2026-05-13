import { analyze } from "@sfgraph/core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({ org: z.string().min(1) });

defineTool({
  name: "dead_code_audit",
  description: "Find low-freshness metadata with zero incoming edges.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const dead = analyze.findDeadCode(ctx.graphStore, ctx.orgId);
    const md = dead.length
      ? [
          "| qname | label |",
          "|---|---|",
          ...dead.map((d) => `| \`${d.qualifiedName}\` | ${d.label} |`),
        ].join("\n")
      : "_no dead code detected_";
    return {
      summary: `${dead.length} dead-code candidates`,
      markdown: md,
      data: { dead: dead.map((d) => d.qualifiedName) },
    };
  },
});
