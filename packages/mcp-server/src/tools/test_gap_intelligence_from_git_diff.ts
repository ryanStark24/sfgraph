import { analyze } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  diff: z.string().min(1),
});

defineTool({
  name: "test_gap_intelligence_from_git_diff",
  description: "List dependents of a git diff that have no test coverage.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const files = analyze.parseUnifiedDiff(input.diff);
    const seedQnames: string[] = [];
    for (const f of files) {
      const qn = analyze.pathToQualifiedName(f.path);
      if (qn) seedQnames.push(qn);
    }
    const gaps: string[] = [];
    const covered: string[] = [];
    const seen = new Set<string>();
    for (const qn of seedQnames) {
      const dep = analyze.findDependents(ctx.graphStore, ctx.orgId, asQualifiedName(qn), 3);
      for (const n of dep.nodes) {
        if (seen.has(n.qualifiedName)) continue;
        seen.add(n.qualifiedName);
        const hasTest = analyze.hasTestCoverage(
          ctx.graphStore,
          ctx.orgId,
          asQualifiedName(n.qualifiedName),
        );
        if (hasTest) covered.push(n.qualifiedName);
        else gaps.push(n.qualifiedName);
      }
    }
    const md = [
      `**Test gaps:** ${gaps.length}`,
      "",
      ...gaps.slice(0, 50).map((g) => `- \`${g}\``),
    ].join("\n");
    return {
      summary: `${gaps.length} dependents lack tests`,
      markdown: md,
      data: { gaps, covered },
      follow_up_tools: ["impact_from_git_diff"],
    };
  },
});
