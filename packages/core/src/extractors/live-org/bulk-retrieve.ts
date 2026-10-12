import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { RawMember } from "../interfaces/metadata-source.js";
import type { OrgCapabilities } from "./capabilities.js";
import { discoverMetadataTypes } from "./discovery.js";
import { buildDispatchTable } from "./dispatch.js";
import { iterApex } from "./extractors/apex.js";
import { iterCustomSettings } from "./extractors/custom-settings.js";
import { iterFlow } from "./extractors/flow.js";
import { iterGenericMetadata } from "./extractors/generic-metadata.js";
import { iterIntegration } from "./extractors/integration.js";
import { iterLwc } from "./extractors/lwc.js";
import { iterObject } from "./extractors/object.js";
import { iterOmnistudio } from "./extractors/omnistudio.js";
import { iterSecurity } from "./extractors/security.js";
import { iterVlocity } from "./extractors/vlocity.js";
import { StopWaitingError, stopSignalContext } from "./rate-limit.js";
import {
  type FetchFailure,
  IncompleteSourceError,
  TypeUnreadableError,
  UNREADABLE_EARLY_STOP,
  isPlatformRefusal,
  withRetry,
} from "./retry.js";

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
  /**
   * The source's skip hook (failSoft's `onError`). A wedge is only a
   * deferral: once the late drain (or cap eviction) decides the source did
   * NOT finish — a late error, the drain budget running out, eviction, or
   * late drain disabled — the outcome is reported here under the source's
   * own label so it lands in skipReport and `--retry-skipped` re-runs it.
   * (Review I1: these used to surface only as `wedge:*` warnings.)
   */
  onError?: (label: string, err: Error) => void;
  /** Set once a skip has been reported for this entry (one skip per wedge). */
  skipReported?: boolean;
}

/** Report a parked wedge as a skip, at most once per entry. */
function reportWedgeSkip(entry: BackgroundWedgeEntry, reason: string): void {
  if (entry.skipReported) return;
  entry.skipReported = true;
  entry.onError?.(entry.label, new Error(reason));
  console.log(`ingest:   ${entry.label} ✗ skipped (${reason.slice(0, 80)})`);
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
  // Default 32 (was 4): a full --rebuild on a large org wedges many slow/empty
  // generic-metadata sources at the 90s first-yield watchdog AND the heavy Apex
  // source; a cap of 4 evicted most of them (their data lost). The drain loop
  // skips already-resolved entries cheaply, so a high cap costs little.
  const cap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : 32;
  const drainEnv = Number.parseInt(process.env.SFGRAPH_LATE_DRAIN_BUDGET_MS ?? "", 10);
  // Default 300s (was 60s): the per-entry budget is TOTAL drain wall-clock.
  // Apex needs ~75s to stream all classes once the Tooling pool frees up after
  // the main loop; 60s clipped it mid-drain. Empty/fast entries still return
  // `done` immediately and cost nothing, so the larger budget only helps the
  // genuinely-heavy entries finish.
  const drain = Number.isFinite(drainEnv) && drainEnv >= 0 ? drainEnv : 300_000;
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
  | "unknown"
  /** The org refused these members deterministically (same server fault on
   *  every read, or an org rejection). Listed to the user with the first
   *  error, but never re-run by auto-retry / --retry-skipped. */
  | "unreadable";

/**
 * Turn a source failure into skip-report entries. An IncompleteSourceError
 * is split: members the org refused deterministically become one
 * `unreadable` entry, the rest one entry classified as before — so a source
 * with both still gets re-run for the recoverable part, and an all-refused
 * source is not re-run at all.
 */
export function skipEntriesFor(
  label: string,
  err: Error,
): Array<{ label: string; reason: string; category: SkipCategory }> {
  if (err instanceof IncompleteSourceError && err.failures.length > 0) {
    const out: Array<{ label: string; reason: string; category: SkipCategory }> = [];
    const refused = err.failures.filter((f) => isPlatformRefusal(f.error));
    if (refused.length > 0) {
      out.push({ label, reason: describeUnreadable(err.source, refused), category: "unreadable" });
    }
    // Classify the recoverable rest per failure (review M5): the combined
    // message holds member names and only the FIRST error, so one
    // INSUFFICIENT_ACCESS member (or a name containing NOT_FOUND) mislabelled
    // every other loss. One entry per category, each naming its members.
    const byCategory = new Map<SkipCategory, FetchFailure[]>();
    for (const f of err.failures) {
      if (isPlatformRefusal(f.error)) continue;
      const msg = f.error instanceof Error ? f.error.message : String(f.error);
      const cat = classifySkip(msg);
      byCategory.set(cat, [...(byCategory.get(cat) ?? []), f]);
    }
    for (const [category, group] of byCategory) {
      out.push({ label, reason: new IncompleteSourceError(err.source, group).message, category });
    }
    return out;
  }
  const reason = err?.message ?? String(err);
  return [{ label, reason, category: classifySkip(reason) }];
}

/** Counts behind a source's unreadable failures: members refused, members
 *  never requested after an early stop, and whether the listing was refused. */
function unreadableCounts(refused: FetchFailure[]): {
  members: FetchFailure[];
  unread: number;
  listing: boolean;
} {
  const members = refused.filter(
    (f) => !(f.error instanceof TypeUnreadableError) && !f.name.startsWith("metadata.list "),
  );
  const unread = refused.reduce(
    (n, f) => n + (f.error instanceof TypeUnreadableError ? f.error.unreadCount : 0),
    0,
  );
  return { members, unread, listing: refused.some((f) => f.name.startsWith("metadata.list ")) };
}

function describeUnreadable(source: string, refused: FetchFailure[]): string {
  const MAX_NAMES = 25;
  const { members, unread, listing } = unreadableCounts(refused);
  // The shared refusal of an early stop is its first member's (review N2);
  // otherwise the first refusal recorded.
  const stop = refused.find((f) => f.error instanceof TypeUnreadableError)?.error as
    | TypeUnreadableError
    | undefined;
  const first = stop?.cause ?? refused[0]?.error;
  const firstMsg = first instanceof Error ? first.message : String(first ?? "");
  if (listing && members.length === 0) {
    // The type's listing itself was refused (e.g. ManagedTopic).
    return `${source}: listing unreadable (org refused metadata.list); error: ${firstMsg}`;
  }
  const names = members.map((f) => f.name);
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const more = names.length > MAX_NAMES ? ` (+${names.length - MAX_NAMES} more)` : "";
  const stopped =
    unread > 0
      ? `; stopped reading the type after ${UNREADABLE_EARLY_STOP} identical refusals — ${unread} more member(s) not read`
      : "";
  return `${source}: ${members.length} member(s) unreadable (org refused): ${shown}${more}${stopped}; first error: ${firstMsg}`;
}

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
 *
 * Errors: a sub-stream that rejects releases its slot and the remaining
 * streams keep draining; after the last one finishes the merge rejects with
 * that error (or an `AggregateError` when several failed). Values already
 * yielded are never retracted.
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
  // Sub-stream failures, in the order they happened. A failed stream frees
  // its slot like a finished one so its peers (and queued streams) still
  // drain, but the failure is re-thrown once everything else is done — it is
  // never mapped to a silent `done` (review M7; the swallowed-error shape
  // behind the original ApexClass truncation). bulkRetrieve's sources are
  // failSoft-wrapped and never reject, so this only affects direct callers.
  const errors: unknown[] = [];
  const advance = (idx: number): void => {
    const it = iterators[idx];
    if (!it) return;
    pending.set(
      idx,
      it.next().then(
        (result) => ({ idx, result }),
        (e: unknown) => {
          errors.push(e);
          return {
            idx,
            result: { value: undefined as unknown as T, done: true } as IteratorResult<T>,
          };
        },
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
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} merged sources failed`);
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

/**
 * Per-source watchdog overrides (the "per-source override" the anti-feature
 * note above points to). Some sources legitimately need far longer than the
 * 90s default to produce their FIRST record — most notably the Vlocity runner,
 * which executes a long sequence of `vlocity_cmt` SObject queries and assembles
 * DataPacks before yielding member #1, and can have multi-minute gaps between
 * DataPack types once streaming. Raising the GLOBAL budget to accommodate it is
 * wrong: it makes every other slow/empty source hold its merger slot 10x longer
 * and starves the pool (observed: a 600s global first-yield stalled the whole
 * fan-out behind a few empty generic sources). So scope the larger budget to
 * the specific label only. Explicit env vars still win (debug/tests).
 */
const SOURCE_WATCHDOG_OVERRIDES: Record<string, { firstYieldMs?: number; inactivityMs?: number }> =
  {
    // Vlocity must stay INLINE: the post-merger background-drain cannot reliably
    // recover it (it needs minutes to first-yield, longer than any sane drain
    // budget, and competes for drain slots). Giving it a long inline budget lets
    // it hold its DATA-pool slot and stream once the pool frees up. NB: do NOT
    // do this for Tooling-pool sources like Apex — holding a scarce Tooling slot
    // that long starves every other Tooling source and stalls the whole fan-out.
    // Apex instead wedges fast (releasing its slot) and is recovered by the
    // background-drain pass, which is sized generously in createWedgeCoordinator.
    vlocity: { firstYieldMs: 20 * 60_000, inactivityMs: 10 * 60_000 },
  };

/** Read watchdog budgets per-call so unit tests can override via env vars
 *  without restarting the process. Production env should leave these unset:
 *  ordinary sources get the documented 90s first-yield / 5min inactivity;
 *  a source in SOURCE_WATCHDOG_OVERRIDES gets its scoped budget instead. */
function readWatchdogBudgets(label?: string): { firstYieldMs: number; inactivityMs: number } {
  const fy = Number.parseInt(process.env.SFGRAPH_WATCHDOG_FIRST_YIELD_MS ?? "", 10);
  const inact = Number.parseInt(process.env.SFGRAPH_WATCHDOG_INACTIVITY_MS ?? "", 10);
  const override = label ? SOURCE_WATCHDOG_OVERRIDES[label] : undefined;
  return {
    firstYieldMs:
      Number.isFinite(fy) && fy > 0
        ? fy
        : (override?.firstYieldMs ?? WATCHDOG_FIRST_YIELD_MS_DEFAULT),
    inactivityMs:
      Number.isFinite(inact) && inact > 0
        ? inact
        : (override?.inactivityMs ?? WATCHDOG_INACTIVITY_MS_DEFAULT),
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
    reportWedgeSkip(
      victim,
      `background wedge evicted (cap ${coordinator.maxBackgroundWedges}) after ${ageMs}ms — remaining rows not fetched`,
    );
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
  // Why the loop ended. Only "done" means the source finished; every other
  // outcome loses rows and must become a skip (review I1).
  let outcome: "done" | "budget" | "evicted" | "error" = "evicted";
  const BUDGET_SENTINEL = Symbol("late-drain budget");
  while (!entry.stopWaitingRef.value) {
    const remaining = startedAt + budgetMs - Date.now();
    if (remaining <= 0) {
      outcome = "budget";
      break;
    }
    // First iteration: consume the abandoned-but-still-pending `it.next()`
    // promise from when the watchdog fired. Subsequent iterations call
    // `iterator.next()` normally. Async-generator semantics queue
    // concurrent `.next()` calls, so we MUST consume the pending one
    // before issuing a new one — otherwise the late-yielded value goes
    // to the abandoned promise and the drain sees the NEXT yield (or
    // `done:true` if the generator is single-yield).
    const nextPromise =
      entry.pendingFirstNext !== null
        ? entry.pendingFirstNext
        : stopSignalContext.run(entry.stopWaitingRef, () => entry.iterator.next());
    if (entry.pendingFirstNext !== null) entry.pendingFirstNext = null;
    let next: IteratorResult<RawMember> | typeof BUDGET_SENTINEL;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      next = await Promise.race([
        nextPromise,
        new Promise<typeof BUDGET_SENTINEL>((resolve) => {
          // A distinct sentinel (not a synthetic `done`) so budget exhaustion
          // is never mistaken for the source finishing.
          timer = setTimeout(() => resolve(BUDGET_SENTINEL), remaining);
        }),
      ]);
    } catch (e) {
      // Late-arriving error from the wedged iterator (e.g. an
      // IncompleteSourceError after a truncated drain). Don't crash the
      // drain; keep the warning AND record the skip.
      const err = e as Error;
      const msg = err?.message ?? String(e);
      warnings.push(fmtWedgeWarning(entry.label, "lateError", { error: msg.slice(0, 120) }));
      outcome = "error";
      if (!entry.skipReported) {
        entry.skipReported = true;
        entry.onError?.(entry.label, err instanceof Error ? err : new Error(msg));
        console.log(`ingest:   ${entry.label} ✗ skipped (${msg.slice(0, 80)})`);
      }
      break;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (next === BUDGET_SENTINEL) {
      outcome = "budget";
      break;
    }
    if (next.done) {
      outcome = "done";
      break;
    }
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
  if (outcome === "budget") {
    reportWedgeSkip(
      entry,
      `late-drain budget exhausted (${budgetMs}ms) after ${lateCount} late records — source did not finish`,
    );
  } else if (outcome === "evicted") {
    reportWedgeSkip(entry, "background wedge evicted before the late drain finished it");
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
  const { firstYieldMs, inactivityMs } = readWatchdogBudgets(label);

  // W1.5-03: pre-allocate the per-source stop-signal at body entry and
  // publish it into AsyncLocalStorage so any downstream rate-limit wrapper
  // (`withTimeout`, `soqlWithTimeout`, `scheduleQuery`) inside the wedged
  // iterator can observe `value = true` after cap-eviction flips it. Same
  // ref is later attached to the BackgroundWedgeEntry so the keystone's
  // `enforceBackgroundWedgeCap` flip propagates to in-flight calls without
  // any per-extractor signature change. AsyncLocalStorage propagates across
  // awaits within an async function started inside .run() — we factor the
  // iterator into a helper started inside the .run() callback.
  const stopWaitingRef: { value: boolean } = { value: false };
  const it = stopSignalContext.run(stopWaitingRef, () => factory()[Symbol.asyncIterator]());
  if (debug) console.log(`ingest: [debug] ${label} ← invoked at ${startedAt}`);

  try {
    while (true) {
      const remainingFirstYield = started
        ? Number.POSITIVE_INFINITY
        : startedAt + firstYieldMs - Date.now();
      const watchdogMs = Math.min(inactivityMs, remainingFirstYield);
      const stage: "firstYield" | "inactivity" = started ? "inactivity" : "firstYield";
      const stageDetail = started ? `${inactivityMs / 1000}s` : `${firstYieldMs / 1000}s`;

      // Run each `.next()` synchronously inside the ALS context so awaits
      // inside the underlying generator's body that call into rate-limit
      // wrappers can resolve the stop-signal via `getStore()`.
      const pending = stopSignalContext.run(stopWaitingRef, () => it.next());
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wedged: { wedge: true } | { wedge: false; result: IteratorResult<T> };
      try {
        wedged = await Promise.race<{ wedge: true } | { wedge: false; result: IteratorResult<T> }>([
          pending.then((result) => ({ wedge: false as const, result })),
          new Promise<{ wedge: true }>((resolve) => {
            // watchdogMs may be <=0 if the budget is already burned (defensive
            // — should be rare since the clock starts at body-entry). setTimeout
            // with non-positive delay fires on the next event-loop tick, which
            // is the correct wedge-immediately behavior.
            timer = setTimeout(() => resolve({ wedge: true as const }), Math.max(0, watchdogMs));
          }),
        ]);
      } finally {
        // Clear on EVERY outcome. Clearing only when `pending` resolved left
        // the ref'd timer (up to the 5 min inactivity budget) armed whenever
        // the source threw, so a run whose last sources skipped held the
        // process open after its final line (exit hang, 2026-10-09).
        if (timer) clearTimeout(timer);
      }

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
    // Print the unreadable and recoverable counts separately (review M6):
    // the combined message counts both as "not fetched after retries".
    let detail = err?.message?.slice(0, 80) ?? "unknown";
    let verdict = "skipped";
    if (err instanceof IncompleteSourceError && err.failures.length > 0) {
      const refused = err.failures.filter((f) => isPlatformRefusal(f.error));
      const lost = err.failures.length - refused.length;
      if (refused.length > 0) {
        const { members, unread, listing } = unreadableCounts(refused);
        const parts: string[] = [];
        if (lost > 0) parts.push(`${lost} member(s) not fetched`);
        if (listing) parts.push("listing refused");
        if (members.length > 0) parts.push(`${members.length} member(s) unreadable`);
        if (unread > 0) parts.push(`${unread} not read after early stop`);
        detail = parts.join(", ");
        if (lost === 0) verdict = "unreadable";
      }
    }
    console.log(`ingest:   ${label} ✗ ${verdict} (${detail})`);
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

      // W1.5-03: reuse the SAME stopWaitingRef that was published into ALS
      // at body entry. When enforceBackgroundWedgeCap later flips this ref's
      // `.value = true` on cap eviction, any in-flight rate-limit wrapper
      // inside the wedged iterator's continuing background pumps will see
      // the flag through `stopSignalContext.getStore()` and reject with
      // `StopWaitingError` quickly. The underlying jsforce HTTP call still
      // leaks until socket idle timeout — documented in rate-limit.ts.
      coordinator.backgroundWedges.push({
        label,
        iterator: it as unknown as AsyncIterator<RawMember>,
        pendingFirstNext,
        registeredAt: Date.now(),
        stopWaitingRef,
        ...(onError ? { onError } : {}),
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

/**
 * Types whose data is fully captured by a CONTAINER type, so routing them
 * individually only produces value-less opaque duplicates that clobber the
 * container's richer nodes. `CustomLabel` (singular) is covered by the
 * `CustomLabels` container — whose rule extracts each label's value/language;
 * the singular path would emit `CustomLabel:Name` nodes with no value and,
 * depending on merge order, overwrite the real ones. Skip them.
 */
const CONTAINER_COVERED_TYPES: ReadonlySet<string> = new Set(["CustomLabel"]);

function shouldRouteGeneric(type: string): boolean {
  // Never route a type a container already covers with richer data.
  if (CONTAINER_COVERED_TYPES.has(type)) return false;
  // Default: route EVERY long-tail metadata type through the generic
  // extractor so the graph — and therefore semantic search — covers the org
  // completely. Anything without a dedicated extractor still becomes a typed
  // node (the rule parsers key off the type name) or an opaque node, which is
  // what search needs. The old curated whitelist silently dropped ~250
  // discovered types (search returned nothing for them). Set
  // SFGRAPH_GENERIC_WHITELIST_ONLY=1 to restore the restricted subset.
  if (process.env.SFGRAPH_GENERIC_WHITELIST_ONLY === "1") return GENERIC_TYPE_WHITELIST.has(type);
  return true;
}

export interface BulkRetrieveOpts {
  skipReport?: IngestSkipReport;
  /** When set, only invoke source labels in this set. Labels are the same
   *  source-keys used by the dispatch table: 'apex', 'lwc', 'flow', 'object',
   *  'security', 'integration', 'vlocity', 'omnistudio', or
   *  'generic:<MetadataType>' for the long tail. */
  onlyLabels?: Set<string>;
  /** `onlyLabels` came from the user (--only / --retry-skipped), not from the
   *  in-run auto-retry: generic types it names are read in full (no early
   *  stop on identical refusals). */
  explicitOnlyLabels?: boolean;
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
  // An explicit re-run (--retry-skipped / --only) reads every member of the
  // generic types it names: no early stop (review N1c). Every generic source
  // such a run launches was named, directly or via `discovery`.
  const genericOpts = { earlyStop: !(onlyLabels && normalized.explicitOnlyLabels) };
  // Phase 1.5 W1.5-02 coordinator. Built only when a warnings sink was
  // supplied — without one, no place to push wedge strings, so the legacy
  // "watchdog fires → skip entry" behavior is preserved. The coordinator
  // owns the background-wedge cap + late-drain budget.
  const coordinator: WedgeCoordinator | undefined = normalized.warnings
    ? createWedgeCoordinator(normalized.warnings)
    : undefined;
  const onSkip = skipReport
    ? (label: string, err: Error) => {
        skipReport.skips.push(...skipEntriesFor(label, err));
      }
    : undefined;
  /** Record a skip for a label the --only filter selects (a pre-fan-out
   *  failure under an unrelated `--only` is not this run's loss). */
  const skipIfSelected = (label: string, err: Error, selected: boolean) => {
    if (onlyLabels && !selected) return;
    onSkip?.(label, err);
    console.log(`ingest:   ${label} ✗ skipped (${err.message.slice(0, 80)})`);
  };

  // Discover the type list this org actually supports. Retried like every
  // other fetch. If it still fails, fall back to invoking every dedicated
  // extractor AND record a `discovery` skip: without the type list every
  // generic:<Type> source (and every child type) is never invoked, which
  // used to be silent (review I2). `--retry-skipped` feeds `discovery` back
  // as an only-label, which selects every generic source below.
  let types: Awaited<ReturnType<typeof discoverMetadataTypes>> = [];
  try {
    types = await withRetry(() => discoverMetadataTypes(conn));
  } catch (e) {
    types = [];
    const err = e instanceof Error ? e : new Error(String(e));
    skipIfSelected(
      "discovery",
      new Error(`metadata discovery failed — generic metadata types not fetched: ${err.message}`, {
        cause: err,
      }),
      !onlyLabels ||
        onlyLabels.has("discovery") ||
        [...onlyLabels].some((l) => l.startsWith("generic:")),
    );
  }
  // Capability probes that failed transiently (not "absent"): the gated
  // source was not invoked, so it is a skip under that source's label.
  for (const pe of caps.probeErrors ?? []) {
    if (!pe.source) continue;
    skipIfSelected(
      pe.source,
      new Error(`capability probe ${pe.probe} failed — source not run: ${pe.error}`),
      onlyLabels?.has(pe.source) ?? true,
    );
  }

  const sources: Array<AsyncIterable<RawMember>> = [];
  const invoked = new Set<string>(); // source-key dedup

  const invoke = (key: string, factory: () => AsyncIterable<RawMember>) => {
    if (invoked.has(key)) return;
    invoked.add(key);
    // --only filter: when onlyLabels is set, skip any source not in the set.
    // Filter applies to the exact source key ('apex', 'generic:Profile', etc.)
    // for precise targeting of retry/partial-refresh flows.
    // A `discovery` only-label (from a skipped discovery) selects every
    // generic source — those are what a failed discovery lost.
    if (
      onlyLabels &&
      !onlyLabels.has(key) &&
      !(onlyLabels.has("discovery") && key.startsWith("generic:"))
    ) {
      return;
    }
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
            invoke(`generic:${type}`, () =>
              iterGenericMetadata(conn, String(orgId), type, {}, genericOpts),
            );
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
            invoke(`generic:${type}`, () =>
              iterGenericMetadata(conn, String(orgId), type, {}, genericOpts),
            );
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

    // Child metadata types (ValidationRule, ListView, CompactLayout, FieldSet,
    // WebLink, BusinessProcess, ...) are returned by describe() only as
    // `childXmlNames` of a parent (mostly CustomObject), never as top-level
    // types — so the dispatch loop above never fetches them. Most ARE
    // independently listable via metadata.list, so route each through the
    // generic extractor. This is how validation rules / list views on STANDARD
    // objects get captured — iterObject only sees children embedded in the
    // custom objects it reads, missing the bulk that live on Account/Case/etc.
    // Children that aren't independently listable fail-soft to nothing. Skip
    // children already owned by a dedicated extractor or dispatched above.
    if (process.env.SFGRAPH_GENERIC_WHITELIST_ONLY !== "1") {
      const typedOwned = new Set<string>([
        ...APEX_TYPES,
        ...LWC_TYPES,
        ...FLOW_TYPES,
        ...OBJECT_TYPES,
        ...SECURITY_TYPES,
        ...INTEGRATION_TYPES,
        "CustomField", // fetched in bulk by iterObject; re-listing is wasteful
      ]);
      const childTypes = new Set<string>();
      for (const t of types) for (const c of t.childXmlNames) childTypes.add(c);
      for (const child of childTypes) {
        if (dispatch.has(child) || typedOwned.has(child)) continue;
        if (CONTAINER_COVERED_TYPES.has(child)) continue; // CustomLabel ⊂ CustomLabels
        invoke(`generic:${child}`, () =>
          iterGenericMetadata(conn, String(orgId), child, {}, genericOpts),
        );
      }
    }
  }

  if (caps.vlocityLegacy) {
    invoke("vlocity", () => iterVlocity(conn, caps, String(orgId), onSkip));
  }
  // Custom Setting ROW capture — self-guards (yields nothing if the org has no
  // custom settings or EntityDefinition is unavailable), so invoke always.
  invoke("custom-settings", () => iterCustomSettings(conn, String(orgId)));
  if (caps.omnistudioOncore) {
    // When the Metadata-API retrieve path is enabled it covers
    // OmniDataTransform and OmniUiCard with higher fidelity — skip them on
    // the SOQL path so the same component is not ingested twice (the
    // retrieve XML would otherwise clobber the SOQL-enriched node, and
    // vice versa, nondeterministically by merge order).
    invoke("omnistudio", () =>
      iterOmnistudio(
        conn,
        normalized.enableOmnistudioRetrieve
          ? { skipTypes: new Set(["OmniDataTransform", "OmniUiCard"]) }
          : {},
      ),
    );
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
  // Log the generic-type routing summary once at fan-out start — makes the
  // skip-vs-route decision visible without --debug. The default is FULL
  // coverage (every discovered type routed); the opt-out is
  // SFGRAPH_GENERIC_WHITELIST_ONLY=1 (restricts to the curated subset).
  if (types.length > 0) {
    const whitelistOnly = process.env.SFGRAPH_GENERIC_WHITELIST_ONLY === "1";
    const mode = whitelistOnly
      ? "curated whitelist only (SFGRAPH_GENERIC_WHITELIST_ONLY=1) — unset to route all"
      : "full coverage (all discovered types) — set SFGRAPH_GENERIC_WHITELIST_ONLY=1 to restrict";
    console.log(
      `ingest: dispatch routed=${sources.length} sources (${types.length} discovered metadata types; ${mode})`,
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
  if (
    coordinator &&
    coordinator.backgroundWedges.length > 0 &&
    coordinator.lateDrainBudgetMs <= 0
  ) {
    // Late drain disabled (SFGRAPH_LATE_DRAIN_BUDGET_MS=0): every parked
    // wedge is abandoned, so each one is a skip, not a silent loss.
    for (const entry of coordinator.backgroundWedges) {
      reportWedgeSkip(entry, "wedged and late drain disabled — source did not finish");
    }
  } else if (coordinator && coordinator.backgroundWedges.length > 0) {
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
  readWatchdogBudgets,
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
