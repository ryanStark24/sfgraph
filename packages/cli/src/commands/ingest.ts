import path from "node:path";
import {
  SqliteGraphStore,
  SqliteSnapshotStore,
  listAllAuthenticatedOrgs,
  liveIngest,
  multiOrgIngest,
} from "@ryanstark24/sfgraph-core";
import type { LiveIngestOpts, MultiOrgIngestEntry } from "@ryanstark24/sfgraph-core";
import { ConsoleLogger, SfgraphError, getSfgraphPaths, safeOrgDbPath } from "@ryanstark24/sfgraph-shared";

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
  rebuild?: boolean | undefined;
  noBackup?: boolean | undefined;
  detectDeletions?: boolean | undefined;
  /** Comma-separated source labels to fetch (e.g. 'apex,generic:Profile').
   *  Forces mode=full and merges into the existing graph without rebuild. */
  only?: string | undefined;
  /** Read the previously-persisted skip report and re-ingest only those
   *  labels. Useful for rate-limit recovery and post-permission-grant
   *  backfill. */
  retrySkipped?: boolean | undefined;
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
  const dbPath = opts.db ?? safeOrgDbPath(getSfgraphPaths().data, String(resolved.orgId));

  if (opts.rebuild) {
    await applyRebuild(dbPath, String(resolved.orgId), Boolean(opts.noBackup), logger);
  }

  const graphStore = new SqliteGraphStore({ dbPath });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: graphStore.db,
    skipMigrations: true,
  });
  await snapshotStore.init();

  // --rebuild and --only and --retry-skipped all force a full sync because
  // incremental wouldn't pick up newly-permitted/unblocked types.
  const forceFull = Boolean(opts.rebuild || opts.only || opts.retrySkipped);
  const mode: "full" | "incremental" | "auto" = forceFull ? "full" : (opts.mode ?? "auto");

  // Resolve onlyLabels from --only or --retry-skipped. The skip report lives
  // at <dataDir>/<orgId>.skips.json (written at end of every ingest).
  const skipReportPath = path.join(getSfgraphPaths().data, `${resolved.orgId}.skips.json`);
  let onlyLabels: Set<string> | undefined;
  if (opts.only) {
    onlyLabels = new Set(
      opts.only
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );
  } else if (opts.retrySkipped) {
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync(skipReportPath)) {
      throw new Error(
        `--retry-skipped: no skip report found at ${skipReportPath}. Run a full ingest first.`,
      );
    }
    try {
      const raw = JSON.parse(readFileSync(skipReportPath, "utf8")) as {
        skips?: Array<{ label: string }>;
      };
      const labels = (raw.skips ?? []).map((s) => s.label).filter(Boolean);
      if (labels.length === 0) {
        console.log("--retry-skipped: previous run had zero skips. Nothing to retry.");
        // Return a no-op opts; the live-ingest will exit cleanly with no work.
        onlyLabels = new Set();
      } else {
        onlyLabels = new Set(labels);
        console.log(
          `--retry-skipped: retrying ${labels.length} previously-skipped source${labels.length === 1 ? "" : "s"} from ${skipReportPath}`,
        );
      }
    } catch (e) {
      throw new Error(
        `--retry-skipped: failed to read skip report at ${skipReportPath}: ${(e as Error).message}`,
      );
    }
  }

  return {
    alias,
    mode,
    graphStore,
    snapshotStore,
    logger,
    preResolved: resolved,
    detectDeletions: Boolean(opts.detectDeletions),
    ...(onlyLabels ? { onlyLabels } : {}),
    skipReportPath,
  };
}

/**
 * SQLite uses WAL by default in this codebase, which means alongside
 * `<file>.sqlite` you also get `<file>.sqlite-wal` and `<file>.sqlite-shm`.
 * Plain rollback journals add `<file>.sqlite-journal`. Without handling
 * these sidecars during --rebuild, the move/delete leaves orphans that
 * SQLite later reads back into the new DB, corrupting state.
 */
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

async function applyRebuild(
  dbPath: string,
  orgId: string,
  noBackup: boolean,
  logger: ConsoleLogger,
): Promise<void> {
  const { existsSync, mkdirSync, renameSync, unlinkSync } = await import("node:fs");
  if (!existsSync(dbPath)) {
    logger.info(`rebuild: no existing graph at ${dbPath}; starting fresh`);
    return;
  }
  if (noBackup) {
    unlinkSync(dbPath);
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) {
        try {
          unlinkSync(sidecar);
        } catch {
          /* best-effort */
        }
      }
    }
    console.warn(`REBUILD: existing graph for ${orgId} DELETED (no-backup); running full sync`);
    return;
  }
  const backupDir = path.join(getSfgraphPaths().data, "backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${orgId}.rebuild-${stamp}.sqlite`);
  renameSync(dbPath, backupPath);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        renameSync(sidecar, `${backupPath}${suffix}`);
      } catch {
        /* best-effort: if we can't move the sidecar, delete it so it
           doesn't get associated with the fresh DB */
        try {
          unlinkSync(sidecar);
        } catch {
          /* swallow */
        }
      }
    }
  }
  console.warn(`REBUILD: existing graph for ${orgId} moved to ${backupPath}; running full sync`);
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
