import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  name: z.string().optional(),
  kind: z.enum(["manual", "scheduled"]).default("manual"),
});

defineTool({
  name: "snapshot_create",
  description: "Create a graph snapshot for an org.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const label = input.name ?? `${input.kind}-${new Date().toISOString()}`;
    const snap = ctx.snapshotStore.createSnapshot(ctx.orgId, label, false);
    return {
      summary: `snapshot ${snap.id} created`,
      markdown: `Snapshot \`${snap.id}\` (\"${label}\") created for org \`${ctx.orgId}\`.`,
      data: snap,
      follow_up_tools: ["snapshot_list", "point_in_time_diff"],
    };
  },
});
