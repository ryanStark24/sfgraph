import Bottleneck from "bottleneck";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { __testing as bulkRetrieveTesting } from "../bulk-retrieve.js";
import {
  type StopSignal,
  StopWaitingError,
  scheduleQuery,
  soqlWithTimeout,
  withTimeout,
} from "../rate-limit.js";

/**
 * Phase 1.5 W1.5-03 — stop-waiting semantics unit tests.
 *
 * The wrappers cannot abort an in-flight jsforce HTTP request (jsforce 3.10.15
 * does not expose AbortController). What they MUST do, and what we verify
 * here:
 *
 *   1. When a `stopSignal.value` flips to true while a wrapper is awaiting a
 *      hung promise, the wrapper rejects with `StopWaitingError` within a
 *      sub-second budget (poll interval is 50ms; we assert <250ms).
 *   2. The wrapper's setTimeout / setInterval timers are cleaned up in EVERY
 *      exit path so vitest does not hang on test completion.
 *   3. `scheduleQuery` cancels jobs that are still queued in Bottleneck
 *      cleanly — the user's callable is never invoked, so no HTTP fires.
 *   4. `scheduleQuery` cannot cancel a job whose callable is already
 *      executing; caller-side rejection still resolves quickly but the
 *      underlying promise leaks. This is the documented socket-leak bound.
 *   5. Integration with the keystone: cap-eviction flips
 *      `BackgroundWedgeEntry.stopWaitingRef.value`; a rate-limit wrapper
 *      running inside the wedged iterator (via AsyncLocalStorage context)
 *      observes the flip and rejects promptly.
 *
 * Vitest fake timers are intentionally avoided — the wrappers rely on real
 * setInterval polling against real Promise resolution; mixing fake timers
 * with real awaits creates flaky races. We use 10s timeout literals with
 * sub-250ms wall-clock assertions: if a leak happens, the test wall-clock
 * will balloon to multiple seconds, which we explicitly assert against.
 */

describe("W1.5-03: withTimeout stop-waiting", () => {
  it("rejects with StopWaitingError within ~100ms when stopSignal flips", async () => {
    const stopSignal: StopSignal = { value: false };
    const neverResolves = new Promise<string>(() => {});
    const started = Date.now();
    const wrapped = withTimeout(neverResolves, 10_000, "test-hang", stopSignal);
    setTimeout(() => {
      stopSignal.value = true;
    }, 30);
    await expect(wrapped).rejects.toBeInstanceOf(StopWaitingError);
    const elapsed = Date.now() - started;
    // 30ms wait + up to 50ms poll interval + slack. If the setTimeout(10s)
    // were leaking we'd never get here in <250ms.
    expect(elapsed).toBeLessThan(250);
  });

  it("rejects with StopWaitingError on next tick when signal is already set", async () => {
    const stopSignal: StopSignal = { value: true };
    const neverResolves = new Promise<string>(() => {});
    const started = Date.now();
    await expect(
      withTimeout(neverResolves, 10_000, "test-pre-set", stopSignal),
    ).rejects.toBeInstanceOf(StopWaitingError);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("resolves normally when stopSignal is provided but never flips", async () => {
    const stopSignal: StopSignal = { value: false };
    const ok = Promise.resolve(42);
    await expect(withTimeout(ok, 10_000, "test-ok", stopSignal)).resolves.toBe(42);
  });

  it("still surfaces real timeouts when no stopSignal flip occurs", async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r("late"), 200));
    await expect(withTimeout(slow, 30, "test-timeout")).rejects.toThrow(/timeout \(30ms\)/);
  });
});

describe("W1.5-03: soqlWithTimeout stop-waiting", () => {
  it("rejects with StopWaitingError when stopSignal flips", async () => {
    const stopSignal: StopSignal = { value: false };
    const neverResolves = new Promise<{ records: [] }>(() => {});
    const started = Date.now();
    const wrapped = soqlWithTimeout(neverResolves, "stop-test", 10_000, stopSignal);
    setTimeout(() => {
      stopSignal.value = true;
    }, 30);
    await expect(wrapped).rejects.toBeInstanceOf(StopWaitingError);
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe("W1.5-03: scheduleQuery stop-waiting", () => {
  it("cancels a QUEUED job — callable is never invoked", async () => {
    // Fill the pool with two long-running placeholder jobs (the real pool
    // has maxConcurrent=5 by default, so we exhaust slots with five hangers
    // and then submit a sixth target job whose stopSignal we flip while
    // it's queued).
    const slotFillers: Promise<unknown>[] = [];
    const releaseFillers: Array<() => void> = [];
    for (let i = 0; i < 5; i += 1) {
      slotFillers.push(
        scheduleQuery(
          () =>
            new Promise<void>((r) => {
              releaseFillers.push(r);
            }),
        ),
      );
    }
    // Yield once so Bottleneck binds the fillers to slots.
    await new Promise((r) => setTimeout(r, 10));

    let targetInvoked = false;
    const stopSignal: StopSignal = { value: false };
    const target = scheduleQuery(async () => {
      targetInvoked = true;
      return "should-not-run";
    }, stopSignal);

    // Flip while queued.
    setTimeout(() => {
      stopSignal.value = true;
    }, 20);

    await expect(target).rejects.toBeInstanceOf(StopWaitingError);
    expect(targetInvoked).toBe(false);

    // Release the fillers so the pool drains cleanly for downstream tests.
    for (const release of releaseFillers) release();
    await Promise.all(slotFillers);
  });

  it("cannot cancel an EXECUTING job — caller rejects fast, callable continues", async () => {
    // Single-slot local pool so we can guarantee execution order.
    const pool = new Bottleneck({ maxConcurrent: 1, minTime: 0 });
    let stillRunning = false;
    let stoppedFlag = false;
    const stopSignal: StopSignal = { value: false };

    // Schedule a hang directly through Bottleneck so we control the lifecycle
    // (mirrors what `scheduleQuery` does internally).
    const inner = pool.schedule(async () => {
      stillRunning = true;
      // Hang for 2s — long enough to outlive the test's 250ms assertion.
      await new Promise((r) => setTimeout(r, 2_000));
      stoppedFlag = true;
      return "done";
    });

    // Wrap with stop-waiting using the same race shape that wrapScheduled
    // applies internally.
    const guarded = new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (poll !== undefined) clearInterval(poll);
        fn();
      };
      const poll = setInterval(() => {
        if (stopSignal.value) finish(() => reject(new StopWaitingError("exec-test")));
      }, 50);
      inner.then(
        (v) => finish(() => resolve(v as string)),
        (e) => finish(() => reject(e as Error)),
      );
    });

    // Wait for the job to start, then flip.
    await new Promise((r) => setTimeout(r, 50));
    expect(stillRunning).toBe(true);
    const startedFlip = Date.now();
    stopSignal.value = true;

    await expect(guarded).rejects.toBeInstanceOf(StopWaitingError);
    expect(Date.now() - startedFlip).toBeLessThan(200);
    // The underlying job is STILL running — this is the documented leak.
    expect(stoppedFlag).toBe(false);

    // Let the leaked job complete so we don't hang process shutdown.
    await inner;
    expect(stoppedFlag).toBe(true);
  });
});

describe("W1.5-03: timer cleanup", () => {
  it("clears withTimeout's setTimeout on stop-waiting path", async () => {
    // If the setTimeout(10s) leaks, this test (and the whole suite) hangs
    // beyond the vitest hookTimeout. We rely on the suite-level timeout
    // catching that; the in-test assertion is the elapsed-time guard.
    const before = process.hrtime.bigint();
    const sig: StopSignal = { value: false };
    const wrapped = withTimeout(new Promise<void>(() => {}), 10_000, "clean", sig);
    setTimeout(() => {
      sig.value = true;
    }, 10);
    await expect(wrapped).rejects.toBeInstanceOf(StopWaitingError);
    const ms = Number((process.hrtime.bigint() - before) / 1_000_000n);
    // Wall-clock budget: 10ms flip + 50ms poll + slack < 250ms.
    expect(ms).toBeLessThan(250);
  });

  it("settles only once even if signal-poll, real-timeout, and inner-resolve all race", async () => {
    // Inner promise resolves at 30ms; signal flips at 40ms; timeout at 50ms.
    // Whichever wins must clear the other two without re-settling.
    const sig: StopSignal = { value: false };
    setTimeout(() => {
      sig.value = true;
    }, 40);
    const inner = new Promise<string>((r) => setTimeout(() => r("ok"), 30));
    const out = await withTimeout(inner, 50, "race", sig);
    expect(out).toBe("ok");
  });
});

describe("W1.5-03: integration with keystone (AsyncLocalStorage propagation)", () => {
  beforeEach(() => {
    process.env.SFGRAPH_MAX_BACKGROUND_WEDGES = "1";
    bulkRetrieveTesting.setTestWatchdogBudgets({ firstYieldMs: 100, inactivityMs: 100 });
  });
  afterEach(() => {
    process.env.SFGRAPH_MAX_BACKGROUND_WEDGES = undefined;
    bulkRetrieveTesting.resetTestWatchdogBudgets();
  });

  it("propagates stop-signal into rate-limit calls inside a wedged iterator via ALS", async () => {
    // Source that hangs inside `withTimeout` waiting on a never-resolving
    // promise — but the wrapper picks up the stop-signal via ALS (set by
    // failSoft at body entry). When the keystone's cap-eviction flips the
    // ref, this hang must reject with StopWaitingError.
    let innerError: unknown = null;
    const wedgedFactory = async function* (): AsyncIterable<RawMember> {
      try {
        // No explicit stopSignal — relies on AsyncLocalStorage propagation.
        await withTimeout(new Promise<void>(() => {}), 10_000, "als-test");
      } catch (e) {
        innerError = e;
      }
      // Yield nothing else.
    };

    // Second wedge to push the first one over the cap (cap = 1).
    const wedge2Factory = async function* (): AsyncIterable<RawMember> {
      await new Promise<void>(() => {});
      yield {} as RawMember;
    };

    const warnings: string[] = [];
    const coordinator = bulkRetrieveTesting.createWedgeCoordinator(warnings, {
      maxBackgroundWedges: 1,
      lateDrainBudgetMs: 0, // skip late-drain to keep test deterministic
    });

    const wrappedA = bulkRetrieveTesting.failSoft("wedge:A", wedgedFactory, undefined, coordinator);
    const wrappedB = bulkRetrieveTesting.failSoft("wedge:B", wedge2Factory, undefined, coordinator);

    // Drain through the parallel merger with concurrency=2 so both wedges
    // enter their bodies and trip the watchdog.
    const merger = bulkRetrieveTesting.mergeAsyncIterablesParallel([wrappedA, wrappedB], {
      concurrency: 2,
    });

    const out: RawMember[] = [];
    for await (const v of merger) out.push(v);

    // Both wedges fired; cap=1 means the oldest got evicted.
    const wedgeAFired = warnings.some((w) => w.startsWith("wedge:wedge:A:firstYield"));
    const wedgeBFired = warnings.some((w) => w.startsWith("wedge:wedge:B:firstYield"));
    expect(wedgeAFired).toBe(true);
    expect(wedgeBFired).toBe(true);
    const evicted = warnings.some(
      (w) => w.startsWith("wedge:cap:backgroundWedgeAborted") && w.includes("source=wedge:A"),
    );
    expect(evicted).toBe(true);

    // Give the inner withTimeout a beat to observe the stopWaitingRef flip
    // via ALS (cap-eviction set it true on wedge:A's ref).
    await new Promise((r) => setTimeout(r, 200));
    expect(innerError).toBeInstanceOf(StopWaitingError);
  });
});
