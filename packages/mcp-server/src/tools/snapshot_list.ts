import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { countNoun, withInShort } from "./_report.js";

const inputSchema = z.object({ org: z.string().min(1) });

defineTool({
  name: "snapshot_list",
  description: "List an org's 20 most recent snapshots.",
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
      markdown: withInShort(
        snaps.length === 0
          ? `Org \`${ctx.orgId}\` has no snapshots yet; save one with \`snapshot_create\`.`
          : `Org \`${ctx.orgId}\` has ${countNoun(snaps.length, "snapshot")}${snaps.length === 20 ? " listed (the 20 most recent; there may be more)" : ""}.`,
        snaps.length === 0 ? "_no snapshots_" : md,
      ),
      data: snaps,
      follow_up_tools: ["point_in_time_diff", "snapshot_create"],
    };
  },
});
