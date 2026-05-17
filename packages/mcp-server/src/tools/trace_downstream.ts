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
  name: "trace_downstream",
  description:
    "USE THIS for any 'what does X depend on' / 'show dependencies' / 'what does this method call' question about a Salesforce metadata node (ApexClass, LWC, Flow, CustomField, etc.). Forward-edge graph N hops out.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(input.qname);
    const r = analyze.findDependencies(ctx.graphStore, ctx.orgId, qname, input.depth);
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
      title: "downstream",
    });
    const truncated = r.truncated === true;
    const mdLines = ["```mermaid", mermaid, "```"];
    if (truncated) {
      mdLines.push(
        "",
        "_truncated_ — traversal hit the node cap; deeper downstream paths were not explored. Lower `depth` or pick a narrower `qname`.",
      );
    }
    return {
      summary: `${r.nodes.length} downstream nodes${truncated ? " (truncated)" : ""}`,
      markdown: mdLines.join("\n"),
      data: { nodes: r.nodes, edges: r.edges, truncated },
      follow_up_tools: ["analyze_field", "explain_code", "find_similar", "deployment_manifest_gen"],
    };
  },
});
