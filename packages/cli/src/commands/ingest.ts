import path from "node:path";
import {
  SqliteGraphStore,
  SqliteSnapshotStore,
  listAllAuthenticatedOrgs,
  liveIngest,
  multiOrgIngest,
} from "@ryanstark24/sfgraph-core";
import type { LiveIngestOpts, MultiOrgIngestEntry } from "@ryanstark24/sfgraph-core";
import { ConsoleLogger, SfgraphError, getSfgraphPaths } from "@ryanstark24/sfgraph-shared";

export interface IngestOpts {
  org?: string | undefined;
  orgs?: string | undefined;
  all?: boolean | undefined;
  parallel?: boolean | undefined;
  mode?: "full" | "incremental" | "auto" | undefined;
  db?: string | undefined;
  embedModel?: string | undefined;
  embedModelId?: string | undefined;
  embedModelDim?: number | undefined;
}

function formatRow(cols: string[], widths: number[]): string {
  return cols.map((c, i) => c.padEnd(widths[i] ?? c.length)).join("  ");
}

function printResultsTable(entries: MultiOrgIngestEntry[], mode: string): void {
  const header = ["Org", "Mode", "Members", "Deletions", "ParseErrors", "Elapsed(ms)", "Status"];
  const rows = entries.map((e) => [
    e.alias,
    e.result?.mode ?? mode,
    String(e.result?.membersProcessed ?? "-"),
    String(e.result?.deletions ?? "-"),
    String(e.result?.parseErrors ?? "-"),
    String(e.finishedAt - e.startedAt),
    e.status === "ok" ? "OK" : `ERR: ${e.error ?? ""}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  console.log(formatRow(header, widths));
  console.log(
    formatRow(
      widths.map((w) => "-".repeat(w)),
      widths,
    ),
  );
  for (const r of rows) console.log(formatRow(r, widths));
}

async function buildSingleIngestOpts(
  alias: string,
  opts: IngestOpts,
  logger: ConsoleLogger,
  deps: { resolveOrg: typeof import("@ryanstark24/sfgraph-core").resolveOrg },
): Promise<LiveIngestOpts> {
  const resolved = await deps.resolveOrg(alias);
  const dbPath = opts.db ?? path.join(getSfgraphPaths().data, `${resolved.orgId}.sqlite`);

  const graphStore = new SqliteGraphStore({ dbPath });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: graphStore.db,
    skipMigrations: true,
  });
  await snapshotStore.init();

  return {
    alias,
    mode: opts.mode ?? "auto",
    graphStore,
    snapshotStore,
    logger,
    preResolved: resolved,
  };
}

export async function ingestCmd(opts: IngestOpts): Promise<void> {
  const logger = new ConsoleLogger("info");
  if (opts.embedModel) process.env.SFGRAPH_EMBED_MODEL_PATH = opts.embedModel;
  if (opts.embedModelId) process.env.SFGRAPH_EMBED_MODEL_ID = opts.embedModelId;
  if (opts.embedModelDim !== undefined) {
    process.env.SFGRAPH_EMBED_MODEL_DIM = String(opts.embedModelDim);
  }
  try {
    const { resolveOrg, resolveDefaultOrgAlias } = await import("@ryanstark24/sfgraph-core");

    // Determine the alias list (multi-org modes).
    let aliases: string[] | null = null;
    if (opts.all) {
      try {
        aliases = await listAllAuthenticatedOrgs();
      } catch (e) {
        console.error(
          `ingest --all: failed to enumerate authenticated orgs: ${(e as Error).message}`,
        );
        process.exitCode = 1;
        return;
      }
      if (aliases.length === 0) {
        console.error("ingest --all: no authenticated orgs found. Run `sf org login web` first.");
        process.exitCode = 1;
        return;
      }
      logger.info(`ingest --all: discovered ${aliases.length} orgs: ${aliases.join(", ")}`);
    } else if (opts.orgs) {
      aliases = opts.orgs
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (aliases.length === 0) {
        console.error("ingest --orgs: empty alias list.");
        process.exitCode = 1;
        return;
      }
    }

    if (aliases !== null && aliases.length > 0) {
      const list = aliases;
      const summary = await multiOrgIngest({
        aliases: list,
        parallel: Boolean(opts.parallel),
        logger,
        buildOpts: (alias: string) => buildSingleIngestOpts(alias, opts, logger, { resolveOrg }),
      });
      console.log(
        `\nMulti-org ingest complete (${summary.parallel ? "parallel" : "sequential"}, ${summary.totalElapsedMs}ms):`,
      );
      printResultsTable(summary.entries, opts.mode ?? "auto");
      const failed = summary.entries.filter(
        (e: MultiOrgIngestEntry) => e.status === "error",
      ).length;
      if (failed > 0) process.exitCode = 1;
      return;
    }

    // Single-org path (preserved behavior).
    let alias: string;
    if (opts.org) {
      alias = opts.org;
    } else {
      const detected = await resolveDefaultOrgAlias();
      if (!detected) {
        console.error(
          "ingest: no --org provided and no default org configured. Run `sf config set target-org <alias>` or pass --org.",
        );
        process.exitCode = 1;
        return;
      }
      alias = detected;
      logger.info(`ingest: using default org from sf config: ${alias}`);
    }

    const built = await buildSingleIngestOpts(alias, opts, logger, { resolveOrg });
    const startedAt = Date.now();
    logger.info(`ingest: starting alias=${alias}`);
    const result = await liveIngest(built);
    logger.info("ingest: capabilities", result.capabilities as unknown as Record<string, unknown>);
    logger.info(
      `ingest: complete mode=${result.mode} members=${result.membersProcessed} deletions=${result.deletions} parseErrors=${result.parseErrors} elapsed=${Date.now() - startedAt}ms`,
    );
    await (built.graphStore as SqliteGraphStore).close();
  } catch (e) {
    if (e instanceof SfgraphError) {
      console.error(`[${e.code}] ${e.message}`);
    } else {
      console.error((e as Error).message);
    }
    process.exitCode = 1;
  }
}
