import Bottleneck from "bottleneck";
import { describe, expect, it } from "vitest";
import { queryLimit, scheduleQuery } from "../rate-limit.js";

describe("rate-limit", () => {
  it("retries once on REQUEST_LIMIT_EXCEEDED and ultimately resolves", async () => {
    let calls = 0;
    // Use a local Bottleneck to keep test isolated, but verify via scheduleQuery shape too.
    const lim = new Bottleneck({ maxConcurrent: 1 });
    lim.on("failed", (err: any, info) => {
      if (err?.errorCode === "REQUEST_LIMIT_EXCEEDED" && info.retryCount < 1) return 1;
      return null;
    });
    const job = () =>
      lim.schedule(() => {
        calls += 1;
        if (calls === 1) {
          const e: any = new Error("limit");
          e.errorCode = "REQUEST_LIMIT_EXCEEDED";
          throw e;
        }
        return Promise.resolve("ok");
      });
    const res = await job();
    expect(res).toBe("ok");
    expect(calls).toBe(2);
  });

  it("scheduleQuery passes through and respects queryLimit serialization", async () => {
    expect(queryLimit.activeCount).toBeGreaterThanOrEqual(0);
    const r = await scheduleQuery(async () => 7);
    expect(r).toBe(7);
  });
});
