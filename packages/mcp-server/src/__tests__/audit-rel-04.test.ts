import { afterEach, describe, expect, it } from "vitest";
import {
  type ToolContext,
  _contextCacheSize,
  closeAllContexts,
  getToolContext,
  runWithContextLeases,
  setToolContextFactory,
} from "../context.js";

/**
 * Audit rel-04: the context cache is keyed by the raw user string, so an
 * alias and the orgId of the same DB open two separate store handles.
 * Correct behaviour: both spellings share one open store (key by resolved
 * orgId).
 */
const ORG_ID = "00DFS0000ACME01";

afterEach(async () => {
  await closeAllContexts();
  setToolContextFactory(null);
});

describe("audit rel-04: alias and orgId share one store", () => {
  it("keeps a single open handle for alias + orgId of the same org", async () => {
    let open = 0;
    setToolContextFactory(async () => {
      open += 1;
      // Like defaultFactory, the context carries the RESOLVED canonical orgId.
      return {
        graphStore: {
          close: async () => {
            open -= 1;
          },
        },
        snapshotStore: {},
        orgId: ORG_ID,
      } as unknown as ToolContext;
    });
    const byAlias = await getToolContext({ orgId: "acme-repo" });
    const byId = await getToolContext({ orgId: ORG_ID });
    expect(open).toBe(1);
    expect(byId).toBe(byAlias);
    expect(_contextCacheSize()).toBe(1);
  });

  it("defers closing an evicted store until the tool call using it finishes", async () => {
    const closed = new Set<string>();
    setToolContextFactory(async ({ orgId }) => {
      const id = orgId ?? "default";
      return {
        graphStore: {
          close: async () => {
            closed.add(id);
          },
        },
        snapshotStore: {},
        orgId: id,
      } as unknown as ToolContext;
    });
    let closedDuringCall: boolean | undefined;
    await runWithContextLeases(async () => {
      await getToolContext({ orgId: "busy-org" });
      // Rotate through 8 more orgs in the same call, evicting busy-org.
      await Promise.resolve().then(async () => {
        for (let i = 0; i < 8; i++) await getToolContext({ orgId: `other${i}` });
      });
      expect(_contextCacheSize()).toBeLessThanOrEqual(8);
      await new Promise((r) => setTimeout(r, 0));
      closedDuringCall = closed.has("busy-org");
    });
    expect(closedDuringCall).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(closed.has("busy-org")).toBe(true);
  });

  it("closes an evicted store immediately when no call holds it", async () => {
    const closed = new Set<string>();
    setToolContextFactory(async ({ orgId }) => {
      const id = orgId ?? "default";
      return {
        graphStore: {
          close: async () => {
            closed.add(id);
          },
        },
        snapshotStore: {},
        orgId: id,
      } as unknown as ToolContext;
    });
    await runWithContextLeases(async () => {
      await getToolContext({ orgId: "idle-org" });
    });
    for (let i = 0; i < 8; i++) await getToolContext({ orgId: `other${i}` });
    await new Promise((r) => setTimeout(r, 0));
    expect(closed.has("idle-org")).toBe(true);
  });
});
