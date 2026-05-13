import { render } from "@ryanstark24/sfgraph-core";
import { REL_TYPES } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { QualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  entry: z.string().min(1),
});

const REL_PRIORITY = [
  REL_TYPES.CALLS_APEX_FROM_LWC,
  REL_TYPES.CALLS,
  REL_TYPES.EXECUTES_SOQL,
  REL_TYPES.READS_FIELD,
];

function layerFor(label: string): string {
  if (label === "LWC" || label === "LightningComponentBundle") return "LWC";
  if (label.startsWith("Apex")) return "Apex";
  if (label === "CustomField") return "Field";
  if (label === "CustomObject") return "SOQL";
  return label;
}

defineTool({
  name: "cross_layer_flow_map",
  description: "Trace a request across LWC → Apex → SOQL → Field layers.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const entry = asQualifiedName(input.entry);
    const participants = new Map<string, { id: string; label: string; layer: string }>();
    const messages: Array<{ fromId: string; toId: string; label: string }> = [];
    const visited = new Set<string>();
    const queue: QualifiedName[] = [entry];
    visited.add(entry);
    const entryNode = ctx.graphStore.getNode(ctx.orgId, entry);
    if (entryNode) {
      participants.set(entry, {
        id: entry,
        label: entry,
        layer: layerFor(entryNode.label),
      });
    } else {
      participants.set(entry, { id: entry, label: entry, layer: "Entry" });
    }
    let steps = 0;
    while (queue.length > 0 && steps < 50) {
      const cur = queue.shift();
      if (!cur) break;
      for (const rt of REL_PRIORITY) {
        const out = ctx.graphStore.listEdgesFrom(ctx.orgId, cur, rt);
        for (const e of out) {
          const dstNode = ctx.graphStore.getNode(ctx.orgId, e.dstQualifiedName);
          if (!participants.has(e.dstQualifiedName)) {
            participants.set(e.dstQualifiedName, {
              id: e.dstQualifiedName,
              label: e.dstQualifiedName,
              layer: layerFor(dstNode?.label ?? "Unknown"),
            });
          }
          messages.push({ fromId: cur, toId: e.dstQualifiedName, label: rt });
          if (!visited.has(e.dstQualifiedName)) {
            visited.add(e.dstQualifiedName);
            queue.push(e.dstQualifiedName);
          }
          steps++;
        }
      }
    }
    const mermaid = render.renderSequence({
      participants: Array.from(participants.values()) as never,
      messages,
    });
    const md = ["```mermaid", mermaid, "```"].join("\n");
    return {
      summary: `${participants.size} participants across layers`,
      markdown: md,
      data: { participants: Array.from(participants.values()), messages },
    };
  },
});
