import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "../bulk-retrieve.js";

const { readWatchdogBudgets, resetTestWatchdogBudgets } = __testing;

const DEFAULT_FIRST_YIELD = 90_000;
const DEFAULT_INACTIVITY = 5 * 60_000;

describe("readWatchdogBudgets — per-source overrides", () => {
  afterEach(() => resetTestWatchdogBudgets());

  it("returns the fast defaults for ordinary sources (incl. apex)", () => {
    // Apex deliberately uses the default budget: once the rate-limit pools
    // refill correctly it first-yields well within 90s, so it does NOT need a
    // per-source override (an earlier override made it hold a scarce Tooling
    // slot and starve the pool).
    for (const label of ["lwc", "apex", undefined]) {
      expect(readWatchdogBudgets(label)).toEqual({
        firstYieldMs: DEFAULT_FIRST_YIELD,
        inactivityMs: DEFAULT_INACTIVITY,
      });
    }
  });

  it("gives the Vlocity source a much larger first-yield budget", () => {
    // Vlocity must stay inline (background-drain cannot recover it) and can
    // take minutes of setup before its first DataPack.
    const b = readWatchdogBudgets("vlocity");
    expect(b.firstYieldMs).toBeGreaterThanOrEqual(15 * 60_000);
    expect(b.inactivityMs).toBeGreaterThanOrEqual(DEFAULT_INACTIVITY);
  });

  it("does NOT raise budgets for other slow/empty sources (no pool starvation)", () => {
    // The whole point of the per-source fix: only Vlocity gets the long
    // budget. Generic sources keep the fast default so they release their
    // merger slot quickly when they wedge.
    expect(readWatchdogBudgets("generic:PermissionSetGroup").firstYieldMs).toBe(
      DEFAULT_FIRST_YIELD,
    );
    expect(readWatchdogBudgets("generic:Workflow").firstYieldMs).toBe(DEFAULT_FIRST_YIELD);
  });

  it("lets an explicit env-var override win over the per-source default", () => {
    __testing.setTestWatchdogBudgets({ firstYieldMs: 1234, inactivityMs: 5678 });
    expect(readWatchdogBudgets("vlocity")).toEqual({ firstYieldMs: 1234, inactivityMs: 5678 });
    expect(readWatchdogBudgets("apex")).toEqual({ firstYieldMs: 1234, inactivityMs: 5678 });
  });
});
