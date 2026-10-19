import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { __testing as bulkRetrieveTesting } from "../bulk-retrieve.js";
import { IncompleteSourceError } from "../retry.js";

/**
 * Review I1: a source that wedges past the watchdog is parked for the
 * post-merge late drain. Whatever goes wrong AFTER that point (a late
 * IncompleteSourceError, the late-drain budget running out mid-stream, cap
 * eviction) used to surface only as a `wedge:*` warning — no skip, so
 * `--retry-skipped` had nothing to re-run and the run reported success with
 * missing rows. Each of those outcomes must now reach the source's onError
 * (the skipReport hook) under the source's own label.
 */

const { failSoft, createWedgeCoordinator, drainBackgroundWedge } = bulkRetrieveTesting;

function member(name: string): RawMember {
  return {
    ref: {
      category: "ApexClass" as const,
      memberType: "ApexClass",
      memberName: name,
      lastModifiedAt: null,
      sourceUri: "",
    },
    content: "",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wedges past the first-yield watchdog, then yields `n` rows and either ends,
 *  throws `throwAfter`, or keeps going slowly (`trickleMs` between rows). */
function lateSource(opts: {
  wedgeMs: number;
  n: number;
  throwAfter?: Error;
  trickleMs?: number;
}): () => AsyncIterable<RawMember> {
  return async function* () {
    await sleep(opts.wedgeMs);
    for (let i = 0; i < opts.n; i += 1) {
      if (opts.trickleMs && i > 0) await sleep(opts.trickleMs);
      yield member(`Late${i}`);
    }
    if (opts.throwAfter) throw opts.throwAfter;
  };
}

async function hangForever(): Promise<never> {
  return new Promise<never>(() => {});
}

async function* neverYields(): AsyncIterable<RawMember> {
  yield await hangForever();
}

async function runWedged(
  label: string,
  factory: () => AsyncIterable<RawMember>,
  coordinator: ReturnType<typeof createWedgeCoordinator>,
  onError: (label: string, err: Error) => void,
): Promise<void> {
  // failSoft returns as soon as the watchdog fires; nothing is yielded inline.
  for await (const _ of failSoft(label, factory, onError, coordinator)) {
    /* inline rows (none expected) */
  }
}

describe("background wedge failures become skips (review I1)", () => {
  beforeEach(() => {
    bulkRetrieveTesting.setTestWatchdogBudgets({ firstYieldMs: 50, inactivityMs: 5_000 });
  });
  afterEach(() => {
    bulkRetrieveTesting.resetTestWatchdogBudgets();
  });

  it("a late IncompleteSourceError is reported to onError under the source label", async () => {
    const skips: Array<{ label: string; err: Error }> = [];
    const coordinator = createWedgeCoordinator([], { lateDrainBudgetMs: 5_000 });
    await runWedged(
      "apex",
      lateSource({
        wedgeMs: 120,
        n: 2,
        throwAfter: new IncompleteSourceError("apex", [
          { name: "ApexClass", error: new Error("drain truncated at page 3") },
        ]),
      }),
      coordinator,
      (label, err) => skips.push({ label, err }),
    );
    expect(skips).toEqual([]); // wedge itself is not a skip
    const entry = coordinator.backgroundWedges[0];
    expect(entry).toBeDefined();
    const late: RawMember[] = [];
    for await (const m of drainBackgroundWedge(entry!, 5_000, coordinator.warnings)) late.push(m);

    expect(late.map((m) => m.ref.memberName)).toEqual(["Late0", "Late1"]);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.label).toBe("apex");
    expect(skips[0]?.err.message).toMatch(/drain truncated/);
    expect(coordinator.warnings.some((w) => w.startsWith("wedge:apex:lateError"))).toBe(true);
  });

  it("an exhausted late-drain budget records a skip instead of a silent synthetic done", async () => {
    const skips: Array<{ label: string; err: Error }> = [];
    const coordinator = createWedgeCoordinator([], { lateDrainBudgetMs: 400 });
    await runWedged(
      "apex",
      lateSource({ wedgeMs: 100, n: 1000, trickleMs: 100 }),
      coordinator,
      (label, err) => skips.push({ label, err }),
    );
    const entry = coordinator.backgroundWedges[0]!;
    const late: RawMember[] = [];
    for await (const m of drainBackgroundWedge(entry, 400, coordinator.warnings)) late.push(m);

    expect(late.length).toBeGreaterThan(0);
    expect(late.length).toBeLessThan(1000);
    expect(skips).toHaveLength(1);
    expect(skips[0]?.label).toBe("apex");
    expect(skips[0]?.err.message).toMatch(/late-drain budget exhausted/);
  });

  it("a wedge that finishes inside the budget records no skip", async () => {
    const skips: Array<{ label: string; err: Error }> = [];
    const coordinator = createWedgeCoordinator([], { lateDrainBudgetMs: 5_000 });
    await runWedged("flow", lateSource({ wedgeMs: 100, n: 3 }), coordinator, (label, err) =>
      skips.push({ label, err }),
    );
    const late: RawMember[] = [];
    for await (const m of drainBackgroundWedge(
      coordinator.backgroundWedges[0]!,
      5_000,
      coordinator.warnings,
    )) {
      late.push(m);
    }
    expect(late).toHaveLength(3);
    expect(skips).toEqual([]);
    expect(coordinator.warnings.some((w) => w.startsWith("wedge:flow:resolvedLate"))).toBe(true);
  });

  it("a wedge evicted by the background cap records a skip (once)", async () => {
    const skips: Array<{ label: string; err: Error }> = [];
    const coordinator = createWedgeCoordinator([], {
      maxBackgroundWedges: 1,
      lateDrainBudgetMs: 200,
    });
    const onError = (label: string, err: Error) => skips.push({ label, err });
    await runWedged("generic:Layout", neverYields, coordinator, onError);
    await runWedged("generic:FlexiPage", neverYields, coordinator, onError);

    expect(skips.map((s) => s.label)).toEqual(["generic:Layout"]);
    expect(skips[0]?.err.message).toMatch(/evicted/);

    // Draining the evicted entry must not add a second skip for it; the
    // surviving entry runs out of budget and gets its own.
    for (const entry of coordinator.backgroundWedges) {
      for await (const _ of drainBackgroundWedge(entry, 200, coordinator.warnings)) {
        /* none */
      }
    }
    expect(skips.map((s) => s.label)).toEqual(["generic:Layout", "generic:FlexiPage"]);
    expect(skips[1]?.err.message).toMatch(/late-drain budget exhausted/);
  });
});
