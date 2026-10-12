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
  /** Include security GRANTS_* edges (off by default — access view, not deps). */
  include_security: z.boolean().default(false),
  /** Include low-confidence reflection-walker REFERENCES edges (off by default). */
  include_inferred: z.boolean().default(false),
  /** Expand reached objects/fields along containment edges (DEFINES_FIELD,
   *  HAS_VALIDATION_RULE, HAS_RECORD_TYPE, field -> field formula
   *  READS_FIELD). Off by default — objects and fields are leaves. */
  include_structure: z.boolean().default(false),
  /** Restrict to these relationship types. */
  rel_types: z.array(z.string()).optional(),
  /** Only list entries with these labels (traversal is unchanged). */
  labels: z.array(z.string()).optional(),
  /** Show the Picture (a diagram of at most 25 components); false hides it. */
  mermaid: z.boolean().default(true),
});

defineTool({
  name: "trace_downstream",
  description:
    "Use for 'what does X depend on / call'. Lists what `qname` reaches, `depth` hops out, with each link. Unknown qname: 'node not found'.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(input.qname);
    const r = analyze.findDependencies(ctx.graphStore, ctx.orgId, qname, input.depth, {
      excludeSecurity: !input.include_security,
      excludeReflection: !input.include_inferred,
      leafStructure: !input.include_structure,
      rollupApexClass: true,
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
            `**Node not found:** \`${input.qname}\` is not a node or edge endpoint in this org's graph, so there is nothing downstream of it.`,
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
      isManagedNamespace: analyze.managedNamespaceCheck(ctx.graphStore, ctx.orgId),
      markStandardFields: true,
    });
    const truncated = r.truncated === true;
    const mdLines = [
      renderReachList({
        direction: "downstream",
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
        `_${r.structural} containment edge${r.structural === 1 ? "" : "s"} not expanded_ (objects and fields are leaves) — pass \`include_structure: true\` to expand objects into their fields, validation rules and record types.`,
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
        "_truncated_ — traversal hit the node cap; deeper downstream paths were not explored. Lower `depth` or pick a narrower `qname`.",
      );
    }
    return {
      summary: `${counted} downstream nodes${truncated ? " (truncated)" : ""}${r.filtered ? `, ${r.filtered} hidden` : ""}`,
      markdown: traceReport({
        direction: "downstream",
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
