import { analyze, render } from "@ryanstark24/sfgraph-core";
import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org_a: z.string().min(1),
  org_b: z.string().min(1),
  category: z.string().default("all"),
});

defineTool({
  name: "cross_org_diff",
  description:
    "USE THIS for any 'what is different between prod and sandbox' / 'compare two orgs' / 'org drift' question. Set difference of metadata between two ingested Salesforce orgs by category. Returns onlyInA / onlyInB / changed lists.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org_a });
    const diff = analyze.diffOrgs(
      ctx.graphStore,
      asOrgId(input.org_a),
      asOrgId(input.org_b),
      input.category,
    );
    const mermaid = render.renderDiff({
      added: diff.onlyInB.slice(0, 30).map((n) => ({ qualifiedName: n.qualifiedName })),
      removed: diff.onlyInA.slice(0, 30).map((n) => ({ qualifiedName: n.qualifiedName })),
      changed: diff.changed.slice(0, 30).map((c) => ({ qualifiedName: c.a.qualifiedName })),
    });
    const md = [
      "| metric | count |",
      "|---|---|",
      `| only in A | ${diff.onlyInA.length} |`,
      `| only in B | ${diff.onlyInB.length} |`,
      `| changed | ${diff.changed.length} |`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    return {
      summary: `A-only:${diff.onlyInA.length} B-only:${diff.onlyInB.length} changed:${diff.changed.length}`,
      markdown: md,
      data: {
        onlyInA: diff.onlyInA.map((n) => n.qualifiedName),
        onlyInB: diff.onlyInB.map((n) => n.qualifiedName),
        changed: diff.changed.map((c) => c.a.qualifiedName),
      },
    };
  },
});
