import { afterEach, describe, expect, it } from "vitest";
import {
  type ToolContext,
  closeAllContexts,
  getToolContext,
  setToolContextFactory,
} from "../context.js";

/**
 * Audit rel-03: getToolContext has no in-flight de-dup. N concurrent first
 * calls for the same org each run the factory (each opens a store); all but
 * the last are overwritten in the cache and never closed.
 */
afterEach(async () => {
  await closeAllContexts();
  setToolContextFactory(null);
});

describe("audit rel-03: concurrent first calls share one in-flight build", () => {
  it("runs the factory once and leaks no store for 3 concurrent calls", async () => {
    let built = 0;
    let closed = 0;
    setToolContextFactory(async ({ orgId }) => {
      built += 1;
      await new Promise((r) => setTimeout(r, 20)); // widen the race window
      return {
        graphStore: {
          close: async () => {
            closed += 1;
          },
        },
        snapshotStore: {},
        orgId: orgId ?? "default",
      } as unknown as ToolContext;
    });
    const results = await Promise.all([
      getToolContext({ orgId: "same-org" }),
      getToolContext({ orgId: "same-org" }),
      getToolContext({ orgId: "same-org" }),
    ]);
    expect(built).toBe(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    await closeAllContexts();
    // Every store that was built has been closed (none leaked).
    expect(closed).toBe(built);
  });
});
