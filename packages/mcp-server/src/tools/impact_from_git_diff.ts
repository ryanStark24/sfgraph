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
  description:
    "USE THIS for any 'what does this PR break' / 'impact of these changes' / 'blast radius before merge' question about a Salesforce repo. Maps changed file paths to graph nodes via N-hop reverse BFS. Returns every Apex / LWC / Flow / field that depends on the changes.",
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
    let truncated = false;
    for (const qn of seedQnames) {
      const qname = asQualifiedName(qn);
      const node = ctx.graphStore.getNode(ctx.orgId, qname);
      nodeMap.set(qn, { qualifiedName: qn, label: node?.label ?? "Changed" });
      const up = analyze.findDependents(ctx.graphStore, ctx.orgId, qname, input.depth);
      const down = analyze.findDependencies(ctx.graphStore, ctx.orgId, qname, input.depth);
      if (up.truncated || down.truncated) truncated = true;
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
    const mdLines = [
      `Seed: ${seedQnames.length} files. Total impacted: ${nodeMap.size}.`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ];
    if (truncated) {
      mdLines.push(
        "",
        "_truncated_ — one or more seeds hit the traversal node cap. Lower `depth` or split the diff.",
      );
    }
    return {
      summary: `${nodeMap.size} nodes impacted from ${seedQnames.length} changed files${truncated ? " (truncated)" : ""}`,
      markdown: mdLines.join("\n"),
      data: { seedQnames, impacted: Array.from(nodeMap.keys()), truncated },
      follow_up_tools: [
        "test_gap_intelligence_from_git_diff",
        "trace_downstream",
        "deployment_manifest_gen",
      ],
    };
  },
});
