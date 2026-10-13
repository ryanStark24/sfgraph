import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import {
  EmbeddingPool,
  SqliteGraphStore,
  SqliteSnapshotStore,
  SqliteVectorStore,
  acquireIngestLock,
  defaultEmbeddingWorkerUrl,
  embedMaxTokens,
  embedModelFingerprint,
  embeddingCachePath,
  listAllAuthenticatedOrgs,
  liveIngest,
  multiOrgIngest,
  resolveEmbedModelId,
} from "@ryanstark24/sfgraph-core";
import type { IngestLock, LiveIngestOpts, MultiOrgIngestEntry } from "@ryanstark24/sfgraph-core";
import {
  ConsoleLogger,
  SfgraphError,
  getSfgraphPaths,
  safeOrgDbPath,
} from "@ryanstark24/sfgraph-shared";
import { retrySkippedLabels } from "./skip-labels.js";

export interface IngestOpts {
  /** Offline ingest of an SFDX checkout; --org then only sets the alias. */
  project?: string | undefined;
  /** With --project: re-ingest only the members that changed (Task 11c). */
  delta?: boolean | undefined;
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
  /** Return at "graph ready" instead of waiting for embeddings
   *  (`--no-wait-embeddings`); the next ingest fills the pending vectors. */
  noWaitEmbeddings?: boolean | undefined;
  detectDeletions?: boolean | undefined;
  /** Comma-separated source labels to fetch (e.g. 'apex,generic:Profile').
   *  Forces mode=full and merges into the existing graph without rebuild. */
  only?: string | undefined;
  /** Read the previously-persisted skip report and re-ingest only those
   *  labels. Useful for rate-limit recovery and post-permission-grant
   *  backfill. */
  retrySkipped?: boolean | undefined;
  /** Override Tooling-API pool maxConcurrent (default 5). */
  toolingPool?: number | undefined;
  /** Override Metadata-API pool maxConcurrent (default 5). Bumping this is
   *  usually the highest-leverage knob for slow ingests because Profile /
   *  PermissionSet / Layout fans go through here. */
  metadataPool?: number | undefined;
  /** Override Data (SObject/Bulk) pool maxConcurrent (default 10). */
  dataPool?: number | undefined;
  /** Opt out of the post-ingest auto-retry. By default, if more than
   *  SFGRAPH_AUTO_RETRY_THRESHOLD (default 10) sources were skipped with
   *  transient errors (rate_limit / network / unknown), sfgraph waits a
   *  brief grace period and re-runs ingest scoped to just those labels.
   *  Set this flag (or SFGRAPH_NO_AUTO_RETRY=1) to disable. */
  noAutoRetry?: boolean | undefined;
  /** Skip the post-merge Vlocity↔OmniStudio canonical-of resolver. */
  noCrossFlavor?: boolean | undefined;
  /** Skip the post-merge Apex method-arity resolver. */
  noArityResolve?: boolean | undefined;
  /** Skip the post-merge Flow→Apex invocable-method resolver. */
  noFlowResolve?: boolean | undefined;
  /** Skip the post-merge dangling-edge audit summary. */
  noAudit?: boolean | undefined;
  /** Exit non-zero when ≥N transient sources skipped in a single-org ingest.
   *  Env: SFGRAPH_SKIP_THRESHOLD. Default 5. */
  skipThreshold?: number | undefined;
}

/** Skip categories that are worth retrying. `insufficient_access` and
 *  `not_found` are stable conditions that won't fix themselves on a
 *  second pass; retrying them just wastes time. */
const RETRYABLE_SKIP_CATEGORIES = new Set(["rate_limit", "network", "unknown"]);

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

/**
 * Validate that a user-supplied `--db <path>` resolves to an absolute path
 * inside `getSfgraphPaths().data`. The CLI is local, but treating `--db`
 * as an unconstrained `fs.write` target lets a curious script overwrite
 * unrelated files (or fill `/`). Require explicit `SFGRAPH_ALLOW_ANY_DB`
 * to escape the data dir — for power-users who deliberately want to
 * stash an ingest elsewhere.
 */
function validateDbPath(rawDbPath: string, dataDir: string): string {
  const abs = path.resolve(rawDbPath);
  const rel = path.relative(path.resolve(dataDir), abs);
  const inside = rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (!inside && process.env.SFGRAPH_ALLOW_ANY_DB !== "1") {
    throw new Error(
      `--db path resolves outside the sfgraph data dir (${dataDir}). Refusing to write to ${abs}. Set SFGRAPH_ALLOW_ANY_DB=1 if this is intentional.`,
    );
  }
  return abs;
}

async function buildSingleIngestOpts(
  alias: string,
  opts: IngestOpts,
  logger: ConsoleLogger,
  deps: {
    resolveOrg: typeof import("@ryanstark24/sfgraph-core").resolveOrg;
    /** Called once the org is known, before anything touches its graph
     *  (the ingest lock is taken here). */
    onResolved?: (orgId: string, alias: string) => void;
  },
): Promise<LiveIngestOpts> {
  const resolved = await deps.resolveOrg(alias);
  deps.onResolved?.(String(resolved.orgId), alias);
  const dataDir = getSfgraphPaths().data;
  const dbPath = opts.db
    ? validateDbPath(opts.db, dataDir)
    : safeOrgDbPath(dataDir, String(resolved.orgId));

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

  // Wire a vector store so ingest GENERATES MiniLM embeddings — without this
  // `opts.vectorStore` is undefined, live-ingest never builds its embedding
  // queue, and the vec0 tables stay empty (semantic find_similar returns
  // "vector index unavailable"). Reuses the graph store's SQLite handle and
  // loads sqlite-vec on it. If the native vec extension or the embedding model
  // is unavailable, degrade gracefully (null → structural ingest still works,
  // just no vectors) instead of failing the whole ingest.
  let vectorStore: SqliteVectorStore | undefined;
  try {
    const vs = new SqliteVectorStore({
      dbPath,
      db: graphStore.db,
      skipMigrations: true,
    });
    await vs.init();
    vectorStore = vs;
  } catch (e) {
    logger.warn("ingest: vector store unavailable — embeddings disabled", {
      err: (e as Error).message,
    });
  }

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
        skips?: Array<{ label: string; category?: string }>;
      };
      const labels = retrySkippedLabels(raw.skips ?? []);
      if (labels.length === 0) {
        console.log("--retry-skipped: previous run had no skips. Nothing to retry.");
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

  const embeddingCacheFile = vectorStore ? await embeddingCacheFileFor(dataDir) : undefined;
  return {
    alias,
    mode,
    graphStore,
    snapshotStore,
    ...(vectorStore ? { vectorStore, waitEmbeddings: !opts.noWaitEmbeddings } : {}),
    ...(embeddingCacheFile ? { embeddingCacheFile } : {}),
    logger,
    preResolved: resolved,
    detectDeletions: Boolean(opts.detectDeletions),
    // User-chosen labels (--only / --retry-skipped) are read in full: no
    // early stop on identical refusals (review N1c).
    ...(onlyLabels ? { onlyLabels, explicitOnlyLabels: true } : {}),
    skipReportPath,
    disableCrossFlavor: Boolean(opts.noCrossFlavor),
    disableArityResolve: Boolean(opts.noArityResolve),
    disableFlowInvocableResolve: Boolean(opts.noFlowResolve),
    disableAudit: Boolean(opts.noAudit),
    // Populate the _sfgraph_findings / dead-code / governor / test-coverage
    // tables after merge. Without this the analysis MCP tools (dead_code_audit,
    // security_audit, governor_risk_check, export_sarif) fall back to weak
    // live scans or return empty results — the tables existed but nothing
    // ever wrote to them.
    analysisDb: graphStore.db,
  };
}

/**
 * The persistent embedding cache for the active model:
 * `<dataDir>/embedding-cache/<modelId>@<sha16>[@<cap>].sqlite`, where sha16 is
 * the first 16 hex chars of the model weights file's sha256, so new weights
 * under the same model id never reuse old vectors. A non-default token cap
 * changes the vectors too, so it gets its own file. Undefined (no cache) when
 * the model file cannot be found: there is nothing trustworthy to key it by.
 * The file lives outside the per-org graph DB, so `--rebuild` reuses it; it
 * only grows.
 */
export async function embeddingCacheFileFor(dataDir: string): Promise<string | undefined> {
  const sha = await embedModelFingerprint();
  if (!sha) return undefined;
  const cap = embedMaxTokens();
  const key = `${resolveEmbedModelId()}@${sha.slice(0, 16)}`;
  return embeddingCachePath(dataDir, cap === 256 ? key : `${key}@${cap}`);
}

/**
 * Ruling (a): an embedding failure after graph ready is not an ingest failure.
 * The graph is complete and the unembedded texts stay flagged pending, so the
 * next ingest fills them (find_similar uses text search meanwhile). Warn and
 * leave the exit code alone; live-ingest already printed the cause.
 */
export function reportEmbeddingOutcome(result: {
  embeddings?: { error?: string; failed?: number; pending?: number };
}): void {
  const e = result.embeddings;
  if (!e?.error) return;
  const left = Math.max(e.pending ?? 0, e.failed ?? 0);
  console.warn(
    `warning: the graph is complete, but ${left} texts were left unembedded (${e.error}); their vectors stay pending and the next ingest fills them`,
  );
}

/** Give every built ingest the same embedder (multi-org runs: one worker and
 *  one model in memory instead of one per org). The caller closes it. */
export function shareEmbedder(
  build: (alias: string) => Promise<LiveIngestOpts>,
  embedder: NonNullable<LiveIngestOpts["embedder"]>,
): (alias: string) => Promise<LiveIngestOpts> {
  return async (alias) => {
    const o = await build(alias);
    return o.vectorStore ? { ...o, embedder } : o;
  };
}

/** Offline ingest of an SFDX checkout (plus vlocity/datapacks when present).
 *  Reuses buildSingleIngestOpts with a resolver that never contacts an org. */
export async function buildProjectIngestOpts(
  opts: IngestOpts,
  logger: ConsoleLogger,
  deps: { onResolved?: (orgId: string, alias: string) => void } = {},
): Promise<LiveIngestOpts> {
  const root = path.resolve(String(opts.project));
  if (!existsSync(path.join(root, "sfdx-project.json"))) {
    throw new Error(`--project: ${root} has no sfdx-project.json`);
  }
  const { offlineResolvedOrg, FilesystemMetadataSource } = await import(
    "@ryanstark24/sfgraph-core"
  );
  const alias = opts.org ?? path.basename(root);
  const built = await buildSingleIngestOpts(alias, opts, logger, {
    resolveOrg: (async () => offlineResolvedOrg(root, alias)) as never,
    ...(deps.onResolved ? { onResolved: deps.onResolved } : {}),
  });
  return {
    ...built,
    mode: "full",
    metadataSource: await FilesystemMetadataSource.fromProjectRoot(root),
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

/**
 * Run a move/delete of the graph file. On Windows a file another process has
 * open (`sfgraph serve`, or an MCP client's server) cannot be renamed or
 * deleted: report that plainly instead of a raw EBUSY/EPERM. Nothing has been
 * moved when this throws, so the existing graph is untouched.
 */
export function onGraphFile<T>(dbPath: string, op: () => T): T {
  try {
    return op();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      const hint =
        "Stop `sfgraph serve` and any MCP client using sfgraph (Claude Code, Cursor, ...), then re-run with --rebuild.";
      throw new Error(
        `rebuild: the graph file is in use by another process (${code}): ${dbPath}. ${hint}`,
        { cause: e },
      );
    }
    throw e;
  }
}

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
    onGraphFile(dbPath, () => unlinkSync(dbPath));
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
  onGraphFile(dbPath, () => renameSync(dbPath, backupPath));
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

/**
 * Task 11c: one ingest per org at a time (`<dataDir>/<orgId>.ingest.lock`).
 * Taken as soon as an org is resolved, before --rebuild moves its graph;
 * released when the command ends. Re-taking a held org is a no-op.
 * While a lock is held, SIGINT / SIGTERM release it and exit with 128 + signo
 * (a stale lock is only detectable on the same host).
 */
export function ingestLocks(o: { dir?: string; onSignal?: (sig: NodeJS.Signals) => void } = {}): {
  take: (orgId: string, alias: string) => void;
  releaseAll: () => void;
} {
  const held = new Map<string, IngestLock>();
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  const releaseAll = (): void => {
    for (const l of held.values()) l.release();
    held.clear();
    for (const s of signals) process.off(s, onSig);
  };
  const onSig = (sig: NodeJS.Signals): void => {
    releaseAll();
    if (o.onSignal) o.onSignal(sig);
    // Exit explicitly: re-raising relies on the default action, which other
    // SIGINT / SIGTERM listeners would suppress (the run would go on unlocked).
    else process.exit(128 + (osConstants.signals[sig] ?? 0));
  };
  return {
    take(orgId, alias) {
      if (held.has(orgId)) return;
      const dir = o.dir ?? getSfgraphPaths().data;
      held.set(orgId, acquireIngestLock({ dir, orgId, orgLabel: alias }));
      if (held.size === 1) for (const s of signals) process.on(s, onSig);
    },
    releaseAll,
  };
}

export async function ingestCmd(opts: IngestOpts): Promise<void> {
  const logger = new ConsoleLogger("info");
  const locks = ingestLocks();
  if (opts.embedModel) process.env.SFGRAPH_EMBED_MODEL_PATH = opts.embedModel;
  if (opts.embedModelId) process.env.SFGRAPH_EMBED_MODEL_ID = opts.embedModelId;
  if (opts.embedModelDim !== undefined) {
    process.env.SFGRAPH_EMBED_MODEL_DIM = String(opts.embedModelDim);
  }
  try {
    const { resolveOrg, resolveDefaultOrgAlias, configureDefaultPools } = await import(
      "@ryanstark24/sfgraph-core"
    );

    // Apply pool-concurrency overrides. CLI flags win; SFGRAPH_*_POOL env
    // vars are a secondary knob (handled inside configureDefaultPools).
    const poolOverrides: { tooling?: number; metadata?: number; data?: number } = {};
    if (opts.toolingPool !== undefined) poolOverrides.tooling = opts.toolingPool;
    if (opts.metadataPool !== undefined) poolOverrides.metadata = opts.metadataPool;
    if (opts.dataPool !== undefined) poolOverrides.data = opts.dataPool;
    const applied = await configureDefaultPools(poolOverrides);
    logger.info(
      `ingest: pool concurrency tooling=${applied.tooling} metadata=${applied.metadata} data=${applied.data}`,
    );

    if (opts.delta && !opts.project) throw new Error("--delta needs --project");
    if (opts.delta && opts.rebuild) throw new Error("--delta and --rebuild are mutually exclusive");
    if (opts.project && opts.delta) {
      await projectDelta(opts, logger, locks.take);
      return;
    }
    if (opts.project) {
      const built = await buildProjectIngestOpts(opts, logger, { onResolved: locks.take });
      const result = await liveIngest(built);
      reportEmbeddingOutcome(result);
      console.log(
        `ingest --project: ${result.membersProcessed} members, ${result.parseErrors} parse errors -> ${built.preResolved?.orgId}`,
      );
      const dp = (
        built.metadataSource as
          | {
              dataPackReport?: {
                skipped: Array<{ path: string; reason: string }>;
                types: Record<string, number>;
              };
            }
          | undefined
      )?.dataPackReport;
      if (dp) {
        console.log(`datapacks: ${JSON.stringify(dp.types)} skipped=${dp.skipped.length}`);
        for (const s of dp.skipped.slice(0, 20)) console.log(`  skipped ${s.path}: ${s.reason}`);
      }
      await (built.graphStore as SqliteGraphStore).close();
      return;
    }

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
      const build = (alias: string) =>
        buildSingleIngestOpts(alias, opts, logger, { resolveOrg, onResolved: locks.take });
      // One embedding worker (one model, one ORT arena) shared by every org.
      const workerUrl = defaultEmbeddingWorkerUrl();
      const sharedPool = workerUrl ? new EmbeddingPool({ workerUrl }) : null;
      let summary: Awaited<ReturnType<typeof multiOrgIngest>>;
      try {
        summary = await multiOrgIngest({
          aliases: list,
          parallel: Boolean(opts.parallel),
          logger,
          buildOpts: sharedPool ? shareEmbedder(build, sharedPool) : build,
        });
      } finally {
        await sharedPool?.close();
      }
      console.log(
        `\nMulti-org ingest complete (${summary.parallel ? "parallel" : "sequential"}, ${summary.totalElapsedMs}ms):`,
      );
      printResultsTable(summary.entries, opts.mode ?? "auto");
      for (const e of summary.entries) if (e.result) reportEmbeddingOutcome(e.result);
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

    const built = await buildSingleIngestOpts(alias, opts, logger, {
      resolveOrg,
      onResolved: locks.take,
    });
    const startedAt = Date.now();
    logger.info(`ingest: starting alias=${alias}`);
    const result = await liveIngest(built);
    reportEmbeddingOutcome(result);
    logger.info("ingest: capabilities", result.capabilities as unknown as Record<string, unknown>);
    logger.info(
      `ingest: complete mode=${result.mode} members=${result.membersProcessed} deletions=${result.deletions} parseErrors=${result.parseErrors} elapsed=${Date.now() - startedAt}ms`,
    );

    // Post-ingest auto-retry. If a substantial number of sources skipped
    // with transient failure modes (rate_limit / network / unknown), do
    // ONE second pass scoped to those labels. Permanent skips
    // (insufficient_access / not_found) are excluded because retrying
    // them just incurs the round-trip again. Disabled when the run was
    // already a targeted retry (--only / --retry-skipped) so we don't
    // recursively retry. Capped at one pass — anything still skipping
    // after that needs human attention, surface to the skip report.
    const autoRetryDisabled =
      Boolean(opts.noAutoRetry) || process.env.SFGRAPH_NO_AUTO_RETRY === "1";
    const wasTargetedRun = Boolean(opts.only || opts.retrySkipped);
    if (!autoRetryDisabled && !wasTargetedRun && built.skipReportPath) {
      const threshold = Number.parseInt(process.env.SFGRAPH_AUTO_RETRY_THRESHOLD ?? "10", 10) || 10;
      const { existsSync, readFileSync } = await import("node:fs");
      let retryable: Array<{ label: string; category: string }> = [];
      if (existsSync(built.skipReportPath)) {
        try {
          const report = JSON.parse(readFileSync(built.skipReportPath, "utf8")) as {
            skips?: Array<{ label: string; category: string }>;
          };
          retryable = (report.skips ?? []).filter((s) => RETRYABLE_SKIP_CATEGORIES.has(s.category));
        } catch {
          /* malformed skip report; skip auto-retry */
        }
      }
      if (retryable.length > threshold) {
        // Rate-limit skips need a quota window to refresh server-side;
        // a brief network-only retry can fire immediately.
        const hasRateLimit = retryable.some((s) => s.category === "rate_limit");
        const delayMs = hasRateLimit ? 30_000 : 5_000;
        const labels = new Set(retryable.map((s) => s.label));
        console.log(
          `ingest: auto-retry — ${retryable.length} transient skip${retryable.length === 1 ? "" : "s"} (rate_limit/network/unknown). Waiting ${delayMs / 1000}s for conditions to clear, then re-ingesting just those sources.`,
        );
        console.log("         Disable with --no-auto-retry-skipped or SFGRAPH_NO_AUTO_RETRY=1.");
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const retryStartedAt = Date.now();
        // In-run auto-retry: not an explicit re-run, so the early stop stays on.
        const retryResult = await liveIngest({
          ...built,
          onlyLabels: labels,
          explicitOnlyLabels: false,
        });
        logger.info(
          `ingest: auto-retry complete members=${retryResult.membersProcessed} parseErrors=${retryResult.parseErrors} elapsed=${Date.now() - retryStartedAt}ms`,
        );
      }
    }

    // Exit-code policy: signal partial failure when ≥N transient sources
    // skipped. Default threshold 5; env / flag override available. Use a
    // very high value (e.g. 9999) to preserve the prior always-exit-0
    // behavior for CI pipelines that rely on it.
    if (built.skipReportPath) {
      const threshold = (() => {
        // Accept only positive integers from either the flag or the env;
        // anything else (negative, zero, fractional, NaN) silently falls back
        // to the default rather than producing surprising exit-code behavior.
        const candidate =
          typeof opts.skipThreshold === "number"
            ? opts.skipThreshold
            : Number.parseInt(process.env.SFGRAPH_SKIP_THRESHOLD ?? "", 10);
        return Number.isInteger(candidate) && candidate > 0 ? candidate : 5;
      })();
      const { existsSync, readFileSync } = await import("node:fs");
      if (existsSync(built.skipReportPath)) {
        try {
          const report = JSON.parse(readFileSync(built.skipReportPath, "utf8")) as {
            skips?: Array<{ label: string; category: string }>;
          };
          const transient = (report.skips ?? []).filter((s) =>
            RETRYABLE_SKIP_CATEGORIES.has(s.category),
          );
          if (transient.length >= threshold) {
            console.error(
              `ingest: ${transient.length} transient source${transient.length === 1 ? "" : "s"} skipped (threshold=${threshold}). Setting exit code 1. Use --skip-threshold 9999 or SFGRAPH_SKIP_THRESHOLD=9999 to preserve exit 0.`,
            );
            process.exitCode = 1;
          }
        } catch {
          /* malformed skip report; leave exit code alone */
        }
      }
    }

    await (built.graphStore as SqliteGraphStore).close();
  } catch (e) {
    if (e instanceof SfgraphError) {
      console.error(`[${e.code}] ${e.message}`);
    } else {
      console.error((e as Error).message);
    }
    process.exitCode = 1;
  } finally {
    locks.releaseAll();
  }
}

/**
 * `ingest --project <p> --delta`: re-derive only the changed members
 * (core runDeltaIngest prints `delta: +A ~C -D (=U unchanged) in Ns`). A
 * graph without member rows (older sfgraph, interrupted full ingest) gets a
 * full rebuild instead. The caller's lock covers both.
 */
async function projectDelta(
  opts: IngestOpts,
  logger: ConsoleLogger,
  takeLock: (orgId: string, alias: string) => void,
): Promise<void> {
  const { runDeltaIngest } = await import("@ryanstark24/sfgraph-core");
  const built = await buildProjectIngestOpts({ ...opts, rebuild: false }, logger, {
    onResolved: takeLock,
  });
  const store = built.graphStore as SqliteGraphStore;
  let open = true;
  try {
    const r = await runDeltaIngest({
      ...built,
      graphStore: store,
      preResolved: built.preResolved as NonNullable<LiveIngestOpts["preResolved"]>,
      metadataSource: built.metadataSource as NonNullable<LiveIngestOpts["metadataSource"]>,
      fullRebuild: async () => {
        await store.close();
        open = false;
        const full = await buildProjectIngestOpts({ ...opts, rebuild: true, delta: false }, logger);
        try {
          const result = await liveIngest(full);
          reportEmbeddingOutcome(result);
          console.log(
            `ingest --project: ${result.membersProcessed} members, ${result.parseErrors} parse errors -> ${full.preResolved?.orgId}`,
          );
        } finally {
          await (full.graphStore as SqliteGraphStore).close();
        }
      },
    });
    if (r.result) reportEmbeddingOutcome(r.result);
  } finally {
    if (open) await store.close();
  }
}
