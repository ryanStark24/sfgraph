import { render } from "@ryanstark24/sfgraph-core";
import { REL_TYPES } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  object: z.string().min(1),
  field: z.string().min(1),
});

defineTool({
  name: "analyze_field",
  description: "Show readers, writers, and security grants for a CustomField.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(`CustomField:${input.object}.${input.field}`);
    const node = ctx.graphStore.getNode(ctx.orgId, qname);
    if (!node) {
      return {
        summary: "field not found",
        markdown: `> no node \`${qname}\``,
        data: { found: false },
      };
    }
    const readers = ctx.graphStore.listEdgesTo(ctx.orgId, qname, REL_TYPES.READS_FIELD);
    const writers = ctx.graphStore.listEdgesTo(ctx.orgId, qname, REL_TYPES.WRITES_FIELD);
    const grants = ctx.graphStore.listEdgesTo(ctx.orgId, qname, REL_TYPES.GRANTS_FIELD_ACCESS);
    const allEdges = [...readers, ...writers, ...grants];
    const nodeSet = new Map<string, { qualifiedName: string; label: string }>();
    nodeSet.set(qname, { qualifiedName: qname, label: "CustomField" });
    for (const e of allEdges) {
      const src = ctx.graphStore.getNode(ctx.orgId, e.srcQualifiedName);
      nodeSet.set(e.srcQualifiedName, {
        qualifiedName: e.srcQualifiedName,
        label: src?.label ?? "Unknown",
      });
    }
    const mermaid = render.renderDependencyGraph({
      nodes: Array.from(nodeSet.values()),
      edges: allEdges.map((e) => ({
        srcQualifiedName: e.srcQualifiedName,
        dstQualifiedName: e.dstQualifiedName,
        relType: e.relType,
      })),
      title: `field ${qname}`,
    });
    const md = [
      `**${qname}** — readers ${readers.length} · writers ${writers.length} · grants ${grants.length}`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    return {
      summary: `${readers.length} readers / ${writers.length} writers`,
      markdown: md,
      data: {
        readers: readers.map((e) => e.srcQualifiedName),
        writers: writers.map((e) => e.srcQualifiedName),
        grants: grants.map((e) => e.srcQualifiedName),
      },
    };
  },
});
