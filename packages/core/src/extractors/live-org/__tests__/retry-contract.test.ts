import { afterEach, describe, expect, it, vi } from "vitest";
import { ReadOnlyViolationError } from "../errors.js";
import { StopWaitingError } from "../rate-limit.js";
import {
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  resolveRetryOptions,
  retryDelayMs,
  withRetry,
} from "../retry.js";

/** Review M8: the never-retry half of the retry contract was unguarded. */
describe("withRetry — errors that must never be retried", () => {
  const cases: Array<[string, () => Error]> = [
    ["StopWaitingError (cap eviction)", () => new StopWaitingError("apex")],
    ["ReadOnlyViolationError (read-only guard)", () => new ReadOnlyViolationError("blocked")],
    [
      "INVALID_TYPE org rejection",
      () =>
        Object.assign(new Error("sObject type 'Foo' is not supported"), {
          errorCode: "INVALID_TYPE",
        }),
    ],
    ["INSUFFICIENT_ACCESS org rejection", () => new Error("INSUFFICIENT_ACCESS: no view setup")],
  ];
  for (const [label, make] of cases) {
    it(`calls fn exactly once for ${label}`, async () => {
      const fn = vi.fn(async () => {
        throw make();
      });
      await expect(withRetry(fn, { retries: 3, retryBackoffMs: 0 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  }

  it("retries a transient error `retries` times, then rethrows it", async () => {
    const fn = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(withRetry(fn, { retries: 3, retryBackoffMs: 0 })).rejects.toThrow(
      "socket hang up",
    );
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

/** Review M3: env overrides are parsed strictly and the backoff is bounded. */
describe("retry options — strict parsing and caps", () => {
  const KEYS = ["SFGRAPH_FETCH_RETRIES", "SFGRAPH_LIVE_RETRY_BASE_MS"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it("rejects non-integer env values instead of truncating them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SFGRAPH_FETCH_RETRIES = "1e3";
    expect(resolveRetryOptions().retries).toBe(3); // default, not 1
    process.env.SFGRAPH_LIVE_RETRY_BASE_MS = "2s";
    expect(resolveRetryOptions().retryBackoffMs).not.toBe(2);
    warn.mockRestore();
  });

  it("caps the retry count", () => {
    process.env.SFGRAPH_FETCH_RETRIES = "20";
    expect(resolveRetryOptions().retries).toBe(MAX_RETRIES);
    expect(resolveRetryOptions({ retries: 50 }).retries).toBe(MAX_RETRIES);
    expect(MAX_RETRIES).toBeLessThanOrEqual(10);
  });

  it("caps each backoff sleep", () => {
    expect(retryDelayMs(2_000, 0)).toBe(2_000);
    expect(retryDelayMs(2_000, 3)).toBe(16_000);
    expect(retryDelayMs(2_000, 9)).toBe(MAX_RETRY_DELAY_MS);
    expect(retryDelayMs(2_000, 40)).toBe(MAX_RETRY_DELAY_MS);
    expect(MAX_RETRY_DELAY_MS).toBeLessThanOrEqual(30_000);
  });
});
