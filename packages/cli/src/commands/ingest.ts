import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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
  loadBetterSqlite3,
  multiOrgIngest,
  rebuildBackupsKept,
  resolveEmbedModelId,
  safeGitConfig,
  safeGitEnv,
} from "@ryanstark24/sfgraph-core";
import type { IngestLock, LiveIngestOpts, MultiOrgIngestEntry } from "@ryanstark24/sfgraph-core";
import {
  ConsoleLogger,
  ErrorCode,
  SfgraphError,
  ensurePrivateDir,
  getSfgraphPaths,
  restrictDbFiles,
  safeOrgDbPath,
} from "@ryanstark24/sfgraph-shared";
import {
  type PruneOutcome,
  SQLITE_SIDECAR_SUFFIXES,
  clearRebuildPending,
  formatBytes,
  isRebuildPending,
  markBackupIncomplete,
  markRebuildPending,
  pruneOrgBackups,
  sweepBackups,
} from "./rebuild-backups.js";
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
  /** Read and store custom setting row values (`--store-setting-rows`; default off). */
  storeSettingRows?: boolean | undefined;
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

/**
 * One alias, one graph: refuse to stamp `alias` into the graph of `orgId` while another org's
 * graph file already claims it (the read side would then refuse the alias for both). Files that
 * cannot be read are skipped here; the server refuses an alias while one is unreadable.
 */
export function assertAliasNotClaimedElsewhere(
  dataDir: string,
  orgId: string,
  alias: string,
  loadDriver: () => unknown = () => loadBetterSqlite3(),
): void {
  if (!existsSync(dataDir)) return;
  // Load the driver once, through core (which declares it; the CLI package does not). A driver
  // that cannot load is an error, never "no claims": only a single unreadable file is skipped.
  let Ctor: new (
    p: string,
    o?: unknown,
  ) => {
    prepare: (s: string) => { all: (...a: unknown[]) => unknown[] };
    close: () => void;
  };
  try {
    Ctor = loadDriver() as typeof Ctor;
  } catch (e) {
    throw new SfgraphError(
      ErrorCode.E_INVALID_ORG_IDENTIFIER,
      `ingest: cannot check whether the alias '${alias}' is already used by another graph, because the SQLite driver could not be loaded (${(e as Error).message}). Fix the install (reinstall sfgraph, or run 'sfgraph doctor') and run this again.`,
      { cause: e },
    );
  }
  const claimedBy: string[] = [];
  for (const f of readdirSync(dataDir)) {
    if (!f.endsWith(".sqlite") || f.startsWith("backups")) continue;
    if (f === `${orgId}.sqlite`) continue;
    const dbPath = path.join(dataDir, f);
    try {
      if (statSync(dbPath).size === 0) continue;
      const db = new Ctor(dbPath, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare("SELECT id, alias FROM _sfgraph_orgs").all() as Array<{
          id: string;
          alias: string | null;
        }>;
        if (
          rows.some(
            (r) =>
              r.alias !== null &&
              r.alias.toLowerCase() === alias.toLowerCase() &&
              String(r.id) !== orgId,
          )
        )
          claimedBy.push(f);
      } finally {
        db.close();
      }
    } catch {
      // unreadable or not a graph: not a claim we can see
    }
  }
  if (claimedBy.length > 0) {
    throw new SfgraphError(
      ErrorCode.E_INVALID_ORG_IDENTIFIER,
      `ingest: the alias '${alias}' is already used by another org's graph (${claimedBy.sort().join(", ")}). Refusing to write it into ${orgId}.sqlite: one alias must name one graph. Use a different --org name, or remove or rename the alias on the other graph (delete that file, or re-ingest that org under another alias), then run this again.`,
    );
  }
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
  assertAliasNotClaimedElsewhere(dataDir, String(resolved.orgId), String(resolved.alias ?? alias));
  const dbPath = opts.db
    ? validateDbPath(opts.db, dataDir)
    : safeOrgDbPath(dataDir, String(resolved.orgId));

  const backupPath = opts.rebuild
    ? await applyRebuild(dbPath, String(resolved.orgId), Boolean(opts.noBackup), logger)
    : undefined;

  const graphStore = new SqliteGraphStore({ dbPath });
  await graphStore.init();
  // Closed if anything below fails: the caller only closes what it gets back.
  try {
    return await buildOnStore(graphStore, {
      alias,
      opts,
      logger,
      dbPath,
      dataDir,
      resolved,
      backupPath,
    });
  } catch (e) {
    await graphStore.close().catch(() => {});
    throw e;
  }
}

async function buildOnStore(
  graphStore: SqliteGraphStore,
  c: {
    alias: string;
    opts: IngestOpts;
    logger: ConsoleLogger;
    dbPath: string;
    dataDir: string;
    resolved: Awaited<ReturnType<typeof import("@ryanstark24/sfgraph-core").resolveOrg>>;
    backupPath: string | undefined;
  },
): Promise<LiveIngestOpts> {
  const { alias, opts, logger, dbPath, dataDir, resolved, backupPath } = c;
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: graphStore.db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  // A rebuild keeps the snapshot history (point_in_time_diff): copy it from
  // the backup before the first snapshot of the new graph is taken.
  const carried = backupPath
    ? carrySnapshots(snapshotStore, backupPath, String(resolved.orgId))
    : 0;
  const run = rebuildRuns.get(String(resolved.orgId));
  if (run) run.carried = carried;

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
    ...(opts.storeSettingRows ? { storeCustomSettingRows: true } : {}),
    // A snapshot of the still-empty rebuilt graph adds nothing to the carried
    // history; the next ingest's snapshot records the rebuilt state.
    ...(carried > 0 ? { skipSnapshot: true } : {}),
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

/**
 * Say plainly what a live sync did and did not refresh. Incremental sync applies
 * deletions only; `auto` falls back to a full refresh when content changed, and
 * SourceMember types sfgraph cannot map are reported, never dropped silently.
 */
export function reportSyncModeNotes(
  alias: string,
  result: { mode: string; warnings?: string[] },
): void {
  for (const w of result.warnings ?? []) {
    if (w.startsWith("incremental:fellBackToFull:changed=")) {
      const n = w.slice(w.lastIndexOf("=") + 1);
      console.warn(
        `ingest: ${alias}: ${n} member(s) changed since the last sync, and incremental sync only applies deletions, so auto ran a full refresh instead (mode=${result.mode}).`,
      );
    } else if (w.startsWith("incremental:contentNotFetched:count=")) {
      const n = w.slice(w.lastIndexOf("=") + 1);
      console.warn(
        `warning: ${alias}: ${n} added/modified member(s) were NOT fetched: incremental sync applies deletions only. The sync watermark was held. Run with --mode full (or --mode auto) to refresh them.`,
      );
    } else if (w.startsWith("incremental:unsupportedTypes:")) {
      console.warn(
        `warning: ${alias}: changes to metadata types sfgraph cannot map (${w.slice("incremental:unsupportedTypes:".length)}) were not processed incrementally. Run with --mode full to refresh them.`,
      );
    }
  }
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
  const sourceRevision = gitRevision(root);
  const built = await buildSingleIngestOpts(alias, opts, logger, {
    resolveOrg: (async () => offlineResolvedOrg(root, alias)) as never,
    ...(deps.onResolved ? { onResolved: deps.onResolved } : {}),
  });
  try {
    return {
      ...built,
      mode: "full",
      metadataSource: await FilesystemMetadataSource.fromProjectRoot(root),
      ...(sourceRevision ? { sourceRevision } : {}),
    };
  } catch (e) {
    await (built.graphStore as SqliteGraphStore).close().catch(() => {});
    throw e;
  }
}

/** Print the paths a project walk refused because they resolve outside the project folder. */
function reportOutsideRoot(source: unknown): void {
  const warnings = (source as { warnings?: () => string[] } | undefined)?.warnings?.() ?? [];
  for (const w of warnings.slice(0, 20)) console.warn(`warning: ${w}`);
  if (warnings.length > 20) console.warn(`warning: ... and ${warnings.length - 20} more skipped`);
}

/** Read a checkout's immutable identity without making Git a project-ingest prerequisite. */
function gitRevision(
  root: string,
): { gitBranch: string; gitCommit: string; capturedAt: string } | undefined {
  try {
    // The checkout may be untrusted: same hardening as the wip git calls.
    const cfg = safeGitConfig(root);
    if (!cfg) return undefined;
    const git = (...args: string[]) =>
      execFileSync("git", [...cfg, ...args], {
        cwd: root,
        env: safeGitEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    const gitCommit = git("rev-parse", "HEAD");
    if (!/^[0-9a-f]{40,64}$/i.test(gitCommit)) return undefined;
    const gitBranch = git("symbolic-ref", "--short", "-q", "HEAD") || "HEAD";
    return { gitBranch, gitCommit, capturedAt: new Date().toISOString() };
  } catch {
    return undefined;
  }
}

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

/**
 * Copy the backup's snapshot tables into the rebuilt graph. A failure leaves
 * the new graph without history (the backup still has it) and warns.
 */
function carrySnapshots(store: SqliteSnapshotStore, backupPath: string, orgId: string): number {
  try {
    const r = store.copySnapshotsFrom(backupPath);
    if (r.skipped) {
      console.warn(`REBUILD: snapshot history for ${orgId} not kept: ${r.skipped}`);
      return 0;
    }
    if (r.copied > 0) {
      console.warn(`REBUILD: kept ${r.copied} snapshot${r.copied === 1 ? "" : "s"} for ${orgId}`);
    }
    return r.copied;
  } catch (e) {
    console.warn(
      `REBUILD: snapshot history for ${orgId} not kept (${(e as Error).message}); it is still in ${backupPath}`,
    );
    return 0;
  }
}

/**
 * Delete all but the newest `keep` (default `SFGRAPH_REBUILD_BACKUPS_KEPT`, 1) complete
 * rebuild backups of one org, with their sidecars; the names carry an ISO stamp, so name
 * order is time order. Backups of an incomplete graph never count toward `keep`. With
 * `protectHistory` (default) the newest complete backup that still holds snapshot history
 * is kept too: a rebuild whose snapshot copy failed leaves that history only there.
 * Returns the names removed. Best-effort. Runs only after a rebuild's sync completed
 * (see {@link finishRebuild}), never from applyRebuild.
 */
export async function pruneRebuildBackups(
  backupDir: string,
  orgId: string,
  o: { keep?: number; protectHistory?: boolean } = {},
): Promise<string[]> {
  return pruneOrgBackups(backupDir, orgId, o).removed.map((b) => b.name);
}

/** What a --rebuild left to settle once its sync completes (keyed by org id). */
const rebuildRuns = new Map<string, { carried: number }>();

const describeFreed = formatBytes;

function reportPrune(orgId: string, r: PruneOutcome, keep: number): void {
  if (r.removed.length > 0) {
    console.warn(
      `REBUILD: removed ${r.removed.length} older backup${r.removed.length === 1 ? "" : "s"} for ${orgId} (keeping the newest ${keep}; freed ${describeFreed(r.freedBytes)})`,
    );
  }
  for (const s of r.inUse) {
    console.warn(
      `REBUILD: backup ${s.name} skipped (in use); remove it later with 'sfgraph storage clean --backups --apply'`,
    );
  }
}

/**
 * A --rebuild's sync finished (and its pre-sync snapshot was taken): the rebuilt graph is
 * complete, so settle the backups. Clears the pending marker and prunes this org's backups
 * to the newest `SFGRAPH_REBUILD_BACKUPS_KEPT` complete ones. A failed carry of the
 * snapshot history keeps the newest backup that holds it. Returns the org id when it ran.
 */
export async function finishRebuild(orgId: string): Promise<boolean> {
  const run = rebuildRuns.get(orgId);
  if (!run) return false;
  rebuildRuns.delete(orgId);
  const dataDir = getSfgraphPaths().data;
  clearRebuildPending(dataDir, orgId);
  const keep = rebuildBackupsKept();
  try {
    reportPrune(
      orgId,
      pruneOrgBackups(path.join(dataDir, "backups"), orgId, {
        keep,
        protectHistory: run.carried === 0,
      }),
      keep,
    );
  } catch (e) {
    console.warn(`REBUILD: could not prune old backups for ${orgId}: ${(e as Error).message}`);
  }
  return true;
}

/**
 * After finished rebuilds: apply the same keep rule to every other org's backups, so a
 * stale org's old copies go too. An org whose ingest lock is held is skipped, and so are
 * files that are not rebuild backups (named, never removed).
 */
export function sweepOtherBackups(handled: ReadonlySet<string>): void {
  try {
    const r = sweepBackups(getSfgraphPaths().data, { skipOrgs: handled });
    if (r.removed.length > 0) {
      console.warn(
        `REBUILD: removed ${r.removed.length} old backup${r.removed.length === 1 ? "" : "s"} of ${r.orgs.length} other org${r.orgs.length === 1 ? "" : "s"} (keeping the newest ${rebuildBackupsKept()} each; freed ${describeFreed(r.freedBytes)})`,
      );
    }
    for (const s of r.inUse) {
      console.warn(`REBUILD: backup ${s.name} skipped (in use)`);
    }
    for (const id of r.busyOrgs) {
      console.warn(`REBUILD: backups of ${id} skipped (an ingest of that org is running)`);
    }
    if (r.other.length > 0) {
      const bytes = r.other.reduce((n, f) => n + f.bytes, 0);
      console.warn(
        `REBUILD: backups/ also holds ${r.other.length} file${r.other.length === 1 ? "" : "s"} that ${r.other.length === 1 ? "is" : "are"} not rebuild backups (${describeFreed(bytes)}), not touched: ${r.other
          .map((f) => f.name)
          .slice(0, 5)
          .join(", ")}${r.other.length > 5 ? ", ..." : ""}. 'sfgraph storage' lists them.`,
      );
    }
  } catch (e) {
    console.warn(`REBUILD: could not sweep old backups: ${(e as Error).message}`);
  }
}

/**
 * Move (or delete) the org's graph file; returns the backup's path when moved. Prunes
 * NOTHING: older backups stay until the rebuilt graph's sync completes ({@link finishRebuild}),
 * so a failed rebuild never costs the last good copy. A rebuild that starts while the
 * previous one never finished is moving a half-built graph: its backup is marked incomplete
 * and never counts toward the backups kept.
 */
async function applyRebuild(
  dbPath: string,
  orgId: string,
  noBackup: boolean,
  logger: ConsoleLogger,
): Promise<string | undefined> {
  const { existsSync, renameSync, unlinkSync } = await import("node:fs");
  const dataDir = getSfgraphPaths().data;
  const previousUnfinished = isRebuildPending(dataDir, orgId);
  // Until this rebuild's sync completes, the graph at dbPath is incomplete.
  markRebuildPending(dataDir, orgId);
  rebuildRuns.set(orgId, { carried: 0 });
  if (!existsSync(dbPath)) {
    logger.info(`rebuild: no existing graph at ${dbPath}; starting fresh`);
    return undefined;
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
    return undefined;
  }
  const backupDir = path.join(dataDir, "backups");
  ensurePrivateDir(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${orgId}.rebuild-${stamp}.sqlite`);
  onGraphFile(dbPath, () => renameSync(dbPath, backupPath));
  restrictDbFiles(backupPath);
  if (previousUnfinished) markBackupIncomplete(backupPath);
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
  console.warn(
    `REBUILD: existing graph for ${orgId} moved to ${backupPath}${previousUnfinished ? " (the previous rebuild never finished, so this copy is marked incomplete)" : ""}; running full sync`,
  );
  return backupPath;
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

/**
 * The syncs of these orgs completed: settle each --rebuild's backups ({@link finishRebuild}),
 * then apply the keep rule to every other org's backups once.
 */
async function settleRebuilds(orgIds: string[]): Promise<void> {
  const handled = new Set<string>();
  for (const id of orgIds) if (await finishRebuild(id)) handled.add(id);
  if (handled.size > 0) sweepOtherBackups(handled);
}

/**
 * A plain ingest that built the whole graph (a full sync or a project delta, not --only,
 * --retry-skipped or an incremental deletions-only run) completed: the graph is complete, so a
 * `<orgId>.rebuild-pending.json` left by an earlier failed rebuild no longer applies, and a
 * later rebuild must not mark its backup incomplete.
 */
function clearPendingAfterCompleteIngest(orgIds: string[]): void {
  const dataDir = getSfgraphPaths().data;
  for (const id of orgIds) clearRebuildPending(dataDir, id);
}

export async function ingestCmd(opts: IngestOpts): Promise<void> {
  const logger = new ConsoleLogger("info");
  const locks = ingestLocks();
  // Every graph store this run opened. liveIngest does not close the store it is handed, so a
  // failed sync (or a throw after it) used to leave the SQLite handle open until process exit:
  // on Windows an open handle blocks the next rebuild's rename/unlink of the same file.
  const opened: SqliteGraphStore[] = [];
  const track = <T extends { graphStore?: unknown }>(b: T): T => {
    if (b.graphStore) opened.push(b.graphStore as SqliteGraphStore);
    return b;
  };
  rebuildRuns.clear();
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
    // An offline ingest reads every member of the checkout; a label filter has
    // nothing to narrow (final review core M-3).
    if (opts.project && (opts.only || opts.retrySkipped)) {
      throw new Error(
        `${opts.only ? "--only" : "--retry-skipped"} does not work with --project: a project ingest always reads the whole checkout`,
      );
    }
    if (opts.delta && opts.rebuild) throw new Error("--delta and --rebuild are mutually exclusive");
    if (opts.project && opts.delta) {
      await projectDelta(opts, logger, locks.take);
      return;
    }
    if (opts.project) {
      const built = track(await buildProjectIngestOpts(opts, logger, { onResolved: locks.take }));
      const result = await liveIngest(built);
      reportEmbeddingOutcome(result);
      console.log(
        `ingest --project: ${result.membersProcessed} members, ${result.parseErrors} parse errors -> ${built.preResolved?.orgId}`,
      );
      await settleRebuilds([String(built.preResolved?.orgId)]);
      clearPendingAfterCompleteIngest([String(built.preResolved?.orgId)]);
      reportOutsideRoot(built.metadataSource);
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
      const build = async (alias: string) =>
        track(
          await buildSingleIngestOpts(alias, opts, logger, { resolveOrg, onResolved: locks.take }),
        );
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
      for (const e of summary.entries) {
        if (e.result) {
          reportEmbeddingOutcome(e.result);
          reportSyncModeNotes(e.alias, e.result);
        }
      }
      const failed = summary.entries.filter(
        (e: MultiOrgIngestEntry) => e.status === "error",
      ).length;
      // Only an org whose sync completed settles its rebuild backups.
      await settleRebuilds(
        summary.entries
          .filter((e: MultiOrgIngestEntry) => e.status === "ok" && e.result)
          .map((e: MultiOrgIngestEntry) => String(e.result?.orgId)),
      );
      if (!opts.only && !opts.retrySkipped) {
        clearPendingAfterCompleteIngest(
          summary.entries
            .filter((e: MultiOrgIngestEntry) => e.status === "ok" && e.result?.mode === "full")
            .map((e: MultiOrgIngestEntry) => String(e.result?.orgId)),
        );
      }
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

    const built = track(
      await buildSingleIngestOpts(alias, opts, logger, {
        resolveOrg,
        onResolved: locks.take,
      }),
    );
    const startedAt = Date.now();
    logger.info(`ingest: starting alias=${alias}`);
    const result = await liveIngest(built);
    reportEmbeddingOutcome(result);
    reportSyncModeNotes(alias, result);
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

    let syncIncomplete = false;
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
            syncIncomplete = true;
          }
        } catch {
          /* malformed skip report; leave exit code alone */
        }
      }
    }

    // A sync that skipped too many sources is not a finished rebuild: keep the old backups.
    if (!syncIncomplete) {
      await settleRebuilds([String(built.preResolved?.orgId)]);
      if (!opts.only && !opts.retrySkipped && result.mode === "full") {
        clearPendingAfterCompleteIngest([String(built.preResolved?.orgId)]);
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
    // Close before the lock is released: the next process (or an in-process retry rebuild)
    // may move or delete these files as soon as the lock is free.
    for (const store of opened) await store.close().catch(() => {});
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
          await settleRebuilds([String(full.preResolved?.orgId)]);
        } finally {
          await (full.graphStore as SqliteGraphStore).close();
        }
      },
    });
    if (r.result) reportEmbeddingOutcome(r.result);
    clearPendingAfterCompleteIngest([String(built.preResolved?.orgId)]);
    reportOutsideRoot(built.metadataSource);
  } finally {
    if (open) await store.close();
  }
}
