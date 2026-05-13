import { analyze, render } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  qname: z.string().min(1),
  depth: z.number().int().min(1).max(5).default(3),
});

defineTool({
  name: "trace_upstream",
  description: "Reverse BFS to find what depends on this node.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(input.qname);
    const r = analyze.findDependents(ctx.graphStore, ctx.orgId, qname, input.depth);
    const nodes = [
      { qualifiedName: qname, label: "Target" },
      ...r.nodes.map((n) => ({ qualifiedName: n.qualifiedName, label: n.label })),
    ];
    const mermaid = render.renderDependencyGraph({
      nodes,
      edges: r.edges.map((e) => ({
        srcQualifiedName: e.srcQualifiedName,
        dstQualifiedName: e.dstQualifiedName,
        relType: e.relType,
      })),
      title: "upstream",
    });
    return {
      summary: `${r.nodes.length} upstream nodes`,
      markdown: ["```mermaid", mermaid, "```"].join("\n"),
      data: { nodes: r.nodes, edges: r.edges },
    };
  },
});
