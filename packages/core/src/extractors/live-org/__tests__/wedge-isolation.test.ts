import { describe, expect, it } from "vitest";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { __testing as bulkRetrieveTesting } from "../bulk-retrieve.js";

/**
 * Phase 1.5 W1.5-01 + W1.5-02 unit tests.
 *
 * Contract under test:
 *   - The watchdog clock for a `failSoft`-wrapped source starts at SLOT
 *     ACQUISITION (body-entry of the wrapped async generator), not at
 *     source REGISTRATION. A wedged source must not consume the clock
 *     budget of queued-but-not-yet-executing neighbors.
 *   - When the watchdog fires for a wedged source, the merger's slot is
 *     released within ~one tick (the failSoft generator returns,
 *     mergeAsyncIterablesParallel sees `done:true`, advance(nextIdx) runs).
 *   - A namespaced warning is emitted into the shared `warnings` array.
 *   - The wedged iterator is parked into a background-wedge set; if it
 *     eventually yields, the record reaches the output stream with
 *     `attributes.lateYield === true`.
 *   - The background-wedge set is bounded by SFGRAPH_MAX_BACKGROUND_WEDGES.
 *     When the cap is exceeded, the oldest entry's stopWaiting flag is
 *     set and a `wedge:cap:backgroundWedgeAborted:...` warning fires.
 *
 * Tests run against `bulkRetrieve` end-to-end with a mock connection that
 * causes specific sources to wedge. Real timers are used (not fake) so
 * the watchdog's setTimeout interacts with real iterator promises; budgets
 * are squeezed via env vars to keep the suite fast.
 *
 * Note on backgrounds-wedge cap test (test 3): the production cap is 4 by
 * default; we set it to 2 via env var at module import time. We do NOT
 * use vi.useFakeTimers() because the watchdog is implemented with real
 * setTimeout — fake timers would prevent the iterator-vs-timeout race
 * from advancing and the test would hang.
 */

/** Async generator: never yields, never resolves. Used as a wedge factory. */
async function* hangForever(): AsyncIterable<RawMember> {
  await new Promise<void>(() => {
    /* hang */
  });
  yield {
    ref: {
      category: "ApexClass" as const,
      memberType: "ApexClass",
      memberName: "Never",
      lastModifiedAt: null,
      sourceUri: "",
    },
    content: "",
  };
}

/** Async generator: hangs for `wedgeMs` ms then yields one record, then
 *  ends. Used to simulate a source that eventually resolves AFTER the
 *  watchdog has already released its slot — the late-yield case. */
function delayedYield(wedgeMs: number, memberName: string): () => AsyncIterable<RawMember> {
  return async function* () {
    await new Promise((r) => setTimeout(r, wedgeMs));
    yield {
      ref: {
        category: "ApexClass" as const,
        memberType: "ApexClass",
        memberName,
        lastModifiedAt: null,
        sourceUri: "",
      },
      content: "",
    };
  };
}

/** Async generator: yields N synthetic ApexClass records back-to-back, then
 *  ends. Used as a healthy neighbor source. */
function healthySource(count: number, prefix: string): () => AsyncIterable<RawMember> {
  return async function* () {
    for (let i = 0; i < count; i += 1) {
      yield {
        ref: {
          category: "ApexClass" as const,
          memberType: "ApexClass",
          memberName: `${prefix}-${i}`,
          lastModifiedAt: null,
          sourceUri: "",
        },
        content: "",
      };
    }
  };
}

describe("W1.5-01: watchdog clock starts at slot acquisition", () => {
  it("does not advance clock for queued sources while a wedged source holds its slot", async () => {
    // Setup: 2 sources, concurrency=1 (set via env), source A wedges,
    // source B is queued. Watchdog firstYield budget is 200ms (test-only
    // tight budget). Expectation: source B starts EXECUTING only after
    // A's slot is released by the watchdog. B's own clock starts at that
    // moment, NOT 200ms earlier when the merger was registered.
    const warnings: string[] = [];
    const sourceALabel = "test:A";
    const sourceBLabel = "test:B";

    const aStartRef = { value: 0 };
    const bStartRef = { value: 0 };

    // failSoft is not exported; use the testing entry point.
    const merger = bulkRetrieveTesting.mergeAsyncIterablesParallel;
    const failSoft = bulkRetrieveTesting.failSoft;
    const makeCoordinator = bulkRetrieveTesting.createWedgeCoordinator;

    const coordinator = makeCoordinator(warnings);
    // Tight test budget: 150ms first-yield.
    bulkRetrieveTesting.setTestWatchdogBudgets({ firstYieldMs: 150, inactivityMs: 60_000 });

    try {
      // Concurrency=1 so B has to wait for A's slot.
      const sources = [
        failSoft(sourceALabel, hangForever, undefined, coordinator, aStartRef),
        failSoft(sourceBLabel, healthySource(2, "B"), undefined, coordinator, bStartRef),
      ];
      const start = Date.now();
      const out: RawMember[] = [];
      // Override concurrency via the merger's optional second arg (test
      // hook): pass concurrency=1.
      for await (const m of merger(sources, { concurrency: 1 })) {
        out.push(m);
      }
      const elapsed = Date.now() - start;

      // B's records should all be present (source A wedged, source B drained).
      const bNames = out.map((m) => m.ref.memberName).filter((n) => n.startsWith("B-"));
      expect(bNames.sort()).toEqual(["B-0", "B-1"]);

      // Source A's clock should have started near `start` (it acquired the
      // slot first).
      expect(aStartRef.value).toBeGreaterThanOrEqual(start);
      expect(aStartRef.value).toBeLessThan(start + 80);

      // Source B's clock should have started AFTER A's watchdog fired —
      // i.e., at least 150ms (firstYield budget) after A's start. NOT at
      // registration time (which is `start`).
      expect(bStartRef.value).toBeGreaterThanOrEqual(aStartRef.value + 140);

      // Total elapsed: A wedges (~150ms) + B drains (~0ms) = ~150-300ms.
      expect(elapsed).toBeLessThan(800);

      // Exactly one wedge:test:A:firstYield:... warning fired.
      const aWedges = warnings.filter((w) => w.startsWith(`wedge:${sourceALabel}:firstYield:`));
      expect(aWedges.length).toBe(1);
    } finally {
      bulkRetrieveTesting.resetTestWatchdogBudgets();
    }
  });
});

describe("W1.5-02: soft-isolate on wedge", () => {
  it("releases slot, emits namespaced warning, runs queued neighbor", async () => {
    const warnings: string[] = [];
    const coordinator = bulkRetrieveTesting.createWedgeCoordinator(warnings);
    bulkRetrieveTesting.setTestWatchdogBudgets({ firstYieldMs: 100, inactivityMs: 60_000 });

    try {
      const sources = [
        bulkRetrieveTesting.failSoft("wedger", hangForever, undefined, coordinator),
        bulkRetrieveTesting.failSoft("healthy", healthySource(3, "H"), undefined, coordinator),
      ];
      const out: RawMember[] = [];
      for await (const m of bulkRetrieveTesting.mergeAsyncIterablesParallel(sources, {
        concurrency: 1,
      })) {
        out.push(m);
      }

      // Healthy source drained completely.
      const hCount = out.filter((m) => m.ref.memberName.startsWith("H-")).length;
      expect(hCount).toBe(3);

      // Exactly one wedge warning emitted with the right shape.
      const w = warnings.find((s) => s.startsWith("wedge:wedger:firstYield:"));
      expect(w).toBeTruthy();
      // <stageDetail> is `${firstYieldMs/1000}s`; with a 100ms test budget
      // that's `0.1s` — the regex must accept decimals.
      expect(w).toMatch(/^wedge:wedger:firstYield:[\d.]+s:lastYielded=<none>:wedgedForMs=\d+$/);

      // No error propagated up — for-await completed normally.
    } finally {
      bulkRetrieveTesting.resetTestWatchdogBudgets();
    }
  });
});

describe("W1.5-02: background-wedge cap", () => {
  it("sets stopWaiting=true on oldest entries when SFGRAPH_MAX_BACKGROUND_WEDGES is exceeded", async () => {
    const warnings: string[] = [];
    // Override the cap to 2 via the test-only setter.
    const coordinator = bulkRetrieveTesting.createWedgeCoordinator(warnings, {
      maxBackgroundWedges: 2,
    });
    bulkRetrieveTesting.setTestWatchdogBudgets({ firstYieldMs: 80, inactivityMs: 60_000 });

    try {
      // 4 wedging sources. With concurrency=1 they wedge sequentially:
      // - W1 wedges at ~80ms (slot released, registered as bg-wedge #1)
      // - W2 acquires slot, wedges at ~160ms (bg-wedge #2; cap not exceeded)
      // - W3 acquires slot, wedges at ~240ms (would be bg-wedge #3, cap=2,
      //   so W1 evicted with stopWaiting=true)
      // - W4 acquires slot, wedges at ~320ms (would be bg-wedge #4, cap=2,
      //   so W2 evicted with stopWaiting=true)
      const sources = [
        bulkRetrieveTesting.failSoft("w1", hangForever, undefined, coordinator),
        bulkRetrieveTesting.failSoft("w2", hangForever, undefined, coordinator),
        bulkRetrieveTesting.failSoft("w3", hangForever, undefined, coordinator),
        bulkRetrieveTesting.failSoft("w4", hangForever, undefined, coordinator),
      ];
      const out: RawMember[] = [];
      // Set the late-drain budget to 0 — we don't want to wait at the end.
      coordinator.lateDrainBudgetMs = 0;
      for await (const m of bulkRetrieveTesting.mergeAsyncIterablesParallel(sources, {
        concurrency: 1,
      })) {
        out.push(m);
      }
      expect(out.length).toBe(0);
      expect(coordinator.backgroundWedges.length).toBe(4);

      // Find each entry by label.
      const byLabel = new Map(coordinator.backgroundWedges.map((e) => [e.label, e]));
      // Cap=2, with 4 wedges admitted in sequence: at the moment W3 is
      // admitted the active count would become 3; oldest (W1) is evicted.
      // When W4 is admitted the active count would become 3 again
      // (W2 + W3 + W4); oldest active (W2) is evicted.
      expect(byLabel.get("w1")?.stopWaitingRef.value).toBe(true);
      expect(byLabel.get("w2")?.stopWaitingRef.value).toBe(true);
      expect(byLabel.get("w3")?.stopWaitingRef.value).toBe(false);
      expect(byLabel.get("w4")?.stopWaitingRef.value).toBe(false);

      // Exactly 2 backgroundWedgeAborted warnings — one per eviction.
      const aborts = warnings.filter((w) => w.startsWith("wedge:cap:backgroundWedgeAborted:"));
      expect(aborts.length).toBe(2);
      // First eviction names w1; second names w2.
      expect(aborts[0]).toContain("source=w1");
      expect(aborts[1]).toContain("source=w2");
    } finally {
      bulkRetrieveTesting.resetTestWatchdogBudgets();
    }
  });
});

describe("W1.5-02: late-yield drain", () => {
  it("drains late records with attributes.lateYield=true and emits resolvedLate warning", async () => {
    const warnings: string[] = [];
    const coordinator = bulkRetrieveTesting.createWedgeCoordinator(warnings);
    // Late-drain budget: 600ms — generous enough to catch the delayed yield.
    coordinator.lateDrainBudgetMs = 600;
    bulkRetrieveTesting.setTestWatchdogBudgets({ firstYieldMs: 100, inactivityMs: 60_000 });

    try {
      // Wedger first-yields after 250ms — well past the 100ms watchdog —
      // so it gets parked into background. The late-drain should observe
      // its first record arriving and tag it.
      const sources = [
        bulkRetrieveTesting.failSoft("tardy", delayedYield(250, "T-late"), undefined, coordinator),
        bulkRetrieveTesting.failSoft("fast", healthySource(1, "F"), undefined, coordinator),
      ];
      const out: RawMember[] = [];
      for await (const m of bulkRetrieveTesting.mergeAsyncIterablesParallel(sources, {
        concurrency: 1,
      })) {
        out.push(m);
      }

      // The drainBackgroundWedge pass happens inside bulkRetrieve, not the
      // merger. The merger test here doesn't run that pass — invoke it
      // explicitly via the testing handle.
      for (const entry of coordinator.backgroundWedges) {
        for await (const m of bulkRetrieveTesting.drainBackgroundWedge(
          entry,
          coordinator.lateDrainBudgetMs,
          coordinator.warnings,
        )) {
          out.push(m);
        }
      }

      // Fast source's record is present, plus the late record with the tag.
      const lateRecord = out.find((m) => m.ref.memberName === "T-late");
      expect(lateRecord).toBeTruthy();
      expect(lateRecord?.attributes?.lateYield).toBe(true);

      // resolvedLate warning emitted.
      const resolved = warnings.find((w) => w.startsWith("wedge:tardy:resolvedLate:"));
      expect(resolved).toBeTruthy();
      expect(resolved).toContain("records=1");

      // No error propagated.
    } finally {
      bulkRetrieveTesting.resetTestWatchdogBudgets();
    }
  });
});
