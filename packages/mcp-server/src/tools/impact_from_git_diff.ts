import { analyze, render } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  diff: z.string().min(1),
  depth: z.number().int().min(1).max(5).default(3),
});

defineTool({
  name: "impact_from_git_diff",
  description: "Compute impact (forward+reverse) of metadata changed in a unified git diff.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const files = analyze.parseUnifiedDiff(input.diff);
    const seedQnames: string[] = [];
    for (const f of files) {
      const qn = analyze.pathToQualifiedName(f.path);
      if (qn) seedQnames.push(qn);
    }
    const nodeMap = new Map<string, { qualifiedName: string; label: string }>();
    const edges: Array<{ srcQualifiedName: string; dstQualifiedName: string; relType?: string }> =
      [];
    for (const qn of seedQnames) {
      const qname = asQualifiedName(qn);
      const node = ctx.graphStore.getNode(ctx.orgId, qname);
      nodeMap.set(qn, { qualifiedName: qn, label: node?.label ?? "Changed" });
      const up = analyze.findDependents(ctx.graphStore, ctx.orgId, qname, input.depth);
      const down = analyze.findDependencies(ctx.graphStore, ctx.orgId, qname, input.depth);
      for (const n of [...up.nodes, ...down.nodes]) {
        nodeMap.set(n.qualifiedName, { qualifiedName: n.qualifiedName, label: n.label });
      }
      for (const e of [...up.edges, ...down.edges]) {
        edges.push({
          srcQualifiedName: e.srcQualifiedName,
          dstQualifiedName: e.dstQualifiedName,
          relType: e.relType,
        });
      }
    }
    const mermaid = render.renderDependencyGraph({
      nodes: Array.from(nodeMap.values()),
      edges,
      title: "impact_from_git_diff",
    });
    const md = [
      `Seed: ${seedQnames.length} files. Total impacted: ${nodeMap.size}.`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    return {
      summary: `${nodeMap.size} nodes impacted from ${seedQnames.length} changed files`,
      markdown: md,
      data: { seedQnames, impacted: Array.from(nodeMap.keys()) },
    };
  },
});
