import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { RawMember } from "../interfaces/metadata-source.js";
import type { OrgCapabilities } from "./capabilities.js";
import { discoverMetadataTypes } from "./discovery.js";
import { buildDispatchTable } from "./dispatch.js";
import { iterApex } from "./extractors/apex.js";
import { iterFlow } from "./extractors/flow.js";
import { iterGenericMetadata } from "./extractors/generic-metadata.js";
import { iterIntegration } from "./extractors/integration.js";
import { iterLwc } from "./extractors/lwc.js";
import { iterObject } from "./extractors/object.js";
import { iterOmnistudio } from "./extractors/omnistudio.js";
import { iterSecurity } from "./extractors/security.js";
import { iterVlocity } from "./extractors/vlocity.js";

/** Aggregate of every source that errored during a bulkRetrieve run.
 *  bulkRetrieve mutates this in-place via onError; live-ingest reads it at
 *  end of run to print a consolidated summary instead of warning per-source
 *  in the middle of progress output. */
export interface IngestSkipReport {
  skips: Array<{ label: string; reason: string; category: SkipCategory }>;
}

/**
 * Phase 1.5 (W1.5-02): soft-isolate wedge coordination state.
 *
 * Threaded through the bulkRetrieve fan-out so `failSoft` wrappers can:
 *   (a) push namespaced-string warnings into a shared sink (the warnings
 *       eventually surface on LiveIngestResult.warnings),
 *   (b) park the still-pending iterator from a wedged source into a bounded
 *       background-wedge set (the merger's slot is released immediately,
 *       so queued neighbors can proceed),
 *   (c) yield late-arriving records from those background iterators with
 *       `attributes.lateYield = true` so they still reach the output stream.
 *
 * One coordinator instance per bulkRetrieve invocation. Default sourced
 * from `SFGRAPH_MAX_BACKGROUND_WEDGES` (default 4).
 */
export interface BackgroundWedgeEntry {
  label: string;
  /** Iterator that was wedged. Used by the late-drain loop to keep pumping
   *  it after slot release. */
  iterator: AsyncIterator<RawMember>;
  /**
   * The in-flight `it.next()` promise that was racing the watchdog at the
   * moment the watchdog won. Async-generator semantics queue concurrent
   * `.next()` calls — so if the drain loop calls `iterator.next()` while
   * this promise is still pending, the drain will wait behind it AND
   * "lose" the value it eventually resolves with (the first `.next()` gets
   * it, then the drain's `.next()` advances to the NEXT yield). We must
   * therefore consume this promise BEFORE calling `iterator.next()` again
   * in the drain loop. After the drain consumes the first pending result,
   * this field is set to null and subsequent calls go through the normal
   * `iterator.next()` path.
   */
  pendingFirstNext: Promise<IteratorResult<RawMember>> | null;
  /** Wall-clock epoch when this entry was registered (post slot-release). */
  registeredAt: number;
  /** Set true when the cap-eviction policy decides this wedge has outlived
   *  its budget. The drain loop checks this each iteration and bails. The
   *  pending HTTP request (if any) is NOT actively cancelled — that's the
   *  job of W1.5-03. */
  stopWaitingRef: { value: boolean };
}

export interface WedgeCoordinator {
  /** Shared namespaced-warning sink. Format documented in PLAN.md:
   *  `wedge:<source>:<stage>:<detail>`. The warning strings reach the
   *  surface via `bulkRetrieve` opts → `LiveIngestResult.warnings`. */
  warnings: string[];
  /** Active background-wedge set. Bounded by `maxBackgroundWedges`. When
   *  a new wedge would exceed the cap, the OLDEST entry gets its
   *  `stopWaitingRef.value = true` flag set + a `backgroundWedgeAborted`
   *  warning is emitted. The old iterator is NOT removed from the set —
   *  the late-drain loop sees the flag and bails. */
  backgroundWedges: BackgroundWedgeEntry[];
  /** Maximum simultaneous active background wedges. From
   *  `SFGRAPH_MAX_BACKGROUND_WEDGES`, default 4. */
  maxBackgroundWedges: number;
  /** Bounded wall-clock budget for the post-merger late-drain pass. The
   *  drain races each pending `it.next()` against this budget; whatever
   *  arrives gets `attributes.lateYield = true`. Default 60 000ms; set to
   *  0 to disable late-drain entirely (used by some tests). */
  lateDrainBudgetMs: number;
}

function createWedgeCoordinator(
  warnings: string[] = [],
  overrides?: Partial<Pick<WedgeCoordinator, "maxBackgroundWedges" | "lateDrainBudgetMs">>,
): WedgeCoordinator {
  const capEnv = Number.parseInt(process.env.SFGRAPH_MAX_BACKGROUND_WEDGES ?? "", 10);
  const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : 4;
  const drainEnv = Number.parseInt(process.env.SFGRAPH_LATE_DRAIN_BUDGET_MS ?? "", 10);
  const drain = Number.isFinite(drainEnv) && drainEnv >= 0 ? drainEnv : 60_000;
  return {
    warnings,
    backgroundWedges: [],
    maxBackgroundWedges: overrides?.maxBackgroundWedges ?? cap,
    lateDrainBudgetMs: overrides?.lateDrainBudgetMs ?? drain,
  };
}

export type SkipCategory =
  | "insufficient_access"
  | "not_found"
  | "rate_limit"
  | "network"
  | "unknown";

/** Best-effort classification so the end-of-run recommendation is targeted. */
function classifySkip(msg: string): SkipCategory {
  const m = msg.toUpperCase();
  if (m.includes("INSUFFICIENT_ACCESS") || m.includes("INSUFFICIENT") || m.includes("FORBIDDEN")) {
    return "insufficient_access";
  }
  if (m.includes("NOT_FOUND") || m.includes("INVALID_TYPE")) return "not_found";
  if (m.includes("REQUEST_LIMIT_EXCEEDED") || m.includes("RATE_LIMIT")) return "rate_limit";
  if (m.includes("ECONNREFUSED") || m.includes("ENOTFOUND") || m.includes("ETIMEDOUT")) {
    return "network";
  }
  return "unknown";
}

/** Naive sequential merge — predictable order, simpler back-pressure semantics.
 *  Kept for back-compat and tests; production ingest uses
 *  {@link mergeAsyncIterablesParallel} so different pools (Tooling/Metadata/
 *  Data) can saturate simultaneously instead of one extractor at a time. */
export async function* mergeAsyncIterables<T>(...iters: Array<AsyncIterable<T>>): AsyncIterable<T> {
  for (const it of iters) {
    for await (const v of it) yield v;
  }
}

/**
 * Sliding-window parallel merge. Keeps exactly `concurrency` iterators
 * live at any moment — when one completes (done:true), the next queued
 * iterator is started in its slot. Within the window, iterators race via
 * `Promise.race` for max throughput.
 *
 * Replaces the previous wave-based merger, which had a synchronisation
 * barrier at each wave boundary: all 6 iterators in a wave had to finish
 * before any of wave 2 could start. One hung source (very common for
 * `generic:Layout` on managed-package-heavy orgs) parked the whole wave
 * indefinitely with zero observable progress.
 *
 * Default concurrency = 8: enough to saturate the three rate-limit pools
 * (Tooling 5 / Metadata 5 / Data 10) with headroom for one slot to be
 * blocked on a slow source without starving the others. Override via
 * `SFGRAPH_SOURCE_CONCURRENCY=<n>` (1 = strictly sequential).
 *
 * Output ordering is non-deterministic. `live-ingest`'s processOne is
 * order-independent (idempotent per-record upserts), so this is safe.
 */
export interface MergeParallelOptions {
  /** Override the sliding-window size for this call. When omitted, the
   *  env-var / default path applies as before. Used by unit tests that
   *  need deterministic queue-vs-active ordering. */
  concurrency?: number;
}

export function mergeAsyncIterablesParallel<T>(...iters: Array<AsyncIterable<T>>): AsyncIterable<T>;
export function mergeAsyncIterablesParallel<T>(
  iters: Array<AsyncIterable<T>>,
  opts: MergeParallelOptions,
): AsyncIterable<T>;
export function mergeAsyncIterablesParallel<T>(...args: unknown[]): AsyncIterable<T> {
  // Disambiguate the two overloads. The 2-arg array+opts form is used by
  // tests; the rest-args form is the production fan-out path.
  let iters: Array<AsyncIterable<T>>;
  let opts: MergeParallelOptions | undefined;
  if (
    args.length === 2 &&
    Array.isArray(args[0]) &&
    args[1] != null &&
    typeof args[1] === "object" &&
    !((args[1] as object) instanceof Promise) &&
    !(Symbol.asyncIterator in (args[1] as object))
  ) {
    iters = args[0] as Array<AsyncIterable<T>>;
    opts = args[1] as MergeParallelOptions;
  } else {
    iters = args as Array<AsyncIterable<T>>;
    opts = undefined;
  }
  return mergeAsyncIterablesParallelImpl(iters, opts);
}

async function* mergeAsyncIterablesParallelImpl<T>(
  iters: Array<AsyncIterable<T>>,
  opts?: MergeParallelOptions,
): AsyncIterable<T> {
  const envConcurrency = Number.parseInt(process.env.SFGRAPH_SOURCE_CONCURRENCY ?? "", 10);
  // Raised 8 -> 12: a wider window lets Tooling-backed sources (apex, lwc)
  // start immediately rather than wait behind the cohort of metadata-pool
  // sources (security, flow, integration, generic:Layout/Workflow/etc.)
  // which spend most of their time queued in Bottleneck. Per-pool concurrency
  // still caps total HTTP fan-out, so this only opens up parallelism that
  // was being throttled at the wrong layer.
  const concurrency =
    opts?.concurrency != null && opts.concurrency > 0
      ? opts.concurrency
      : Number.isFinite(envConcurrency) && envConcurrency > 0
        ? envConcurrency
        : 12;
  const iterators = iters.map((it) => it[Symbol.asyncIterator]());
  type Tagged = Promise<{ idx: number; result: IteratorResult<T> }>;
  const pending = new Map<number, Tagged>();
  let nextIterIdx = 0;
  const advance = (idx: number): void => {
    const it = iterators[idx];
    if (!it) return;
    pending.set(
      idx,
      it.next().then(
        (result) => ({ idx, result }),
        // Per-iter rejections are handled by the failSoft() wrapper one
        // level up. Anything that reaches here is unexpected; mark the
        // iter done so the outer race makes forward progress.
        () => ({
          idx,
          result: { value: undefined as unknown as T, done: true } as IteratorResult<T>,
        }),
      ),
    );
  };
  // Prime the window with the first `concurrency` iterators.
  while (pending.size < concurrency && nextIterIdx < iterators.length) {
    advance(nextIterIdx++);
  }
  while (pending.size > 0) {
    const { idx, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(idx);
      // A slot opened — start the next queued iterator immediately. A slow
      // / hung source still holds its slot, but its peers keep advancing.
      if (nextIterIdx < iterators.length) advance(nextIterIdx++);
      continue;
    }
    yield result.value;
    advance(idx);
  }
}

/**
 * Per-source watchdog budgets. Centralized here so the failSoft wrapper and
 * tests share the same constants.
 *
 * Phase 1.5 W1.5-01 contract: these are the budgets the watchdog uses, but
 * the clock against which they measure starts at slot-acquisition time
 * (i.e., on the FIRST `it.next()` call inside `failSoft`'s body), NOT at
 * source registration. Queued-but-not-yet-executing sources accumulate
 * ZERO clock time, so a wedge in one source can no longer cascade-kill
 * its queued neighbors.
 *
 * Anti-feature reminder: do NOT raise these to "fix" a real wedge. The
 * correct fix is per-source override (W1.5-future) or fixing the underlying
 * pre-yield setup call. See `.planning/phase-1.5/PLAN.md` anti-features.
 */
const WATCHDOG_INACTIVITY_MS_DEFAULT = 5 * 60_000;
const WATCHDOG_FIRST_YIELD_MS_DEFAULT = 90_000;

/** Read watchdog budgets per-call so unit tests can override via env vars
 *  without restarting the process. Production env should leave these unset
 *  (they default to the documented 90s first-yield / 5min inactivity). */
function readWatchdogBudgets(): { firstYieldMs: number; inactivityMs: number } {
  const fy = Number.parseInt(process.env.SFGRAPH_WATCHDOG_FIRST_YIELD_MS ?? "", 10);
  const inact = Number.parseInt(process.env.SFGRAPH_WATCHDOG_INACTIVITY_MS ?? "", 10);
  return {
    firstYieldMs: Number.isFinite(fy) && fy > 0 ? fy : WATCHDOG_FIRST_YIELD_MS_DEFAULT,
    inactivityMs: Number.isFinite(inact) && inact > 0 ? inact : WATCHDOG_INACTIVITY_MS_DEFAULT,
  };
}

/** Build the namespaced wedge warning string per the schema documented in
 *  PLAN.md (`wedge:<source>:<stage>:<detail>`). Centralized here so the
 *  format is stable across emit sites + grep-friendly. */
function fmtWedgeWarning(
  source: string,
  stage: string,
  detail: Record<string, string | number>,
): string {
  const parts: string[] = [`wedge:${source}:${stage}`];
  for (const [k, v] of Object.entries(detail)) {
    parts.push(`${k}=${v}`);
  }
  return parts.join(":");
}

/**
 * Enforce the background-wedge cap. When admitting a new entry would push
 * the count above `maxBackgroundWedges`, mark the OLDEST entries' stop-
 * waiting flags so their drain loops bail at the next iteration. Emits a
 * `wedge:cap:backgroundWedgeAborted:...` warning per evicted entry. The
 * iterator object itself is left in the set; the late-drain loop is what
 * sees the flag and skips it. (We do NOT remove from `backgroundWedges`
 * here so post-merger inspection still sees every wedge that ever fired
 * during the run.)
 */
function enforceBackgroundWedgeCap(coordinator: WedgeCoordinator): void {
  const active = coordinator.backgroundWedges.filter((e) => !e.stopWaitingRef.value);
  const overage = active.length - coordinator.maxBackgroundWedges;
  if (overage <= 0) return;
  // Sort by registeredAt ascending; oldest first.
  active.sort((a, b) => a.registeredAt - b.registeredAt);
  for (let i = 0; i < overage; i += 1) {
    const victim = active[i];
    if (!victim) continue;
    victim.stopWaitingRef.value = true;
    const ageMs = Date.now() - victim.registeredAt;
    coordinator.warnings.push(
      fmtWedgeWarning("cap", "backgroundWedgeAborted", {
        source: victim.label,
        ageMs,
        reason: "backgroundWedgeCapExceeded",
      }),
    );
  }
}

/**
 * Drain a single background-wedge iterator. Called once per wedged source,
 * post-merger, with a wall-clock budget. Each iteration races the iterator's
 * `it.next()` against the remaining budget. Records arriving inside the
 * budget are yielded with `attributes.lateYield = true`. The pending HTTP
 * request (if the wedge is on a network call) is NOT actively cancelled
 * (W1.5-03's job); we just stop awaiting it.
 *
 * Bails immediately if `stopWaitingRef.value === true` (cap eviction).
 */
async function* drainBackgroundWedge(
  entry: BackgroundWedgeEntry,
  budgetMs: number,
  warnings: string[],
): AsyncIterable<RawMember> {
  const debug = process.env.SFGRAPH_DEBUG_INGEST === "1";
  const startedAt = Date.now();
  let lateCount = 0;
  while (!entry.stopWaitingRef.value) {
    const remaining = startedAt + budgetMs - Date.now();
    if (remaining <= 0) break;
    // First iteration: consume the abandoned-but-still-pending `it.next()`
    // promise from when the watchdog fired. Subsequent iterations call
    // `iterator.next()` normally. Async-generator semantics queue
    // concurrent `.next()` calls, so we MUST consume the pending one
    // before issuing a new one — otherwise the late-yielded value goes
    // to the abandoned promise and the drain sees the NEXT yield (or
    // `done:true` if the generator is single-yield).
    const nextPromise =
      entry.pendingFirstNext !== null ? entry.pendingFirstNext : entry.iterator.next();
    if (entry.pendingFirstNext !== null) entry.pendingFirstNext = null;
    let next: IteratorResult<RawMember>;
    try {
      next = await Promise.race([
        nextPromise,
        new Promise<IteratorResult<RawMember>>((resolve) => {
          setTimeout(
            // Resolve (not reject) with a synthetic done sentinel — bailing
            // is the normal exit path from a budget-exceeded drain, not an
            // error condition.
            () => resolve({ value: undefined as unknown as RawMember, done: true }),
            remaining,
          );
        }),
      ]);
    } catch (e) {
      // Late-arriving error from the wedged iterator. Don't crash the drain;
      // surface as a warning and stop.
      const err = (e as Error)?.message ?? String(e);
      warnings.push(fmtWedgeWarning(entry.label, "lateError", { error: err.slice(0, 120) }));
      break;
    }
    if (next.done) break;
    lateCount += 1;
    const rec = next.value as RawMember;
    // Tag with lateYield so downstream consumers / tests can identify the
    // record as having arrived after slot release.
    const tagged: RawMember = {
      ...rec,
      attributes: { ...(rec.attributes ?? {}), lateYield: true },
    };
    yield tagged;
  }
  if (lateCount > 0) {
    const totalMs = Date.now() - entry.registeredAt;
    warnings.push(
      fmtWedgeWarning(entry.label, "resolvedLate", {
        totalMs,
        records: lateCount,
      }),
    );
  }
  if (debug) {
    console.log(
      `ingest: [debug] ${entry.label} background-wedge drain finished (${lateCount} late records, stopWaiting=${entry.stopWaitingRef.value})`,
    );
  }
}

/**
 * Wrap an iterable so a thrown error is captured + the stream ends cleanly
 * instead of aborting the whole ingest. The error is recorded into a
 * shared skip report (consumed at end-of-run) and a compact ✗ line is
 * printed so the user sees something happened without the full error
 * message scrolling past during the run.
 *
 * Phase 1.5 W1.5-01 + W1.5-02 contract:
 *
 *  - The watchdog clock starts when this generator's BODY first executes
 *    (i.e., when the merger calls `.next()` on us for the first time —
 *    that's slot-acquisition time). Queued sources still inside
 *    `mergeAsyncIterablesParallel`'s waiting list accumulate ZERO clock
 *    time. Implemented via an internal `startedAtRef` that's written once
 *    on body entry; if the caller passes a `startedAtRef` we update it in
 *    place so the merger can observe the slot-acquisition moment.
 *
 *  - On watchdog fire, we DO NOT throw (which would abort the merger's
 *    Promise.race for our slot AND lose the still-pending iterator).
 *    Instead we:
 *       1. Emit a `wedge:<label>:firstYield:90s:...` (or `:inactivity:300s:`)
 *          warning into coordinator.warnings.
 *       2. Register the still-pending iterator into coordinator.background
 *          Wedges with a stopWaitingRef. Enforce the cap (evict oldest).
 *       3. RETURN from the generator. This cleanly releases the merger's
 *          slot — `pending.delete(idx)` runs in mergeAsyncIterablesParallel
 *          and the next queued source acquires the slot.
 *    Post-merger, the bulkRetrieve top-level fan-out drains the background
 *    wedge set; records arriving inside the late-drain budget are yielded
 *    with `attributes.lateYield = true`.
 */
async function* failSoft<T extends RawMember>(
  label: string,
  factory: () => AsyncIterable<T>,
  onError?: (label: string, err: Error) => void,
  coordinator?: WedgeCoordinator,
  /** Optional outer-visible clock cell. The merger does not currently read
   *  this, but the contract is "set by failSoft on body entry"; tests use
   *  it to assert slot-acquisition timing. */
  startedAtRef?: { value: number },
): AsyncIterable<T> {
  const debug = process.env.SFGRAPH_DEBUG_INGEST === "1";
  // W1.5-01: the clock starts HERE — body-entry, which is slot-acquisition
  // time. NOT at failSoft() invocation (that's source registration, which
  // can be hundreds of seconds before the merger picks us out of the queue).
  const startedAt = Date.now();
  if (startedAtRef) startedAtRef.value = startedAt;
  let count = 0;
  let started = false;
  // Track last-yielded qualifiedName for diagnostic warnings — the smoking-
  // gun field that names WHICH record was in flight when the wedge fired.
  let lastYieldedQName = "<none>";
  const { firstYieldMs, inactivityMs } = readWatchdogBudgets();

  const it = factory()[Symbol.asyncIterator]();
  if (debug) console.log(`ingest: [debug] ${label} ← invoked at ${startedAt}`);

  try {
    while (true) {
      const remainingFirstYield = started
        ? Number.POSITIVE_INFINITY
        : startedAt + firstYieldMs - Date.now();
      const watchdogMs = Math.min(inactivityMs, remainingFirstYield);
      const stage: "firstYield" | "inactivity" = started ? "inactivity" : "firstYield";
      const stageDetail = started ? `${inactivityMs / 1000}s` : `${firstYieldMs / 1000}s`;

      const pending = it.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wedged = await Promise.race<
        { wedge: true } | { wedge: false; result: IteratorResult<T> }
      >([
        pending.then((result) => {
          if (timer) clearTimeout(timer);
          return { wedge: false as const, result };
        }),
        new Promise<{ wedge: true }>((resolve) => {
          // watchdogMs may be <=0 if the budget is already burned (defensive
          // — should be rare since the clock starts at body-entry). setTimeout
          // with non-positive delay fires on the next event-loop tick, which
          // is the correct wedge-immediately behavior.
          timer = setTimeout(() => resolve({ wedge: true as const }), Math.max(0, watchdogMs));
        }),
      ]);

      if (wedged.wedge) {
        // Hand off the still-pending it.next() so the drain can consume
        // it directly — see BackgroundWedgeEntry.pendingFirstNext.
        emitWedge(stage, stageDetail, pending as unknown as Promise<IteratorResult<RawMember>>);
        return;
      }
      const next = wedged.result;
      if (next.done) break;
      recordYield(next.value);
      yield next.value;
    }
    if (started) {
      console.log(`ingest:   ${label} ✓ ${count} records (${Date.now() - startedAt}ms)`);
    } else {
      console.log(`ingest:   ${label} ✓ 0 records (${Date.now() - startedAt}ms)`);
    }
  } catch (e) {
    const err = e as Error;
    onError?.(label, err);
    console.log(`ingest:   ${label} ✗ skipped (${err?.message?.slice(0, 80) ?? "unknown"})`);
    if (debug) {
      console.error(`ingest: [debug] ${label} failure detail: ${err?.message ?? String(err)}`);
      if (err?.stack) console.error(err.stack);
    }
  } finally {
    if (debug) {
      console.log(
        `ingest: [debug] ${label} → finalised (${count} records, ${Date.now() - startedAt}ms)`,
      );
    }
  }

  /** Inline helper: extracts qualifiedName-ish text from a RawMember for the
   *  `lastYielded=...` diagnostic field. Safe against undefined. */
  function recordYield(v: T): void {
    if (!started) {
      started = true;
      console.log(`ingest:   ${label} → starting…`);
    }
    count += 1;
    const ref = (v as unknown as RawMember).ref;
    if (ref) {
      lastYieldedQName = `${ref.memberType}/${ref.memberName}`;
    }
  }

  /**
   * Slot-release + soft-isolate on watchdog fire. Two side effects:
   *   1. Push a `wedge:<label>:<stage>:<detail>` warning into the shared sink.
   *   2. Park the still-pending iterator into the background-wedge set so
   *      the post-merger late-drain pass can capture any records that
   *      eventually arrive. Enforce the cap (oldest evicted with a
   *      `backgroundWedgeAborted` warning).
   * The generator then RETURNS (caller is `for await` of the merger; the
   * merger sees `done:true` and releases the slot).
   */
  function emitWedge(
    stage: "firstYield" | "inactivity",
    stageDetail: string,
    pendingFirstNext: Promise<IteratorResult<RawMember>>,
  ): void {
    const wedgedFor = Date.now() - startedAt;
    if (coordinator) {
      // Schema (PLAN.md): `wedge:<label>:<stage>:<stageDetail>:<k=v>:<k=v>`.
      // <stageDetail> is a positional value (e.g. "90s"), not a key=value.
      const w =
        `wedge:${label}:${stage}:${stageDetail}` +
        `:lastYielded=${lastYieldedQName}` +
        `:wedgedForMs=${wedgedFor}`;
      coordinator.warnings.push(w);
      console.log(
        `ingest:   ${label} ⚠ wedged (${stage} ${stageDetail}); slot released, draining in background`,
      );

      const stopWaitingRef = { value: false };
      coordinator.backgroundWedges.push({
        label,
        iterator: it as unknown as AsyncIterator<RawMember>,
        pendingFirstNext,
        registeredAt: Date.now(),
        stopWaitingRef,
      });
      enforceBackgroundWedgeCap(coordinator);
    } else {
      // No coordinator (e.g. unit-test path that didn't wire one up, or
      // back-compat caller): fall back to the old "log+skip" behavior so
      // the caller still gets observable feedback.
      const msg = `source watchdog (${stage} ${stageDetail}): no record yielded — pool jammed or call wedged`;
      onError?.(label, new Error(msg));
      console.log(`ingest:   ${label} ✗ skipped (${msg.slice(0, 80)})`);
    }
  }
}

/** Typed-extractor ownership map: which XML type names a dedicated extractor covers. */
const APEX_TYPES = new Set(["ApexClass", "ApexTrigger"]);
const LWC_TYPES = new Set(["LightningComponentBundle"]);
const FLOW_TYPES = new Set(["Flow"]);
const OBJECT_TYPES = new Set(["CustomObject"]);
const SECURITY_TYPES = new Set(["Profile", "PermissionSet", "SharingRules"]);
const INTEGRATION_TYPES = new Set(["NamedCredential", "ExternalServiceRegistration"]);

/**
 * High-value generic metadata types we'll route to `iterGenericMetadata` by
 * default. Salesforce's `describeMetadata()` returns 400+ types on modern
 * orgs — most of them platform internals, industry-cloud scaffolding,
 * Setup-internal stuff that returns 0 records or has no graph value AND
 * adds queued HTTP requests to Bottleneck (each one a closure + socket
 * state). Scheduling all 400 at once was causing silent process exits
 * post-object-phase on the user's cleanDemoOrg — too many pending
 * metadata.list calls in the metadata pool's queue.
 *
 * This list is curated for "does user code typically reference this?" /
 * "does it carry graph-relevant edges?". Add types to it as you discover
 * value in them. Override via `SFGRAPH_INCLUDE_ALL_GENERIC=1` to invoke
 * every discovered type (useful for industry-cloud-specific ingest).
 */
const GENERIC_TYPE_WHITELIST = new Set([
  // UI / pages — typically referenced from FlexiPages / Lightning App Builder
  "FlexiPage",
  "Layout",
  "QuickAction",
  "CustomTab",
  "CustomApplication",
  "HomePageLayout",
  "CustomPageWebLink",
  "WebLink",
  // Apex / VF surfaces routed here (not in core extractors)
  "ApexPage",
  "ApexComponent",
  "AuraDefinitionBundle",
  // Process automation
  "Workflow",
  "ApprovalProcess",
  "AssignmentRules",
  "AutoResponseRules",
  "EscalationRules",
  "FlowDefinition",
  // Data quality
  "DuplicateRule",
  "MatchingRule",
  // Custom Metadata + labels
  "CustomMetadata",
  "CustomLabels",
  "CustomLabel",
  "GlobalValueSet",
  "StandardValueSet",
  "CustomPermission",
  // Custom Notification + Settings
  "CustomNotificationType",
  "CustomSite",
  // Reports / Dashboards / Analytics
  "Report",
  "Dashboard",
  "ReportType",
  // Networks / Communities
  "Network",
  "NetworkBranding",
  "NavigationMenu",
  "Community",
  "ExperienceBundle",
  "DigitalExperienceBundle",
  // Identity / Access
  // NOTE: Profile, PermissionSet, SharingRules intentionally NOT here —
  // they route to iterSecurity (see SECURITY_TYPES + dispatch below).
  // NamedCredential routes to iterIntegration. Listing them here would be
  // dead today (the dispatch checks SECURITY/INTEGRATION_TYPES first) and
  // a trap if dispatch ordering ever changes.
  "ConnectedApp",
  "PermissionSetGroup",
  "MutingPermissionSet",
  "ProfilePasswordPolicy",
  "ProfileSessionSetting",
  "SamlSsoConfig",
  // Sharing
  "SharingSet",
  "GroupMember",
  // Platform Events / CDC
  "PlatformEventChannel",
  "PlatformEventChannelMember",
  "PlatformEventSubscriberConfig",
  // Integrations
  "RemoteSiteSetting",
  "CspTrustedSite",
  // NamedCredential routes to iterIntegration (see INTEGRATION_TYPES).
  "ExternalCredential",
  // Email
  "EmailTemplate",
  "EmailServicesFunction",
  // Misc commonly-used
  "StaticResource",
  "LightningComponentBundle",
  "LightningMessageChannel",
  "RecordActionDeployment",
  "PathAssistant",
  "GenAiPromptTemplate",
  "GenAiFunction",
  "GenAiPlugin",
  // Bot / Einstein
  "Bot",
  "GenAiPlannerBundle",
  // OmniStudio on-Core — exposed via Metadata API, not SObject SOQL.
  // The on-core SObject (OmniProcess) is the storage backing but real
  // metadata access goes through metadata.list/read of these type names.
  "OmniScript",
  "OmniIntegrationProcedure",
  "OmniDataTransform",
  "OmniUiCard",
  "OmniProcess",
]);

function shouldRouteGeneric(type: string): boolean {
  if (process.env.SFGRAPH_INCLUDE_ALL_GENERIC === "1") return true;
  return GENERIC_TYPE_WHITELIST.has(type);
}

export interface BulkRetrieveOpts {
  skipReport?: IngestSkipReport;
  /** When set, only invoke source labels in this set. Labels are the same
   *  source-keys used by the dispatch table: 'apex', 'lwc', 'flow', 'object',
   *  'security', 'integration', 'vlocity', 'omnistudio', or
   *  'generic:<MetadataType>' for the long tail. */
  onlyLabels?: Set<string>;
  /** Opt-in: invoke the OmniStudio-on-Core retrieve() extractor in addition
   *  to the existing SOQL path. Default off — retrieve() consumes Metadata
   *  API quota (10k/24h) and is slower; only enable when the higher-fidelity
   *  XML envelope is actually needed by a downstream parser. */
  enableOmnistudioRetrieve?: boolean;
  /** API version string for the retrieve() request envelope. */
  apiVersion?: string;
  /**
   * Phase 1.5 W1.5-02 warning sink. When provided, the watchdog soft-isolate
   * path pushes namespaced wedge strings (`wedge:<source>:<stage>:...`) into
   * this array. The caller (live-ingest) concatenates them onto
   * LiveIngestResult.warnings. When omitted, wedge events fall through to
   * the legacy `onSkip` / skipReport path so existing tests still see a
   * skip entry.
   */
  warnings?: string[];
}

export async function* bulkRetrieve(
  conn: any,
  caps: OrgCapabilities,
  orgId: OrgId,
  opts: BulkRetrieveOpts | IngestSkipReport = {},
): AsyncIterable<RawMember> {
  // Back-compat: callers used to pass IngestSkipReport directly as the 4th arg.
  // Accept both shapes.
  const normalized: BulkRetrieveOpts =
    opts && typeof opts === "object" && "skips" in (opts as object)
      ? { skipReport: opts as IngestSkipReport }
      : (opts as BulkRetrieveOpts);
  const skipReport = normalized.skipReport;
  const onlyLabels = normalized.onlyLabels;
  // Phase 1.5 W1.5-02 coordinator. Built only when a warnings sink was
  // supplied — without one, no place to push wedge strings, so the legacy
  // "watchdog fires → skip entry" behavior is preserved. The coordinator
  // owns the background-wedge cap + late-drain budget.
  const coordinator: WedgeCoordinator | undefined = normalized.warnings
    ? createWedgeCoordinator(normalized.warnings)
    : undefined;
  // Discover the type list this org actually supports. If discovery fails or
  // returns nothing usable, fall back to invoking every known extractor —
  // preserves Commit-A behavior for mocks that don't implement describe.
  let types: Awaited<ReturnType<typeof discoverMetadataTypes>> = [];
  try {
    types = await discoverMetadataTypes(conn);
  } catch {
    types = [];
  }

  const sources: Array<AsyncIterable<RawMember>> = [];
  const invoked = new Set<string>(); // source-key dedup

  const onSkip = skipReport
    ? (label: string, err: Error) => {
        const reason = err?.message ?? String(err);
        skipReport.skips.push({ label, reason, category: classifySkip(reason) });
      }
    : undefined;

  const invoke = (key: string, factory: () => AsyncIterable<RawMember>) => {
    if (invoked.has(key)) return;
    invoked.add(key);
    // --only filter: when onlyLabels is set, skip any source not in the set.
    // Filter applies to the exact source key ('apex', 'generic:Profile', etc.)
    // for precise targeting of retry/partial-refresh flows.
    if (onlyLabels && !onlyLabels.has(key)) return;
    // Each source is wrapped fail-soft so one failing type (e.g. a metadata
    // category the user's profile lacks access to) doesn't abort the whole
    // ingest. The wrapper records the source label + error into skipReport
    // (consumed at end of run for a consolidated summary) and ends the
    // stream cleanly.
    sources.push(failSoft(key, factory, onSkip, coordinator));
  };

  if (types.length === 0) {
    // Discovery unavailable: invoke every dedicated extractor once.
    invoke("apex", () => iterApex(conn));
    invoke("lwc", () => iterLwc(conn));
    invoke("flow", () => iterFlow(conn));
    invoke("object", () => iterObject(conn));
    invoke("security", () => iterSecurity(conn));
    invoke("integration", () => iterIntegration(conn));
  } else {
    const dispatch = buildDispatchTable(types, caps);
    let routedGeneric = 0;
    let skippedGeneric = 0;
    for (const [type, route] of dispatch.entries()) {
      switch (route.strategy) {
        case "toolingSoql":
          if (APEX_TYPES.has(type)) invoke("apex", () => iterApex(conn));
          else if (LWC_TYPES.has(type)) invoke("lwc", () => iterLwc(conn));
          else if (shouldRouteGeneric(type)) {
            routedGeneric += 1;
            invoke(`generic:${type}`, () => iterGenericMetadata(conn, String(orgId), type));
          } else {
            skippedGeneric += 1;
          }
          break;
        case "metadataReadList":
          if (FLOW_TYPES.has(type)) invoke("flow", () => iterFlow(conn));
          else if (OBJECT_TYPES.has(type)) invoke("object", () => iterObject(conn));
          else if (SECURITY_TYPES.has(type)) invoke("security", () => iterSecurity(conn));
          else if (INTEGRATION_TYPES.has(type)) invoke("integration", () => iterIntegration(conn));
          else if (shouldRouteGeneric(type)) {
            routedGeneric += 1;
            invoke(`generic:${type}`, () => iterGenericMetadata(conn, String(orgId), type));
          } else {
            skippedGeneric += 1;
          }
          break;
        case "vlocityRunner":
          // Single invocation handled below.
          break;
        case "sobjectSoql":
          // Reserved for future CMDT/etc. — none routed here in Commit B.
          break;
        case "genericOpaque":
          // No-op for now: we don't pollute the graph with sentinel-only nodes.
          break;
      }
    }
  }

  if (caps.vlocityLegacy) {
    invoke("vlocity", () => iterVlocity(conn, caps, String(orgId), onSkip));
  }
  if (caps.omnistudioOncore) {
    invoke("omnistudio", () => iterOmnistudio(conn));
    if (normalized.enableOmnistudioRetrieve) {
      invoke("omnistudio-retrieve", async function* () {
        const { iterOmnistudioRetrieve } = await import("./extractors/omnistudio-retrieve.js");
        yield* iterOmnistudioRetrieve(conn, String(orgId), {
          apiVersion: normalized.apiVersion ?? "60.0",
          ...(onSkip ? { onError: onSkip } : {}),
        });
      });
    }
  }
  // Log the generic-type filter summary once at fan-out start — makes the
  // skip-vs-route decision visible without --debug.
  if (types.length > 0) {
    console.log(
      `ingest: dispatch routed=${sources.length} sources (${types.length} discovered metadata types; generic-type whitelist active — set SFGRAPH_INCLUDE_ALL_GENERIC=1 to invoke all)`,
    );
  }

  // Parallel by default: fan out across all source iterators so different
  // pools (Tooling/Metadata/Data) saturate simultaneously. Escape hatch:
  // SFGRAPH_SEQUENTIAL_SOURCES=1 falls back to the legacy serial merge for
  // anyone who hits an ordering bug or wants the old log layout.
  const sequential = process.env.SFGRAPH_SEQUENTIAL_SOURCES === "1";
  yield* sequential ? mergeAsyncIterables(...sources) : mergeAsyncIterablesParallel(...sources);

  // Phase 1.5 W1.5-02 late-yield drain. When the merger has finished its
  // main loop (all live slots cleared), drain any background-wedge iterators
  // for the configured budget. Records arriving inside the budget are
  // yielded with `attributes.lateYield = true`. Iterators whose stopWaiting
  // flag was set by the cap-eviction path skip immediately. Anything still
  // unresolved after the budget is dropped on the floor — its underlying
  // jsforce HTTP request continues running until libuv tears it down at
  // process exit (W1.5-03 will surface a "stop-waiting" semantic for this).
  if (coordinator && coordinator.backgroundWedges.length > 0 && coordinator.lateDrainBudgetMs > 0) {
    if (process.env.SFGRAPH_DEBUG_INGEST === "1") {
      console.log(
        `ingest: [debug] late-drain pass: ${coordinator.backgroundWedges.length} background wedge(s), budget=${coordinator.lateDrainBudgetMs}ms`,
      );
    }
    for (const entry of coordinator.backgroundWedges) {
      yield* drainBackgroundWedge(entry, coordinator.lateDrainBudgetMs, coordinator.warnings);
    }
  }
}

/**
 * Internal-surface exports for unit tests in `__tests__/`. Not part of the
 * public package API — these are intentionally namespaced under `__testing`
 * so they don't appear in the package's exports surface to downstream
 * consumers. (They're still importable, but the underscore convention
 * signals "test only".)
 *
 * Exposed:
 *   - `failSoft`: wrap an iterable with the W1.5-01/02 watchdog + soft-isolate.
 *   - `createWedgeCoordinator`: build a coordinator + warnings sink with
 *      optional cap/drain overrides for deterministic tests.
 *   - `drainBackgroundWedge`: run the post-merger late-drain pass against
 *      a single background-wedge entry.
 *   - `mergeAsyncIterablesParallel`: re-export for symmetry; the (array,
 *      opts) overload is what tests use to fix concurrency.
 *   - `setTestWatchdogBudgets` / `resetTestWatchdogBudgets`: env-var-backed
 *      knobs to squeeze the watchdog budget for fast tests. Always paired
 *      via try/finally in tests so the environment is left clean.
 */
export const __testing = {
  failSoft,
  createWedgeCoordinator,
  drainBackgroundWedge,
  mergeAsyncIterablesParallel,
  setTestWatchdogBudgets(opts: { firstYieldMs: number; inactivityMs: number }): void {
    process.env.SFGRAPH_WATCHDOG_FIRST_YIELD_MS = String(opts.firstYieldMs);
    process.env.SFGRAPH_WATCHDOG_INACTIVITY_MS = String(opts.inactivityMs);
  },
  resetTestWatchdogBudgets(): void {
    // Note: assigning `undefined` to a `process.env.X` key in Node coerces to
    // the string "undefined". That's fine here because readWatchdogBudgets()
    // runs parseInt() on the value, parseInt("undefined") === NaN, and NaN
    // falls through to the *_MS_DEFAULT branch. So semantically equivalent
    // to `delete`, but satisfies biome's lint/performance/noDelete.
    process.env.SFGRAPH_WATCHDOG_FIRST_YIELD_MS = undefined;
    process.env.SFGRAPH_WATCHDOG_INACTIVITY_MS = undefined;
  },
};
