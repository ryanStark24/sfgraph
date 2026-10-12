import { analyze } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { findNodesSuggestion, notFoundReport } from "./_not-found.js";
import { renderReachList, shapeTrace, traceReport } from "./_reach_list.js";
import { nameOf } from "./_report.js";

const inputSchema = z.object({
  org: z.string().min(1),
  qname: z.string().min(1),
  depth: numeric(z.number().int().min(1).max(5).default(3)),
  /** Include Profile/PermissionSet/SharingRule GRANTS_* edges. Off by default
   *  — on a real org a class is granted to 100+ profiles, which buries the
   *  actual callers. Turn on for an access-centric view. */
  include_security: z.boolean().default(false),
  /** Include low-confidence reflection-walker REFERENCES edges (string-name
   *  matches). Off by default — they produce spurious links like
   *  DataRaptor:Foo → CustomApplication:DataRaptor. */
  include_inferred: z.boolean().default(false),
  /** Expand an object reached from its own field / validation rule / record
   *  type into everything that uses the object. Off by default — the object
   *  is listed as a leaf (containment is not a dependency). */
  include_structure: z.boolean().default(false),
  /** Restrict to these relationship types (e.g. ["CALLS","IS_TEST_FOR"]). */
  rel_types: z.array(z.string()).optional(),
  /** Only list entries with these labels (traversal is unchanged). */
  labels: z.array(z.string()).optional(),
  /** Show the Picture (a diagram of at most 25 components); false hides it. */
  mermaid: z.boolean().default(true),
});

defineTool({
  name: "trace_upstream",
  description:
    "Use for 'what depends on / calls X'. Lists what reaches `qname`, `depth` hops back, with each link. Unknown qname: 'node not found'.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(input.qname);
    const r = analyze.findDependents(ctx.graphStore, ctx.orgId, qname, input.depth, {
      excludeSecurity: !input.include_security,
      excludeReflection: !input.include_inferred,
      leafStructure: !input.include_structure,
      ...(input.rel_types?.length ? { includeRelTypes: new Set(input.rel_types) } : {}),
    });
    if (r.found === false) {
      return {
        summary: `node not found: ${input.qname}`,
        markdown: notFoundReport({
          title: `No component named ${nameOf(input.qname)}`,
          names: [input.qname],
          what: "so nothing could be traced",
          details: [
            `**Node not found:** \`${input.qname}\` is not a node or edge endpoint in this org's graph, so there is nothing upstream of it.`,
            "",
            findNodesSuggestion([input.qname]),
          ].join("\n"),
        }),
        data: {
          found: false,
          qname: input.qname,
          nodes: [],
          edges: [],
          reached: [],
          truncated: false,
        },
        follow_up_tools: ["find_nodes"],
      };
    }
    // The root is not a reached row, so name it for the Remote:<root>
    // duplicate check (review M2); a user class named like a platform
    // namespace is not platform Apex (review M1).
    const { reached, pseudo, counted } = shapeTrace(r.reached ?? [], {
      alsoPresent: [String(qname)],
      hasClass: analyze.apexTypeExists(ctx.graphStore, ctx.orgId),
    });
    const truncated = r.truncated === true;
    const mdLines = [
      renderReachList({
        direction: "upstream",
        target: input.qname,
        depth: input.depth,
        reached,
        pseudo,
        ...(input.labels?.length ? { labels: input.labels } : {}),
      }),
    ];
    if (r.structural && r.structural > 0) {
      mdLines.push(
        "",
        `_${r.structural} containing object${r.structural === 1 ? "" : "s"} listed as leaves_ — pass \`include_structure: true\` to expand them into everything that uses them.`,
      );
    }
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
      summary: `${counted} upstream nodes${truncated ? " (truncated)" : ""}${r.filtered ? `, ${r.filtered} hidden` : ""}`,
      markdown: traceReport({
        direction: "upstream",
        target: input.qname,
        depth: input.depth,
        reached,
        pseudo,
        edges: r.rowEdges ?? r.edges,
        truncated,
        filtered: r.filtered ?? 0,
        structural: r.structural ?? 0,
        labels: input.labels,
        mermaid: input.mermaid,
        details: mdLines.join("\n"),
      }),
      data: {
        found: true,
        nodes: r.nodes,
        edges: r.edges,
        reached,
        pseudo,
        truncated,
        filtered: r.filtered ?? 0,
        structural: r.structural ?? 0,
      },
      follow_up_tools: ["analyze_field", "explain_code", "find_similar", "deployment_manifest_gen"],
    };
  },
});
