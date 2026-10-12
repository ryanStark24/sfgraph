/**
 * Task 11b: parallel member parsing for ingest.
 *
 * `parsePool(members, opts)` parses members in worker_threads and yields one
 * outcome per member IN INPUT ORDER. Writes stay with the caller, on the main
 * thread, so the graph sees exactly the serial merge sequence (last writer
 * wins, reconcile order, bulk-window batching and the embedding queue are all
 * unchanged). Parsers are pure functions of (member, context): they never see
 * the store, and the audit in the 11b report found no cross-member state, so
 * a parse in a worker returns the same facts as one on the main thread.
 *
 * Same-output guards:
 * - The worker runs the same `parseMember` as the serial path, with the same
 *   registry (side-effect parser imports plus `loadAllRules`).
 * - A result is only shipped back when it is plain data (objects, arrays,
 *   primitives); anything else (a class instance, a function, a clone error)
 *   is re-parsed on the main thread at its turn, so structured clone can
 *   never change what the store serialises.
 * - Parser log calls are recorded in the worker and replayed, in order, on
 *   the caller's logger when the member is yielded.
 *
 * Failure handling: a worker parses its members one at a time, so when it
 * crashes (uncaught error, exit) or stalls, the member it was on gets a parse
 * error and the rest of its queue is re-dispatched to a fresh worker. A worker
 * that dies before it is ready (cannot load, or not ready within the start-up
 * timeout) marks the pool broken after two such failures; three crashes after
 * `ready` in one run also break it (a fault that only happens in workers must
 * not turn every member into an error). Once broken, everything not yet
 * yielded (including crash culprits still waiting their turn) is parsed on the
 * main thread. No path hangs.
 *
 * Diagnostics: parser log calls go through the logger and are replayed in
 * order, but raw `console.*` output from code running in a worker (e.g.
 * SFGRAPH_DEBUG_INGEST diagnostics inside a parser) reaches stdout
 * asynchronously and is NOT ordered relative to the main thread's output.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Logger } from "@ryanstark24/sfgraph-shared";
import type { RawMember } from "../extractors/interfaces/metadata-source.js";
import { type MemberParse, type ParseCtxBase, parseMember } from "./parse-member.js";

/**
 * Hard cap on the default worker count. Each worker loads every parser. On a
 * large corpus (a large Vlocity repo) the memory diagnosis estimated ~200 MB of heap per
 * worker once the Apex DFA cache is released (APEX_DFA_CLEAR_INTERVAL in
 * parsers/apex/class.ts) and up to ~450 MB without it; measured whole-process
 * RSS for the repo ingest at 4 workers fell from ~3.0 GB to ~1.95 GB. The ONNX embedding worker needs CPU during fan-out
 * too; 4 workers gave most of the 8-worker speed-up (3,000 members: 10.3 s vs
 * 11.2 s at 8, 17.9-21.4 s serial). Set SFGRAPH_PARSE_WORKERS to go higher.
 */
export const DEFAULT_MAX_PARSE_WORKERS = 4;

/**
 * Below this many members the pool is not started and the input is parsed on
 * the main thread. Workers cost ~0.3 s (1) to ~0.8-1.0 s (8) to load every
 * parser, plus each worker's first Apex parse loads apex-parser. Measured on
 * synthetic Apex + LWC members (8 workers, compiled build, shared 10-core
 * box): serial was faster at 200 (1.2 s vs 2.8 s) and 400 (2.5 s vs 3.5 s),
 * about even at 1,000 (5.9 s vs 5.8 s), and the pool won above that (3,000: 21.4 s
 * vs 11.2 s). 500 keeps small projects and deltas serial. Override with
 * SFGRAPH_PARSE_POOL_MIN. With the default 4 workers: 200 members 1.3 s
 * serial vs 2.1 s pool, 400 even (2.8 s), 1,000 6.7 s vs 4.4 s.
 */
export const DEFAULT_PARSE_POOL_MIN_MEMBERS = 500;

const DEFAULT_STALL_MS = 10 * 60 * 1000;
const DEFAULT_STARTUP_MS = 2 * 60 * 1000;
const DEFAULT_PER_WORKER = 4;
const MAX_STARTUP_FAILURES = 2;
/** Crashes after `ready` (each fails one member) before the pool gives up. */
const MAX_READY_CRASHES = 3;

/**
 * Heap-cap OOMs before the pool gives up on workers: max(10, workers * 4). An
 * OOM is a large member, not a broken worker, so it gets a looser bound than
 * crashes; past it, members are evidently too big for the cap.
 */
export function maxOomFallbacks(workers: number): number {
  return Math.max(10, workers * 4);
}

/**
 * Old-generation heap cap per parse worker, in MB (T2 cycle 2). A worker's
 * live heap is small (about 40 MB on a large Vlocity repo), but without a cap V8
 * lets old space grow to about 180 MB per worker before a major GC; with 4
 * workers that slack put the repo rebuild at 1.9-2.06 GB RSS. A cap puts V8
 * in its memory-constrained mode, which collects sooner. A worker that still
 * runs out (ERR_WORKER_OUT_OF_MEMORY) has its member re-parsed on the main
 * thread, so the output does not change. SFGRAPH_PARSE_WORKER_HEAP_MB
 * overrides it (0 = no cap).
 */
export const DEFAULT_PARSE_WORKER_HEAP_MB = 256;

function envWorkerHeapMb(): number | undefined {
  const n = Number.parseInt(process.env.SFGRAPH_PARSE_WORKER_HEAP_MB ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Worker count. `SFGRAPH_PARSE_WORKERS` set to an integer >= 0 is used as is
 * (`0` disables the pool). Otherwise `Math.max(1, cpus - 1)`, capped at 4,
 * where cpus is `os.availableParallelism()` (honours affinity, unlike
 * `os.cpus().length`).
 */
export function resolveParseWorkers(
  env: string | undefined = process.env.SFGRAPH_PARSE_WORKERS,
  cpus: number = typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : os.cpus().length,
): number {
  if (env !== undefined && env.trim() !== "") {
    const n = Number(env.trim());
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return Math.min(DEFAULT_MAX_PARSE_WORKERS, Math.max(1, cpus - 1));
}

/**
 * The compiled worker next to this module, or null when it is not there
 * (running from TypeScript sources, e.g. under vitest). Callers then parse on
 * the main thread.
 */
export function defaultParseWorkerUrl(): URL | null {
  const url = new URL("./parse-worker.js", import.meta.url);
  try {
    return existsSync(fileURLToPath(url)) ? url : null;
  } catch {
    return null;
  }
}

/** One recorded parser log call. */
export interface ParseLogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  meta?: Record<string, unknown>;
}

/** Main → worker. */
export interface ParseJobMsg {
  seq: number;
  member: RawMember;
}

/** Worker → main. */
export type ParseWorkerMsg =
  | { type: "ready" }
  | { type: "done"; seq: number; outcome: MemberParse; logs: ParseLogEntry[] }
  /** The result is not plain data or could not be cloned: re-parse on main. */
  | { type: "fallback"; seq: number; reason: string };

/** Data handed to each worker. */
export interface ParseWorkerData {
  base: ParseCtxBase;
}

export interface ParsePoolStats {
  /** Workers actually used (0 = the whole input was parsed on the main thread). */
  workers: number;
  /** Members parsed in a worker. */
  pooled: number;
  /** Members parsed on the main thread (serial mode, fallbacks, broken pool). */
  inProcess: number;
  /** Members a worker could not ship back as plain data (re-parsed on main). */
  fallbacks: number;
  /** Worker crashes or stalls (each fails one member). */
  crashes: number;
  /**
   * Members whose worker hit its heap cap (ERR_WORKER_OUT_OF_MEMORY); each is
   * re-parsed on main. Not counted in `crashes`; bounded by MAX_OOM_FALLBACKS.
   */
  oomFallbacks?: number;
}

export interface ParsePoolOpts extends ParseCtxBase {
  /** Worker threads; 0 parses on the main thread. Default resolveParseWorkers(). */
  workers?: number;
  /** Logger for parser log calls (replayed in member order). */
  logger?: Logger;
  /** Worker script; default the compiled `./parse-worker.js` (null → main thread). */
  workerUrl?: URL | string | null;
  /** Inputs shorter than this stay on the main thread. Default 500 (SFGRAPH_PARSE_POOL_MIN). */
  minMembers?: number;
  /** Members queued per worker. Default 4. */
  perWorker?: number;
  /** A ready worker with queued members and no reply for this long is treated as hung. Default 10 min. */
  stallTimeoutMs?: number;
  /** A worker not ready this long after it was spawned counts as a start-up failure. Default 2 min. */
  startupTimeoutMs?: number;
  /** Old-generation heap cap per worker in MB; 0 = none. Default 256 (SFGRAPH_PARSE_WORKER_HEAP_MB). */
  workerHeapMb?: number;
  /** Filled in as the pool runs. */
  stats?: ParsePoolStats;
  /**
   * An outcome to use instead of parsing (T15 N5-1: a quarantined member is
   * never dispatched to a worker); undefined parses as usual.
   */
  preset?: (member: RawMember) => MemberParse | undefined;
}

export interface ParsedMember<M extends RawMember = RawMember> {
  member: M;
  outcome: MemberParse;
}

const NOOP_LOG: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface Job<M> {
  seq: number;
  member: M;
  /** Set when the outcome is known. */
  outcome?: MemberParse | undefined;
  logs?: ParseLogEntry[];
  /** Parse on the main thread when this job reaches the head. */
  inProcess?: boolean;
}

interface Slot<M> {
  worker: Worker;
  ready: boolean;
  /** Jobs sent and not answered, oldest first (the worker runs them in order). */
  queue: Job<M>[];
  /** Stall timer (armed only once ready, while jobs are queued). */
  timer: ReturnType<typeof setTimeout> | null;
  /** Start-up timer (until `ready`). */
  startTimer: ReturnType<typeof setTimeout> | null;
  dead: boolean;
}

function envMinMembers(): number | undefined {
  const n = Number.parseInt(process.env.SFGRAPH_PARSE_POOL_MIN ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function replay(logger: Logger, logs: ParseLogEntry[] | undefined): void {
  if (!logs) return;
  for (const l of logs) {
    if (l.meta === undefined) logger[l.level](l.msg);
    else logger[l.level](l.msg, l.meta);
  }
}

function toAsyncIterator<M>(src: AsyncIterable<M> | Iterable<M>): AsyncIterator<M> {
  if (Symbol.asyncIterator in (src as object)) {
    return (src as AsyncIterable<M>)[Symbol.asyncIterator]();
  }
  const it = (src as Iterable<M>)[Symbol.iterator]();
  return {
    next: async () => it.next(),
    return: async (v?: unknown) => {
      it.return?.(v);
      return { done: true, value: v as M };
    },
  };
}

/**
 * Parse `members` (in workers when worthwhile) and yield `{member, outcome}`
 * in input order. Obsolete members (deletions) are yielded with a `skip`
 * outcome; the caller applies them. If the source throws, every member read
 * before the throw is yielded first, then the error is rethrown.
 */
export async function* parsePool<M extends RawMember>(
  members: AsyncIterable<M> | Iterable<M>,
  opts: ParsePoolOpts,
): AsyncGenerator<ParsedMember<M>, void, undefined> {
  const logger = opts.logger ?? NOOP_LOG;
  const base: ParseCtxBase = { orgId: opts.orgId, parseTimestamp: opts.parseTimestamp };
  const stats: ParsePoolStats = opts.stats ?? {
    workers: 0,
    pooled: 0,
    inProcess: 0,
    fallbacks: 0,
    crashes: 0,
    oomFallbacks: 0,
  };
  const workers = opts.workers ?? resolveParseWorkers();
  const workerUrl =
    opts.workerUrl === undefined ? (workers > 0 ? defaultParseWorkerUrl() : null) : opts.workerUrl;
  const minMembers = opts.minMembers ?? envMinMembers() ?? DEFAULT_PARSE_POOL_MIN_MEMBERS;
  const upstream = toAsyncIterator(members);

  const parseHere = async (m: M): Promise<MemberParse> => {
    if (!m.ref.obsolete) {
      const p = opts.preset?.(m);
      if (p) return p;
    }
    stats.inProcess += 1;
    if (m.ref.obsolete) return { kind: "skip", parseMs: 0 };
    return parseMember(m.ref, m.content, base, logger);
  };

  let upstreamDone = false;
  // A pull is in flight in runPool: `upstream.return()` would queue behind it.
  let pullInFlight = false;
  try {
    // Serial: no read-ahead at all, the exact pre-pool interleaving.
    if (workers <= 0 || !workerUrl) {
      for (;;) {
        const r = await upstream.next();
        if (r.done) {
          upstreamDone = true;
          return;
        }
        yield { member: r.value, outcome: await parseHere(r.value) };
      }
    }

    // Read ahead to decide whether the input is big enough for workers.
    const head: (M | undefined)[] = [];
    let headFailed = false;
    let headError: unknown;
    while (head.length < minMembers) {
      let r: IteratorResult<M>;
      try {
        r = await upstream.next();
      } catch (e) {
        // Same as serial: everything read before the throw is applied first.
        upstreamDone = true;
        headFailed = true;
        headError = e;
        break;
      }
      if (r.done) {
        upstreamDone = true;
        break;
      }
      head.push(r.value);
    }
    if (upstreamDone) {
      for (let i = 0; i < head.length; i++) {
        const m = head[i] as M;
        head[i] = undefined;
        yield { member: m, outcome: await parseHere(m) };
      }
      if (headFailed) throw headError;
      return;
    }

    yield* runPool(head);
  } finally {
    if (!upstreamDone) {
      if (pullInFlight) {
        // Do not wait behind a pending next() (it may be a slow live fetch).
        void Promise.resolve()
          .then(() => upstream.return?.())
          .catch(() => {});
      } else {
        await upstream.return?.();
      }
    }
  }

  async function* runPool(
    head: (M | undefined)[],
  ): AsyncGenerator<ParsedMember<M>, void, undefined> {
    const url = workerUrl as URL | string;
    const perWorker = Math.max(1, opts.perWorker ?? DEFAULT_PER_WORKER);
    const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_MS;
    const startupMs = opts.startupTimeoutMs ?? DEFAULT_STARTUP_MS;
    const slots: Slot<M>[] = [];
    const pending = new Map<number, Job<M>>(); // seq → job, not yet yielded
    const redispatch: Job<M>[] = []; // orphaned by a crash, oldest first
    let nextSeq = 0;
    let headSeq = 0;
    let startupFailures = 0;
    let readyCrashes = 0;
    let ooms = 0;
    const oomBound = maxOomFallbacks(workers);
    // Members failed by a crash; re-parsed on main if the pool breaks before they are yielded.
    const culprits: Job<M>[] = [];
    let broken = false;
    let pull: Promise<IteratorResult<M>> | null = null;
    let pullError: unknown = null;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };

    const finish = (job: Job<M>, outcome: MemberParse, logs?: ParseLogEntry[]): void => {
      job.outcome = outcome;
      if (logs) job.logs = logs;
    };

    const heapMb = opts.workerHeapMb ?? envWorkerHeapMb() ?? DEFAULT_PARSE_WORKER_HEAP_MB;
    const resourceLimits = heapMb > 0 ? { maxOldGenerationSizeMb: heapMb } : undefined;

    // `oom`: the worker hit its heap cap; its member is re-parsed on main.
    const failSlot = (slot: Slot<M>, reason: string, oom = false): void => {
      if (slot.dead) return;
      slot.dead = true;
      clearTimers(slot);
      const queue = slot.queue;
      slot.queue = [];
      const idx = slots.indexOf(slot);
      if (idx >= 0) slots.splice(idx, 1);
      void slot.worker.terminate().catch(() => {});
      if (!slot.ready) {
        // Could not even load: nothing it was given is to blame.
        startupFailures += 1;
        if (startupFailures >= MAX_STARTUP_FAILURES) {
          logger.warn("live-ingest: parse workers unavailable; parsing on the main thread", {
            reason,
          });
        }
        redispatch.push(...queue);
      } else {
        const [culprit, ...rest] = queue;
        if (oom && !culprit) {
          // Nothing in flight to blame or re-parse; not a crash either.
        } else if (culprit && oom) {
          // Over the worker heap cap: main has no cap, so parse it there.
          // Type and count only: member names can be sensitive org data.
          ooms += 1;
          stats.oomFallbacks = (stats.oomFallbacks ?? 0) + 1;
          culprit.inProcess = true;
          logger.warn("live-ingest: parse worker hit its heap cap; re-parsing on the main thread", {
            memberType: culprit.member.ref.memberType,
            oomFallbacks: ooms,
          });
          if (ooms >= oomBound) {
            logger.warn(
              "live-ingest: parse workers keep hitting the heap cap; parsing the rest on the main thread",
              { oomFallbacks: ooms, bound: oomBound },
            );
          }
        } else {
          stats.crashes += 1;
          readyCrashes += 1;
        }
        if (culprit && !oom) {
          // Transient (N4-1): the head of the queue is blamed for a crash or
          // stall that load or a sibling may have caused, so it is retried.
          finish(culprit, { kind: "error", phase: "worker", message: reason, parseMs: 0 });
          stats.pooled += 1;
          culprits.push(culprit);
        }
        redispatch.push(...rest);
        if (readyCrashes >= MAX_READY_CRASHES) {
          logger.warn(
            "live-ingest: parse workers keep crashing; parsing the rest on the main thread",
            { crashes: readyCrashes, reason },
          );
        }
      }
      redispatch.sort((a, b) => a.seq - b.seq);
      if (
        startupFailures >= MAX_STARTUP_FAILURES ||
        readyCrashes >= MAX_READY_CRASHES ||
        ooms >= oomBound
      ) {
        breakPool();
      }
      notify();
    };

    // Give up on workers: everything not yet parsed runs on the main thread.
    const breakPool = (): void => {
      broken = true;
      for (const j of redispatch) j.inProcess = true;
      redispatch.length = 0;
      // Crash culprits not yet yielded get a main-thread parse instead of the error.
      for (const j of culprits.splice(0)) {
        if (!pending.has(j.seq)) continue;
        if (j.outcome) stats.pooled -= 1;
        j.outcome = undefined;
        j.inProcess = true;
      }
      for (const s of slots.splice(0)) {
        s.dead = true;
        clearTimers(s);
        for (const j of s.queue) j.inProcess = true;
        s.queue = [];
        void s.worker.terminate().catch(() => {});
      }
    };

    function clearTimers(slot: Slot<M>): void {
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.startTimer) clearTimeout(slot.startTimer);
      slot.timer = null;
      slot.startTimer = null;
    }

    // Stall timer: only for a ready worker (start-up has its own timeout).
    const armTimer = (slot: Slot<M>): void => {
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      if (!slot.ready || slot.queue.length === 0) return;
      slot.timer = setTimeout(() => {
        slot.timer = null;
        failSlot(slot, `parse worker unresponsive: no reply in ${Math.round(stallMs / 1000)}s`);
      }, stallMs);
      slot.timer.unref?.();
    };

    const spawn = (): Slot<M> | null => {
      let worker: Worker;
      try {
        worker = new Worker(url, {
          workerData: { base } satisfies ParseWorkerData,
          ...(resourceLimits ? { resourceLimits } : {}),
        });
      } catch (e) {
        // A constructor failure (bad URL, no threads) will not get better.
        logger.warn("live-ingest: parse worker failed to start; parsing on the main thread", {
          err: (e as Error).message,
        });
        breakPool();
        return null;
      }
      const slot: Slot<M> = {
        worker,
        ready: false,
        queue: [],
        timer: null,
        startTimer: null,
        dead: false,
      };
      slot.startTimer = setTimeout(() => {
        slot.startTimer = null;
        failSlot(slot, `parse worker not ready in ${Math.round(startupMs / 1000)}s`);
      }, startupMs);
      slot.startTimer.unref?.();
      worker.on("message", (msg: ParseWorkerMsg) => {
        if (slot.dead) return;
        if (msg.type === "ready") {
          slot.ready = true;
          if (slot.startTimer) clearTimeout(slot.startTimer);
          slot.startTimer = null;
          armTimer(slot);
          return;
        }
        const job = slot.queue[0];
        if (!job || job.seq !== msg.seq) {
          failSlot(slot, `parse worker protocol error: reply for ${msg.seq} out of order`);
          return;
        }
        slot.queue.shift();
        if (msg.type === "done") {
          stats.pooled += 1;
          finish(job, msg.outcome, msg.logs);
        } else {
          stats.fallbacks += 1;
          job.inProcess = true;
        }
        armTimer(slot);
        notify();
      });
      worker.on("error", (err: Error) =>
        failSlot(
          slot,
          `parse worker crashed: ${err.message}`,
          (err as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY",
        ),
      );
      worker.on("messageerror", (err: Error) =>
        failSlot(slot, `parse worker message error: ${err.message}`),
      );
      worker.on("exit", (code) => failSlot(slot, `parse worker exited with code ${code}`));
      slots.push(slot);
      return slot;
    };

    const send = (job: Job<M>): boolean => {
      if (broken) {
        job.inProcess = true;
        return true;
      }
      while (slots.length < workers && !broken) {
        if (!spawn()) break;
      }
      if (broken) {
        job.inProcess = true;
        return true;
      }
      let best: Slot<M> | null = null;
      for (const s of slots) {
        if (s.queue.length < perWorker && (!best || s.queue.length < best.queue.length)) best = s;
      }
      if (!best) return false;
      try {
        best.worker.postMessage({ seq: job.seq, member: job.member } satisfies ParseJobMsg);
      } catch {
        // Not cloneable: parse it here at its turn.
        job.inProcess = true;
        return true;
      }
      best.queue.push(job);
      if (best.queue.length === 1) armTimer(best);
      return true;
    };

    const admit = (m: M): void => {
      const job: Job<M> = { seq: nextSeq++, member: m };
      pending.set(job.seq, job);
      if (m.ref.obsolete) {
        finish(job, { kind: "skip", parseMs: 0 });
        return;
      }
      const preset = opts.preset?.(m);
      if (preset) {
        finish(job, preset);
        return;
      }
      if (!send(job)) redispatch.push(job);
    };

    const capacity = (): boolean =>
      broken || slots.length < workers || slots.some((s) => s.queue.length < perWorker);

    // Bound on members read but not yet yielded (memory).
    const window = (): number => Math.max(perWorker * workers * 2, 16);

    stats.workers = workers;
    let headIdx = 0;
    try {
      for (;;) {
        // 1. Yield every finished member at the head, in order.
        let job = pending.get(headSeq);
        while (job && (job.outcome || job.inProcess)) {
          pending.delete(headSeq);
          headSeq += 1;
          const outcome = job.outcome ?? (await parseHere(job.member));
          replay(logger, job.logs);
          yield { member: job.member, outcome };
          job = pending.get(headSeq);
        }

        // 2. Re-send orphans, then admit new members while there is room.
        while (redispatch.length > 0 && capacity()) {
          const j = redispatch[0] as Job<M>;
          if (!send(j)) break;
          redispatch.shift();
        }
        while (headIdx < head.length && pending.size < window() && capacity()) {
          const m = head[headIdx] as M;
          head[headIdx++] = undefined; // release as admitted, not after the whole head
          admit(m);
        }
        if (headIdx >= head.length && head.length > 0) head.length = headIdx = 0;
        if (
          !upstreamDone &&
          !pull &&
          head.length === 0 &&
          redispatch.length === 0 &&
          pending.size < window() &&
          capacity()
        ) {
          pull = upstream.next();
          pull.catch(() => {}); // handled by the race below; never unhandled
          pullInFlight = true;
        }

        const headReady = (() => {
          const j = pending.get(headSeq);
          return !!j && !!(j.outcome || j.inProcess);
        })();
        if (headReady) continue;
        if (pending.size === 0 && upstreamDone && !pull) break;

        // 3. Wait for a reply/crash or the next upstream member.
        const woke = new Promise<void>((resolve) => {
          wake = resolve;
        });
        if (pull) {
          const p = pull;
          const r = await Promise.race([
            p.then(
              (v) => ({ kind: "pull" as const, v }),
              (e: unknown) => ({ kind: "pullError" as const, e }),
            ),
            woke.then(() => ({ kind: "wake" as const })),
          ]);
          if (r.kind === "pull") {
            pull = null;
            pullInFlight = false;
            if (r.v.done) upstreamDone = true;
            else admit(r.v.value);
          } else if (r.kind === "pullError") {
            pull = null;
            pullInFlight = false;
            upstreamDone = true;
            pullError = r.e;
          }
        } else {
          await woke;
        }
        wake = null;
      }
      if (pullError !== null) throw pullError;
    } finally {
      for (const s of [...slots]) {
        s.dead = true;
        clearTimers(s);
        void s.worker.terminate().catch(() => {});
      }
      slots.length = 0;
    }
  }
}
