import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLivenessProbe } from "../liveness.js";

/**
 * Liveness-probe tests. The probe runs an interval that polls
 * `conn.identity()` and counts consecutive failures. The contract:
 *
 *   - On success: counter resets, no log noise.
 *   - First N-1 failures: warning log "(N/maxFailures)", `isDead()` still false.
 *   - Nth consecutive failure: `dead` flips true, CONNECTION LOST log
 *     fires once, onDead callback invoked once.
 *   - After the dead flip: further failures don't re-log or re-fire onDead.
 *   - stop() clears the interval so the probe stops polling.
 *
 * Uses vitest fake timers + a stub conn whose identity() can be flipped
 * between resolving/rejecting/hanging between ticks.
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function makeConn(behavior: { mode: "ok" | "reject" | "hang" }) {
  // Async function so the call returns a real Promise the probe can race
  // its timeout against. `hang` mode never resolves.
  return {
    identity: vi.fn(async () => {
      if (behavior.mode === "ok") return { user_id: "0050x000000fake" };
      if (behavior.mode === "reject") throw new Error("simulated reject");
      return new Promise(() => {
        /* hang forever */
      });
    }),
  };
}

describe("startLivenessProbe", () => {
  it("never logs / never fires onDead while identity() succeeds", async () => {
    const conn = makeConn({ mode: "ok" });
    const logs: string[] = [];
    const onDead = vi.fn();
    const probe = startLivenessProbe(conn, {
      intervalMs: 1000,
      identityTimeoutMs: 200,
      maxFailures: 2,
      onDead,
      log: (l) => logs.push(l),
    });
    // Advance 5 intervals.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(probe.isDead()).toBe(false);
    expect(probe.failureCount()).toBe(0);
    expect(onDead).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    probe.stop();
  });

  it("warns at consecutive-failure 1/2 then fires CONNECTION LOST at 2/2", async () => {
    const conn = makeConn({ mode: "reject" });
    const logs: string[] = [];
    const onDead = vi.fn();
    const probe = startLivenessProbe(conn, {
      intervalMs: 1000,
      identityTimeoutMs: 200,
      maxFailures: 2,
      onDead,
      log: (l) => logs.push(l),
    });
    // First tick — soft warning.
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.failureCount()).toBe(1);
    expect(probe.isDead()).toBe(false);
    expect(onDead).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("(1/2)"))).toBe(true);

    // Second tick — flips to dead, fires onDead once, logs banner.
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.isDead()).toBe(true);
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("CONNECTION LOST"))).toBe(true);

    // Further ticks — probe is short-circuited via the `dead` check; no
    // further log entries, no further onDead calls.
    const logsAfterDead = logs.length;
    const deadCalls = onDead.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(onDead.mock.calls.length).toBe(deadCalls);
    expect(logs.length).toBe(logsAfterDead);

    probe.stop();
  });

  it("counts a hung identity() (timeout) as a failure", async () => {
    const conn = makeConn({ mode: "hang" });
    const logs: string[] = [];
    const probe = startLivenessProbe(conn, {
      intervalMs: 1000,
      identityTimeoutMs: 200,
      maxFailures: 2,
      log: (l) => logs.push(l),
    });
    // Each tick: probe fires at t=1000, identity hangs, 200ms later the
    // withDeadline rejects. So we need to advance 1000 + 200 to let one
    // failure register.
    await vi.advanceTimersByTimeAsync(1200);
    expect(probe.failureCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1200);
    expect(probe.isDead()).toBe(true);
    expect(logs.some((l) => l.includes("CONNECTION LOST"))).toBe(true);
    probe.stop();
  });

  it("resets the failure counter on a successful tick after a failure", async () => {
    // Connection that fails the first 2 ticks then succeeds.
    let n = 0;
    const conn = {
      identity: async () => {
        n += 1;
        if (n <= 1) throw new Error("first one fails");
        return { user_id: "ok" };
      },
    };
    const logs: string[] = [];
    const probe = startLivenessProbe(conn, {
      intervalMs: 1000,
      identityTimeoutMs: 200,
      maxFailures: 3, // threshold higher than fail-count, so we don't trip
      log: (l) => logs.push(l),
    });
    await vi.advanceTimersByTimeAsync(1000); // fail #1
    expect(probe.failureCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000); // success → resets
    expect(probe.failureCount()).toBe(0);
    expect(probe.isDead()).toBe(false);
    probe.stop();
  });

  it("stop() halts further polling", async () => {
    const conn = makeConn({ mode: "ok" });
    const probe = startLivenessProbe(conn, {
      intervalMs: 1000,
      identityTimeoutMs: 200,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const callsBefore = conn.identity.mock.calls.length;
    probe.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(conn.identity.mock.calls.length).toBe(callsBefore);
  });
});
