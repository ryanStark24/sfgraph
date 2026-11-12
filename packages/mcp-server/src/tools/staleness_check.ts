import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { countNoun, withInShort } from "./_report.js";

const inputSchema = z.object({ org: z.string().min(1) });

const DAY_MS = 1000 * 60 * 60 * 24;
const STALE_THRESHOLD_DAYS = 7;

defineTool({
  name: "staleness_check",
  description:
    "Use for 'is the graph fresh'. Returns days since the org's last sync, a stale flag (7+ days) and the refresh command.",
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
    // Latest ingest coverage report (per metadata type: name-only / generic
    // edges / rule-parsed), when the last ingest stored one.
    let coverage: unknown;
    try {
      const raw = ctx.graphStore.getCoverageReport?.(ctx.orgId);
      if (raw) coverage = JSON.parse(raw);
    } catch {
      // no report, or an older / unreadable one: leave it out
    }
    const now = Date.now();
    const ageDays = lastSyncedAt != null ? Math.floor((now - lastSyncedAt) / DAY_MS) : null;
    const stale = ageDays == null || ageDays >= STALE_THRESHOLD_DAYS;
    const recommendation = stale
      ? `ingest is ${ageDays == null ? "missing" : `${ageDays} days old`} — run \`sfgraph ingest --org ${input.org}\` to refresh before relying on this analysis`
      : `ingest is ${ageDays} day${ageDays === 1 ? "" : "s"} old — fresh enough to use`;
    const cov = coverage as
      | {
          totals?: { nameOnly?: number; withGenericEdges?: number; ruleParsed?: number };
          unknownTypes?: string[];
        }
      | undefined;
    const coverageNote =
      cov?.unknownTypes && cov.unknownTypes.length > 0
        ? `\n\nCoverage: ${cov.totals?.ruleParsed ?? 0} members rule-parsed, ${cov.totals?.withGenericEdges ?? 0} with heuristic edges, ${cov.totals?.nameOnly ?? 0} name-only. Types with names only: ${cov.unknownTypes.slice(0, 10).join(", ")}${cov.unknownTypes.length > 10 ? ", ..." : ""}.`
        : "";
    const summary = stale ? `STALE: ${recommendation}` : `fresh: ${recommendation}`;
    const md = [
      "| org | last synced | age (days) | stale | recommendation |",
      "|---|---|---|---|---|",
      `| \`${input.org}\` | ${lastSyncedAt != null ? new Date(lastSyncedAt).toISOString() : "_never_"} | ${ageDays ?? "-"} | ${stale ? "yes" : "no"} | ${recommendation} |`,
    ].join("\n");
    return {
      summary,
      markdown: withInShort(
        ageDays == null
          ? `The graph for \`${input.org}\` has no record of ever being loaded, so answers about it may be missing or out of date; load it before relying on it.`
          : `The graph for \`${input.org}\` was last loaded ${ageDays === 0 ? "today" : `${countNoun(ageDays, "day")} ago`}${
              stale
                ? ", so it may be out of date; reload it before relying on it."
                : ", so it is recent enough to use."
            }`,
        `${md}${coverageNote}`,
      ),
      data: {
        org: input.org,
        lastSyncedAt,
        ageDays,
        stale,
        recommendation,
        ...(coverage ? { coverage } : {}),
      },
      follow_up_tools: ["freshness_report", "start_ingest_job"],
    };
  },
});
