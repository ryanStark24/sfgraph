import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({ org: z.string().min(1) });

const DAY_MS = 1000 * 60 * 60 * 24;
const STALE_THRESHOLD_DAYS = 7;

defineTool({
  name: "staleness_check",
  description:
    "Check how old the local sfgraph ingest is for an org. Returns stale=true when last sync is >=7 days old.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    let lastSyncedAt: number | null = null;
    try {
      const db = (
        ctx.graphStore as unknown as {
          db: { prepare: (s: string) => { get: (a: string) => unknown } };
        }
      ).db;
      const row = db
        .prepare("SELECT last_synced_at FROM _sfgraph_orgs WHERE id = ?")
        .get(ctx.orgId) as { last_synced_at: number | null } | undefined;
      if (row && row.last_synced_at != null) {
        lastSyncedAt = Number(row.last_synced_at);
      }
    } catch {
      // table missing or no row — treat as never synced
    }
    const now = Date.now();
    const ageDays = lastSyncedAt != null ? Math.floor((now - lastSyncedAt) / DAY_MS) : null;
    const stale = ageDays == null || ageDays >= STALE_THRESHOLD_DAYS;
    const recommendation = stale
      ? `ingest is ${ageDays == null ? "missing" : `${ageDays} days old`} — run \`sfgraph ingest --org ${input.org}\` to refresh before relying on this analysis`
      : `ingest is ${ageDays} day${ageDays === 1 ? "" : "s"} old — fresh enough to use`;
    const summary = stale ? `STALE: ${recommendation}` : `fresh: ${recommendation}`;
    const md = [
      "| org | last synced | age (days) | stale | recommendation |",
      "|---|---|---|---|---|",
      `| \`${input.org}\` | ${lastSyncedAt != null ? new Date(lastSyncedAt).toISOString() : "_never_"} | ${ageDays ?? "-"} | ${stale ? "yes" : "no"} | ${recommendation} |`,
    ].join("\n");
    return {
      summary,
      markdown: md,
      data: {
        org: input.org,
        lastSyncedAt,
        ageDays,
        stale,
        recommendation,
      },
    };
  },
});
