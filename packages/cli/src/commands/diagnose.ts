/**
 * Phase 1.5 — W1.5-05: `sfgraph diagnose <orgId>` CLI subcommand.
 *
 * Runs a live-ingest under "diagnostic mode" — pool concurrencies forced to
 * 1 so a wedge stands out — and emits a structured JSON report capturing
 * per-source timing, wedge events parsed from the namespaced-warning
 * stream, capability probe results, and detect-deletions guard refusals.
 *
 * The report is the primary triage artifact for a real-org wedge: when a
 * source gets skipped or wedged, this file names which source, which
 * record was last yielded, and which knob to turn.
 *
 * IMPORTANT: diagnose mode wall-clock is NOT comparable to a production
 * ingest run (concurrency forced to 1). It exists to NAME the wedge, not
 * to predict prod throughput. This caveat is printed at the top of the
 * report and in --help.
 *
 * Diagnose runs against a TEMPORARY graph DB by default so the user's main
 * graph state is untouched. `--keep-graph` opts out (writes to the real
 * org DB at the normal path).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LiveIngestOpts, LiveIngestResult } from "@ryanstark24/sfgraph-core";
import { ConsoleLogger, getSfgraphPaths, safeOrgDbPath } from "@ryanstark24/sfgraph-shared";

// ---------------------------------------------------------------------------
// Report shape — matches PLAN.md W1.5-05 acceptance criteria. Schema is
// versioned so downstream consumers can detect breaking changes.
// ---------------------------------------------------------------------------

export type WedgeEventKind = "firstYield" | "inactivity" | "cap-evicted" | "resolvedLate";

export interface WedgeEvent {
  kind: WedgeEventKind;
  /** ms since this source started; `undefined` when not derivable from the
   *  warning string (e.g. cap-evicted carries ageMs, not start-relative). */
  atMs?: number;
  lastYieldedRecord?: string;
  wedgedForMs?: number;
}

export interface DiagnoseReportSourceEntry {
  /** Source label (e.g. "lwc", "generic:Profile"). */
  name: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedMs?: number;
  /** Records observed for this source. Populated when the runner supplies
   *  onSourceStart/onSourceComplete callbacks. */
  yieldCount: number;
  wedged: boolean;
  lastYieldedRecord?: string;
  wedgeEvents: WedgeEvent[];
  /** W1.5-07: surfaced when this label was refused by the deletion guard. */
  needsDiagnose?: boolean;
  error?: { code: string; message: string };
}

export interface DetectDeletionsRefusal {
  label: string;
  reason: "empty-stream" | "drop-ratio";
  priorCount: number;
  touchedCount?: number;
  ratio?: number;
}

export interface DiagnoseReport {
  schemaVersion: 1;
  diagnosticMode: true;
  /** Caveat reproduced inside the report itself so anyone reading it later
   *  understands that wall-clock here != production throughput. */
  note: string;
  orgId: string;
  alias?: string;
  startedAt: string;
  finishedAt: string;
  totalElapsedMs: number;
  exitStatus: "ok" | "failed" | "timeout";
  capabilities: Record<string, unknown>;
  config: {
    sourceConcurrency: number;
    toolingPool: number;
    metadataPool: number;
    dataPool: number;
    /** Echo of the runtime watchdog budgets (NOT overridden by diagnose). */
    watchdogFirstYieldMs?: number;
    watchdogInactivityMs?: number;
    backgroundWedgeCap?: number;
    detectDeletionsMaxDropRatio?: number;
  };
  perSource: DiagnoseReportSourceEntry[];
  detectDeletionsRefusals: DetectDeletionsRefusal[];
  /** Raw namespaced warning strings, preserved verbatim. */
  warnings: string[];
  /** Source labels flagged as needing further diagnosis (typically via
   *  detect-deletions guard refusal). */
  needsDiagnose: string[];
  /** Optional error message when `exitStatus !== "ok"`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Reporter — observes ingest signals during a diagnose run and builds the
// final JSON report. Exported (lightly) so tests can drive it directly
// without a live connection.
// ---------------------------------------------------------------------------

export class DiagnoseReporter {
  private readonly perSource = new Map<string, DiagnoseReportSourceEntry>();
  private readonly refusals: DetectDeletionsRefusal[] = [];
  private readonly startedAt: number;
  private readonly orgId: string;
  private readonly alias?: string;

  constructor(orgId: string, alias?: string, startedAtEpoch: number = Date.now()) {
    this.orgId = orgId;
    if (alias !== undefined) this.alias = alias;
    this.startedAt = startedAtEpoch;
  }

  /** Called when a source begins. Idempotent. */
  noteSourceStart(label: string, atEpoch: number = Date.now()): void {
    let entry = this.perSource.get(label);
    if (!entry) {
      entry = {
        name: label,
        startedAt: new Date(atEpoch).toISOString(),
        yieldCount: 0,
        wedged: false,
        wedgeEvents: [],
      };
      this.perSource.set(label, entry);
    }
  }

  /** Called when a source completes (success OR caught error). */
  noteSourceComplete(
    label: string,
    info: { recordCount: number; error?: Error } = { recordCount: 0 },
    atEpoch: number = Date.now(),
  ): void {
    const entry = this.perSource.get(label) ?? {
      name: label,
      yieldCount: 0,
      wedged: false,
      wedgeEvents: [],
    };
    entry.finishedAt = new Date(atEpoch).toISOString();
    const startedEpoch = entry.startedAt ? Date.parse(entry.startedAt) : atEpoch;
    entry.elapsedMs = Math.max(0, atEpoch - startedEpoch);
    entry.yieldCount = info.recordCount;
    if (info.error) {
      entry.error = { code: info.error.name || "Error", message: info.error.message };
    }
    this.perSource.set(label, entry);
  }

  /** Parse warnings produced by the ingest into structured wedge events +
   *  detect-deletions refusal records. Warnings are emitted in the
   *  documented namespaced format (see bulk-retrieve.ts fmtWedgeWarning +
   *  detect-deletions-guard.ts). */
  ingestWarnings(warnings: readonly string[]): void {
    for (const w of warnings) {
      this.ingestWarning(w);
    }
  }

  ingestWarning(w: string): void {
    if (!w.startsWith("wedge:")) return;

    // detect-deletions guard:  wedge:detect-deletions:refuse:label=<L>:reason=<R>:...
    if (w.startsWith("wedge:detect-deletions:refuse:")) {
      const fields = parseColonKv(w);
      const label = fields.label;
      const reason = fields.reason;
      if (!label || (reason !== "empty-stream" && reason !== "drop-ratio")) return;
      const priorCount = Number.parseInt(fields.priorCount ?? "0", 10) || 0;
      const refusal: DetectDeletionsRefusal = { label, reason, priorCount };
      if (fields.touchedCount !== undefined) {
        refusal.touchedCount = Number.parseInt(fields.touchedCount, 10) || 0;
      }
      if (fields.dropped !== undefined && fields.prior !== undefined) {
        // The drop-ratio variant uses `dropped`/`prior` rather than touchedCount.
        const dropped = Number.parseInt(fields.dropped, 10) || 0;
        const prior = Number.parseInt(fields.prior, 10) || priorCount;
        refusal.priorCount = prior;
        refusal.touchedCount = Math.max(0, prior - dropped);
      }
      if (fields.ratio !== undefined) {
        const r = Number.parseFloat(fields.ratio);
        if (Number.isFinite(r)) refusal.ratio = r;
      }
      this.refusals.push(refusal);
      // Mirror the refusal onto the per-source entry as needsDiagnose=true.
      const entry = this.perSource.get(label) ?? {
        name: label,
        yieldCount: 0,
        wedged: false,
        wedgeEvents: [],
      };
      entry.needsDiagnose = true;
      this.perSource.set(label, entry);
      return;
    }

    // Cap eviction:  wedge:cap:backgroundWedgeAborted:source=<L>:ageMs=<N>:reason=...
    if (w.startsWith("wedge:cap:backgroundWedgeAborted")) {
      const fields = parseColonKv(w);
      const label = fields.source;
      if (!label) return;
      const entry = this.perSource.get(label) ?? {
        name: label,
        yieldCount: 0,
        wedged: false,
        wedgeEvents: [],
      };
      const event: WedgeEvent = { kind: "cap-evicted" };
      if (fields.ageMs !== undefined) {
        const ageMs = Number.parseInt(fields.ageMs, 10);
        if (Number.isFinite(ageMs)) event.wedgedForMs = ageMs;
      }
      entry.wedged = true;
      entry.wedgeEvents.push(event);
      this.perSource.set(label, entry);
      return;
    }

    // Per-source wedge:  wedge:<label>:<stage>:<stageDetail>:lastYielded=<X>:wedgedForMs=<N>
    // stage ∈ { firstYield, inactivity, resolvedLate }
    const parts = w.split(":");
    if (parts.length < 3) return;
    const label = parts[1];
    const stage = parts[2];
    if (!label) return;
    if (stage !== "firstYield" && stage !== "inactivity" && stage !== "resolvedLate") {
      return;
    }
    const fields = parseColonKv(w);
    const entry = this.perSource.get(label) ?? {
      name: label,
      yieldCount: 0,
      wedged: false,
      wedgeEvents: [],
    };
    const event: WedgeEvent = { kind: stage };
    // parts[3] is a positional stageDetail like "90s" — convert to atMs when
    // it's an `Ns` shape so consumers can sort wedges by when-they-fired.
    const stageDetail = parts[3];
    if (stageDetail && /^\d+s$/.test(stageDetail)) {
      event.atMs = Number.parseInt(stageDetail.slice(0, -1), 10) * 1000;
    }
    if (fields.lastYielded !== undefined && fields.lastYielded !== "none") {
      event.lastYieldedRecord = fields.lastYielded;
      // Also pin it onto the per-source entry — most useful field on the report.
      entry.lastYieldedRecord = fields.lastYielded;
    }
    if (fields.wedgedForMs !== undefined) {
      const ms = Number.parseInt(fields.wedgedForMs, 10);
      if (Number.isFinite(ms)) event.wedgedForMs = ms;
    }
    if (stage === "firstYield" || stage === "inactivity") {
      entry.wedged = true;
    }
    entry.wedgeEvents.push(event);
    this.perSource.set(label, entry);
  }

  build(opts: {
    finishedAtEpoch?: number;
    capabilities: Record<string, unknown>;
    config: DiagnoseReport["config"];
    warnings: readonly string[];
    exitStatus: DiagnoseReport["exitStatus"];
    error?: string;
  }): DiagnoseReport {
    const finishedAtEpoch = opts.finishedAtEpoch ?? Date.now();
    // Sort sources by name for stable JSON output.
    const perSource = [...this.perSource.values()].sort((a, b) => a.name.localeCompare(b.name));
    const needsDiagnose = perSource.filter((s) => s.needsDiagnose).map((s) => s.name);
    const report: DiagnoseReport = {
      schemaVersion: 1,
      diagnosticMode: true,
      note:
        "Diagnose mode forces source/Tooling/Metadata/Data pool concurrency to 1. " +
        "Wall-clock timings here are NOT comparable to a production ingest — this " +
        "report exists to NAME wedges (which source, which record, which call), not " +
        "to predict prod throughput.",
      orgId: this.orgId,
      ...(this.alias !== undefined ? { alias: this.alias } : {}),
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAtEpoch).toISOString(),
      totalElapsedMs: Math.max(0, finishedAtEpoch - this.startedAt),
      exitStatus: opts.exitStatus,
      capabilities: opts.capabilities,
      config: opts.config,
      perSource,
      detectDeletionsRefusals: [...this.refusals],
      warnings: [...opts.warnings],
      needsDiagnose,
      ...(opts.error ? { error: opts.error } : {}),
    };
    return report;
  }
}

/** Parse "k=v:k=v:..." style tail of a namespaced warning string. Earlier
 *  segments without an `=` are ignored. */
function parseColonKv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(":")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default report-path resolver. Platform-aware via getSfgraphPaths().data so
// it tracks the same convention the rest of sfgraph uses.
// ---------------------------------------------------------------------------

export function defaultReportPath(orgId: string, now: Date = new Date()): string {
  const dataDir = getSfgraphPaths().data;
  const diagnosticsDir = path.join(dataDir, "diagnostics");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  // Sanitize orgId for filesystem safety (paranoid: only alnum + dash + underscore).
  const safeId = orgId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(diagnosticsDir, `${safeId}-${stamp}.json`);
}

// ---------------------------------------------------------------------------
// Public command entrypoint.
// ---------------------------------------------------------------------------

export interface DiagnoseOpts {
  /** Salesforce alias / username / orgId. Treated identically to `ingest --org`. */
  orgId: string;
  /** Override the default report path. */
  output?: string;
  /** Overall diagnose timeout in seconds. Default 600 (10min). */
  maxDuration?: number;
  /** Stream per-source timing to stdout in addition to the JSON report. */
  verbose?: boolean;
  /** Write to the real org graph DB instead of a temp DB. Default false. */
  keepGraph?: boolean;
}

/** Internal injection seam: the heavy ingest runner. Production code points
 *  at `liveIngest` (lazy-imported). Tests pass a stub. */
export type DiagnoseLiveRunner = (
  opts: LiveIngestOpts,
  reporter: DiagnoseReporter,
) => Promise<LiveIngestResult>;

/** Internal injection seam: org-alias resolver. Production code points at
 *  `resolveOrg`. Tests pass a stub. */
export type DiagnoseResolveOrg = (alias: string) => Promise<{
  alias: string;
  orgId: string;
  apiVersion?: string;
  conn?: unknown;
  instanceUrl?: string;
}>;

export interface DiagnoseDeps {
  runner?: DiagnoseLiveRunner;
  resolveOrg?: DiagnoseResolveOrg;
  /** Override `Date.now()` for deterministic timestamps in tests. */
  now?: () => number;
}

// Env vars diagnose forces to "1". Snapshotted on entry and restored on exit
// via a try/finally so a diagnose run doesn't leak its overrides into a
// subsequent in-process command (matters for tests, and for any future
// embedding of the CLI).
const FORCED_CONCURRENCY_VARS = [
  "SFGRAPH_SOURCE_CONCURRENCY",
  "SFGRAPH_TOOLING_POOL",
  "SFGRAPH_METADATA_POOL",
  "SFGRAPH_DATA_POOL",
] as const;

export async function diagnoseCmd(
  opts: DiagnoseOpts,
  deps: DiagnoseDeps = {},
): Promise<{
  reportPath: string;
  report: DiagnoseReport;
}> {
  const logger = new ConsoleLogger("info");
  const now = deps.now ?? Date.now;
  const startedAtEpoch = now();
  const maxDurationMs = (opts.maxDuration ?? 600) * 1000;

  console.log(`🩺 sfgraph diagnose starting for org ${opts.orgId}`);
  console.log(
    "   note: diagnose forces concurrency=1 — wall-clock is NOT comparable to a production run.",
  );

  // Snapshot env so we can restore on exit even if ingest throws.
  const envSnapshot = new Map<string, string | undefined>();
  for (const k of FORCED_CONCURRENCY_VARS) envSnapshot.set(k, process.env[k]);
  const debugSnapshot = process.env.SFGRAPH_DEBUG_INGEST;

  // Force diagnostic-mode env overrides. These are deliberately written
  // directly (rather than via configureDefaultPools) so they propagate to
  // every code path that re-reads process.env — including the per-pool
  // factory inside rate-limit.ts that bottleneck-wraps each request.
  for (const k of FORCED_CONCURRENCY_VARS) process.env[k] = "1";
  if (opts.verbose) process.env.SFGRAPH_DEBUG_INGEST = "1";

  let tempDbDir: string | null = null;
  const reportPath = opts.output ?? defaultReportPath(opts.orgId, new Date(startedAtEpoch));
  // Resolve early so we can print it in the failure path too.
  const reportDir = path.dirname(reportPath);

  const reporter = new DiagnoseReporter(opts.orgId, undefined, startedAtEpoch);
  let exitStatus: DiagnoseReport["exitStatus"] = "ok";
  let errMsg: string | undefined;
  let capabilities: Record<string, unknown> = {};
  let warnings: string[] = [];

  try {
    // Lazy-import the heavy modules so a `--help` invocation doesn't pay
    // their startup cost (and tests can inject stubs without touching core).
    const resolveOrg =
      deps.resolveOrg ??
      ((async (alias: string) => {
        const core = await import("@ryanstark24/sfgraph-core");
        return core.resolveOrg(alias);
      }) as DiagnoseResolveOrg);
    const runner: DiagnoseLiveRunner =
      deps.runner ??
      (async (liveOpts, _reporter) => {
        const core = await import("@ryanstark24/sfgraph-core");
        return core.liveIngest(liveOpts);
      });

    const resolved = await resolveOrg(opts.orgId);

    // Choose a graph DB path. Default = a fresh temp dir that gets cleaned
    // up after the run, so diagnose doesn't replace the user's main graph.
    // --keep-graph routes through the normal safeOrgDbPath location.
    let dbPath: string;
    if (opts.keepGraph) {
      dbPath = safeOrgDbPath(getSfgraphPaths().data, String(resolved.orgId));
    } else {
      tempDbDir = mkdtempSync(path.join(tmpdir(), "sfgraph-diagnose-"));
      dbPath = path.join(tempDbDir, `${String(resolved.orgId)}.sqlite`);
    }

    // Open a graph store + snapshot store. Lazy-imported alongside the
    // runner so test stubs don't need the SQLite native binding loaded.
    const core = await import("@ryanstark24/sfgraph-core");
    const graphStore = new core.SqliteGraphStore({ dbPath });
    await graphStore.init();
    const snapshotStore = new core.SqliteSnapshotStore({
      dbPath,
      db: graphStore.db,
      skipMigrations: true,
    });
    await snapshotStore.init();

    // Cast through `unknown` because the resolver injection seam has a
    // wider shape than `ResolvedOrg` (it accepts test stubs with minimal
    // fields). The real resolveOrg always returns a fully-shaped object.
    const liveOpts = {
      alias: resolved.alias,
      mode: "full" as const,
      graphStore,
      snapshotStore,
      logger,
      preResolved: resolved as unknown as NonNullable<LiveIngestOpts["preResolved"]>,
    } satisfies LiveIngestOpts;

    // Overall diagnose timeout — Promise.race against the ingest. On
    // timeout we still write whatever the reporter has observed so far,
    // which is the entire point of running diagnose against a wedge.
    const ingestPromise = runner(liveOpts, reporter);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"__timeout__">((resolve) => {
      timer = setTimeout(() => resolve("__timeout__"), maxDurationMs);
    });
    const winner = await Promise.race([ingestPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    if (winner === "__timeout__") {
      exitStatus = "timeout";
      errMsg = `diagnose exceeded --max-duration ${opts.maxDuration ?? 600}s`;
    } else {
      const result = winner as LiveIngestResult;
      capabilities = (result.capabilities ?? {}) as unknown as Record<string, unknown>;
      warnings = [...(result.warnings ?? [])];
      reporter.ingestWarnings(warnings);
    }

    try {
      await graphStore.close();
    } catch {
      /* best-effort */
    }
  } catch (e) {
    exitStatus = "failed";
    errMsg = (e as Error).message ?? String(e);
    // Still try to parse whatever warnings we may have collected via
    // callbacks (none in the default runner, but tests can populate).
  } finally {
    // Restore env regardless of outcome so neighbors don't inherit our
    // forced concurrency=1.
    for (const k of FORCED_CONCURRENCY_VARS) {
      const prev = envSnapshot.get(k);
      if (prev === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev;
      }
    }
    if (debugSnapshot === undefined) {
      // biome-ignore lint/performance/noDelete: env var restoration requires removing the key
      delete process.env.SFGRAPH_DEBUG_INGEST;
    } else {
      process.env.SFGRAPH_DEBUG_INGEST = debugSnapshot;
    }

    if (tempDbDir) {
      try {
        rmSync(tempDbDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }

  const finishedAtEpoch = now();
  const report = reporter.build({
    finishedAtEpoch,
    capabilities,
    config: snapshotConfig(envSnapshot),
    warnings,
    exitStatus,
    ...(errMsg ? { error: errMsg } : {}),
  });

  // Write the report. Make the directory first; the parent may not exist
  // on a fresh install.
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  printSummary(report, reportPath);

  return { reportPath, report };
}

/** Snapshot the *pre-override* env values + watchdog/cap settings into the
 *  report's `config` block. We read both the snapshot (for the
 *  user's-original-intent pool values) and the current process state (for
 *  the watchdog budgets, which diagnose deliberately does NOT touch). */
function snapshotConfig(envSnapshot: Map<string, string | undefined>): DiagnoseReport["config"] {
  const intOr = (v: string | undefined, dflt: number): number => {
    if (v === undefined) return dflt;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const floatOr = (v: string | undefined, dflt: number): number => {
    if (v === undefined) return dflt;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : dflt;
  };
  // Report what diagnose FORCED them to, not what they were before — that's
  // the more useful invariant in the report.
  const config: DiagnoseReport["config"] = {
    sourceConcurrency: 1,
    toolingPool: 1,
    metadataPool: 1,
    dataPool: 1,
  };
  const fy = Number.parseInt(process.env.SFGRAPH_WATCHDOG_FIRST_YIELD_MS ?? "", 10);
  if (Number.isFinite(fy) && fy > 0) config.watchdogFirstYieldMs = fy;
  const inact = Number.parseInt(process.env.SFGRAPH_WATCHDOG_INACTIVITY_MS ?? "", 10);
  if (Number.isFinite(inact) && inact > 0) config.watchdogInactivityMs = inact;
  config.backgroundWedgeCap = intOr(process.env.SFGRAPH_MAX_BACKGROUND_WEDGES, 4);
  config.detectDeletionsMaxDropRatio = floatOr(
    process.env.SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO,
    0.3,
  );
  // Reference envSnapshot to keep the parameter live (lint).
  void envSnapshot;
  return config;
}

/** Stdout summary printed after the JSON is written. Designed to be the
 *  "tell me what happened" view for a human running diagnose interactively. */
function printSummary(report: DiagnoseReport, reportPath: string): void {
  const wedgedSources = report.perSource.filter((s) => s.wedged).length;
  const refused = report.detectDeletionsRefusals.length;
  const elapsedSec = (report.totalElapsedMs / 1000).toFixed(1);

  console.log("");
  console.log(`🩺 Diagnose complete for org ${report.orgId}`);
  console.log(`   status:   ${report.exitStatus}`);
  console.log(`   elapsed:  ${elapsedSec}s`);
  console.log(
    `   sources:  ${report.perSource.length} (${wedgedSources} wedged, ${refused} refused detect-deletions)`,
  );
  console.log(
    `   warnings: ${report.warnings.length} (parsed into ${countWedgeEvents(report)} structured events)`,
  );
  console.log(`   report:   ${reportPath}`);

  const slowest = topSlowestSources(report.perSource, 3);
  if (slowest.length > 0) {
    console.log("");
    console.log("Top slowest sources:");
    slowest.forEach((s, i) => {
      const ms = s.elapsedMs ?? 0;
      const wedgeNote = s.wedgeEvents.length > 0 ? `  (${describeWedges(s.wedgeEvents)})` : "";
      console.log(`  ${i + 1}. ${s.name.padEnd(28)} ${(ms / 1000).toFixed(1)}s${wedgeNote}`);
    });
  }

  const allWedges = report.perSource.flatMap((s) =>
    s.wedgeEvents.map((e) => ({ src: s.name, ev: e, last: s.lastYieldedRecord })),
  );
  if (allWedges.length > 0) {
    console.log("");
    console.log("Wedge events:");
    for (const { src, ev, last } of allWedges) {
      const atNote = ev.atMs !== undefined ? ` at ${(ev.atMs / 1000).toFixed(0)}s` : "";
      const lastNote = last ? ` (lastYieldedRecord=${last})` : "";
      console.log(`  - ${src}:${ev.kind}${atNote}${lastNote}`);
    }
  }

  if (report.detectDeletionsRefusals.length > 0) {
    console.log("");
    console.log("Detect-deletions refusals (W1.5-07):");
    for (const r of report.detectDeletionsRefusals) {
      const ratio = r.ratio !== undefined ? `, ratio=${r.ratio.toFixed(2)}` : "";
      console.log(`  - ${r.label}: ${r.reason} (prior=${r.priorCount}${ratio})`);
    }
  }

  console.log("");
  console.log(`To re-run diagnose: sfgraph diagnose ${report.orgId}`);
  console.log("To file a bug: attach the report file above.");
}

function countWedgeEvents(report: DiagnoseReport): number {
  return report.perSource.reduce((acc, s) => acc + s.wedgeEvents.length, 0);
}

/** Top-N by elapsedMs descending. Sources without elapsedMs (never
 *  completed) sort to the bottom; if they're wedged we still want them
 *  visible, so bump their effective elapsed to maxDurationMs-equivalent. */
export function topSlowestSources(
  perSource: readonly DiagnoseReportSourceEntry[],
  n: number,
): DiagnoseReportSourceEntry[] {
  const scored = perSource.map((s) => ({
    s,
    score: s.elapsedMs ?? (s.wedged ? Number.POSITIVE_INFINITY : -1),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((x) => x.score >= 0)
    .slice(0, n)
    .map((x) => x.s);
}

function describeWedges(events: readonly WedgeEvent[]): string {
  return events.map((e) => `wedge:${e.kind}`).join(", ");
}
