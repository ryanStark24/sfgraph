import { analyze, render } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  qname: z.string().min(1),
  depth: z.number().int().min(1).max(5).default(3),
  /** Include Profile/PermissionSet/SharingRule GRANTS_* edges. Off by default
   *  — on a real org a class is granted to 100+ profiles, which buries the
   *  actual callers. Turn on for an access-centric view. */
  include_security: z.boolean().default(false),
  /** Include low-confidence reflection-walker REFERENCES edges (string-name
   *  matches). Off by default — they produce spurious links like
   *  DataRaptor:Foo → CustomApplication:DataRaptor. */
  include_inferred: z.boolean().default(false),
  /** Restrict to these relationship types (e.g. ["CALLS","IS_TEST_FOR"]). */
  rel_types: z.array(z.string()).optional(),
});

defineTool({
  name: "trace_upstream",
  description:
    "USE THIS for any 'what depends on X' / 'who uses this' / 'find callers of' / 'who references this method' question about a Salesforce metadata node. Returns every node that depends on the target, N hops back. Security grants and inferred references are hidden by default (pass include_security / include_inferred to show them).",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(input.qname);
    const r = analyze.findDependents(ctx.graphStore, ctx.orgId, qname, input.depth, {
      excludeSecurity: !input.include_security,
      excludeReflection: !input.include_inferred,
      ...(input.rel_types?.length ? { includeRelTypes: new Set(input.rel_types) } : {}),
    });
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
    const truncated = r.truncated === true;
    const mdLines = ["```mermaid", mermaid, "```"];
    if (r.filtered && r.filtered > 0) {
      mdLines.push(
        "",
        `_${r.filtered} security/inferred edge${r.filtered === 1 ? "" : "s"} hidden_ — pass \`include_security: true\` and/or \`include_inferred: true\` to show them.`,
      );
    }
    if (truncated) {
      mdLines.push(
        "",
        "_truncated_ — traversal hit the node cap; deeper upstream paths were not explored. Lower `depth` or pick a narrower `qname`.",
      );
    }
    return {
      summary: `${r.nodes.length} upstream nodes${truncated ? " (truncated)" : ""}${r.filtered ? `, ${r.filtered} hidden` : ""}`,
      markdown: mdLines.join("\n"),
      data: { nodes: r.nodes, edges: r.edges, truncated, filtered: r.filtered ?? 0 },
      follow_up_tools: ["analyze_field", "explain_code", "find_similar", "deployment_manifest_gen"],
    };
  },
});
