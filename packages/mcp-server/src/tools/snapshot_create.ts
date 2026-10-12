import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { withInShort } from "./_report.js";

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
    // Honour the caller's `kind`: "scheduled" → auto snapshot, "manual" → not.
    // (Was hardcoded `false`, silently discarding the argument.)
    const snap = ctx.snapshotStore.createSnapshot(ctx.orgId, label, input.kind === "scheduled");
    return {
      summary: `snapshot ${snap.id} created`,
      markdown: withInShort(
        `Saved snapshot \`${snap.id}\` of org \`${ctx.orgId}\`, named "${label}"; compare against it later with \`point_in_time_diff\`.`,
        `Snapshot \`${snap.id}\` (\"${label}\") created for org \`${ctx.orgId}\`.`,
      ),
      data: snap,
      follow_up_tools: ["snapshot_list", "point_in_time_diff"],
    };
  },
});
