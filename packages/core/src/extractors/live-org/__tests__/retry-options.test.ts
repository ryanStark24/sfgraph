import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RETRY_BACKOFF_MS, resolveRetryOptions, setRetryBackoffMs } from "../retry.js";

/** Backoff must be injectable so mocked-org suites (liveIngest end-to-end)
 *  don't sleep 2+4+8 s per failing call, while real runs keep the default. */
describe("resolveRetryOptions — backoff injection", () => {
  const KEYS = ["VITEST", "SFGRAPH_LIVE_RETRY_BASE_MS", "SFGRAPH_FETCH_RETRY_BACKOFF_MS"] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    setRetryBackoffMs(undefined);
    for (const k of KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
  });

  it("uses the production default outside the test runner", () => {
    for (const k of KEYS) Reflect.deleteProperty(process.env, k);
    expect(resolveRetryOptions().retryBackoffMs).toBe(DEFAULT_RETRY_BACKOFF_MS);
    expect(DEFAULT_RETRY_BACKOFF_MS).toBe(2_000);
  });

  it("defaults to 0 under vitest", () => {
    process.env.VITEST = "true";
    Reflect.deleteProperty(process.env, "SFGRAPH_LIVE_RETRY_BASE_MS");
    Reflect.deleteProperty(process.env, "SFGRAPH_FETCH_RETRY_BACKOFF_MS");
    expect(resolveRetryOptions().retryBackoffMs).toBe(0);
  });

  it("under vitest, an explicit env override beats the 0 default (review M4)", () => {
    process.env.VITEST = "true";
    process.env.SFGRAPH_LIVE_RETRY_BASE_MS = "2000";
    expect(resolveRetryOptions().retryBackoffMs).toBe(2_000);
    Reflect.deleteProperty(process.env, "SFGRAPH_LIVE_RETRY_BASE_MS");
    process.env.SFGRAPH_FETCH_RETRY_BACKOFF_MS = "500";
    expect(resolveRetryOptions().retryBackoffMs).toBe(500);
  });

  it("honours SFGRAPH_LIVE_RETRY_BASE_MS, the module override and explicit options, in that rising order", () => {
    Reflect.deleteProperty(process.env, "VITEST");
    process.env.SFGRAPH_LIVE_RETRY_BASE_MS = "7";
    expect(resolveRetryOptions().retryBackoffMs).toBe(7);
    setRetryBackoffMs(3);
    expect(resolveRetryOptions().retryBackoffMs).toBe(3);
    expect(resolveRetryOptions({ retryBackoffMs: 1 }).retryBackoffMs).toBe(1);
  });
});
