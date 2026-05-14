import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore } from "@ryanstark24/sfgraph-core";
import { type OrgId, SfgraphError, asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ToolContext,
  _contextCacheSize,
  closeAllContexts,
  getToolContext,
  setToolContextFactory,
} from "../context.js";

let workDir: string;
const factoryCallCount = { n: 0 };

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-ctxcache-"));
  factoryCallCount.n = 0;
  setToolContextFactory(async ({ orgId }) => {
    factoryCallCount.n += 1;
    const id = orgId ?? "default";
    const dbPath = path.join(workDir, `${id}.sqlite`);
    const graphStore = new SqliteGraphStore({
      dbPath,
      backupDir: path.join(workDir, "bkp"),
    });
    await graphStore.init();
    const snapshotStore = new SqliteSnapshotStore({
      dbPath,
      db: (graphStore as unknown as { db: never }).db,
      skipMigrations: true,
    });
    await snapshotStore.init();
    const ctx: ToolContext = { graphStore, snapshotStore, orgId: asOrgId(id) as OrgId };
    return ctx;
  });
});

afterEach(async () => {
  await closeAllContexts();
  setToolContextFactory(null);
  rmSync(workDir, { recursive: true, force: true });
});

describe("getToolContext cache", () => {
  it("returns the same context object across two calls for the same orgId", async () => {
    const a = await getToolContext({ orgId: "myorg" });
    const b = await getToolContext({ orgId: "myorg" });
    expect(b).toBe(a);
    expect(factoryCallCount.n).toBe(1);
  });

  it("closeAllContexts releases the cached store; next call rebuilds", async () => {
    const a = await getToolContext({ orgId: "myorg" });
    await closeAllContexts();
    const b = await getToolContext({ orgId: "myorg" });
    expect(b).not.toBe(a);
    expect(factoryCallCount.n).toBe(2);
  });

  it("rejects malformed org identifiers with SfgraphError before invoking factory", async () => {
    await expect(getToolContext({ orgId: "../escape" })).rejects.toBeInstanceOf(SfgraphError);
    await expect(getToolContext({ orgId: "/abs/path" })).rejects.toBeInstanceOf(SfgraphError);
    await expect(getToolContext({ orgId: "foo\x00bar" })).rejects.toBeInstanceOf(SfgraphError);
    expect(factoryCallCount.n).toBe(0); // factory never reached
  });

  // P1 audit pass 2: cache eviction
  it("evicts the oldest entry once the bounded cache fills (cap=8)", async () => {
    // Insert 9 distinct contexts; the first must be evicted.
    for (let i = 0; i < 9; i++) {
      await getToolContext({ orgId: `org${i}` });
    }
    expect(_contextCacheSize()).toBeLessThanOrEqual(8);
    expect(factoryCallCount.n).toBe(9);
    // org0 should have been evicted; fetching again rebuilds.
    await getToolContext({ orgId: "org0" });
    expect(factoryCallCount.n).toBe(10);
  });

  it("idempotent close on the graph store does not throw on double-close", async () => {
    const ctx = await getToolContext({ orgId: "doubleclose" });
    const store = ctx.graphStore as unknown as { close: () => Promise<void> };
    await store.close();
    // second close must be a no-op
    await store.close();
  });
});
