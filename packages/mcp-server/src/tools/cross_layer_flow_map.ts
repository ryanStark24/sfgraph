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
  description:
    "USE THIS for any 'how does X flow from UI to DB' / 'trace this LWC end-to-end' / 'show the full path from accountTile to the database' question about a Salesforce entry point (LWC bundle, ApexPage, Flow). Returns the layered LWC -> Apex -> SOQL -> CustomField sequence + Mermaid sequenceDiagram.",
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
    // Per-node visit cap, not per-edge step cap. Previously `steps < 50`
    // counted every edge traversed across the BFS, so any moderately-fanned
    // LWC -> Apex chain (30 fields + 25 SOQL reads) would silently truncate
    // mid-tree. Capping visited *nodes* gives predictable depth and lets us
    // emit an explicit "_truncated_" marker the user can act on.
    const NODE_CAP = 100;
    let truncated = false;
    bfs: while (queue.length > 0) {
      if (visited.size >= NODE_CAP) {
        truncated = true;
        break;
      }
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
            if (visited.size >= NODE_CAP) {
              truncated = true;
              break bfs;
            }
          }
        }
      }
    }
    const mermaid = render.renderSequence({
      participants: Array.from(participants.values()) as never,
      messages,
    });
    const mdLines = ["```mermaid", mermaid, "```"];
    if (truncated) {
      mdLines.push(
        "",
        `_truncated_ — BFS hit the ${NODE_CAP}-node ceiling; deeper paths from this entry were not explored.`,
      );
    }
    const md = mdLines.join("\n");
    return {
      summary: `${participants.size} participants across layers${truncated ? " (truncated)" : ""}`,
      markdown: md,
      data: { participants: Array.from(participants.values()), messages, truncated },
    };
  },
});
