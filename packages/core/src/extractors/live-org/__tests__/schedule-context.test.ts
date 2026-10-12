import { describe, expect, it } from "vitest";
import { scheduleQuery, stopSignalContext, withTimeout } from "../rate-limit.js";

/**
 * Bottleneck starts a queued job from the completion callback of an earlier
 * job, i.e. inside THAT job's async context. A job scheduled with no stop
 * signal of its own then resolved `stopSignalContext.getStore()` to the
 * earlier caller's signal. Seen as: the EntityDefinition probe stopped (its
 * ceiling or a depth-guard throw) with tooling queries still queued, and the
 * next unrelated `describeGlobal` died with "stop-waiting" — losing the whole
 * `object` source. A scheduled job must run in its scheduler's context.
 */
describe("scheduled jobs run in the scheduling caller's async context", () => {
  it("a stopped signal from another caller does not leak into a queued job", async () => {
    const stopped = { value: false };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Fill the tooling pool with jobs from a context whose signal will stop.
    const blockers = stopSignalContext.run(stopped, () =>
      Array.from({ length: 20 }, () => scheduleQuery(() => gate).catch(() => undefined)),
    );
    // An unrelated caller (no signal) queues behind them.
    const unrelated = scheduleQuery(() =>
      withTimeout(Promise.resolve("ok"), 5_000, "describeGlobal"),
    );
    stopped.value = true;
    release();
    await Promise.all(blockers);
    await expect(unrelated).resolves.toBe("ok");
  });
});
