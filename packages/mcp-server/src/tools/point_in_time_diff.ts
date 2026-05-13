import { render } from "@sfgraph/core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  from: z.string().min(1),
  to: z.union([z.string().min(1), z.literal("current")]).default("current"),
});

defineTool({
  name: "point_in_time_diff",
  description: "Diff org graph between two snapshots (or snapshot vs current).",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const nodeDiff = ctx.snapshotStore.diffNodes(ctx.orgId, input.from, input.to);
    const edgeDiff = ctx.snapshotStore.diffEdges(ctx.orgId, input.from, input.to);
    const mermaid = render.renderDiff({
      added: nodeDiff.added.map((n) => ({ qualifiedName: n.qualifiedName })),
      removed: nodeDiff.removed.map((n) => ({ qualifiedName: n.qualifiedName })),
      changed: nodeDiff.changed.map((c) => ({ qualifiedName: c.after.qualifiedName })),
    });
    const md = [
      `**Nodes** — +${nodeDiff.added.length} / -${nodeDiff.removed.length} / ~${nodeDiff.changed.length}`,
      `**Edges** — +${edgeDiff.added.length} / -${edgeDiff.removed.length}`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    return {
      summary: `diff: +${nodeDiff.added.length} ~${nodeDiff.changed.length} -${nodeDiff.removed.length}`,
      markdown: md,
      data: { nodeDiff, edgeDiff },
    };
  },
});
