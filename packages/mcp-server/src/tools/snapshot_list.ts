import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({ org: z.string().min(1) });

defineTool({
  name: "snapshot_list",
  description: "List up to 20 most recent snapshots for an org.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const snaps = ctx.snapshotStore.listSnapshots(ctx.orgId).slice(0, 20);
    const rows = snaps
      .map(
        (s) =>
          `| \`${s.id}\` | ${s.label} | ${new Date(s.createdAt).toISOString()} | ${s.isAuto ? "auto" : "manual"} |`,
      )
      .join("\n");
    const md = `| id | label | createdAt | kind |\n|---|---|---|---|\n${rows}`;
    return {
      summary: `${snaps.length} snapshots`,
      markdown: snaps.length === 0 ? "_no snapshots_" : md,
      data: snaps,
      follow_up_tools: ["point_in_time_diff", "snapshot_create"],
    };
  },
});
