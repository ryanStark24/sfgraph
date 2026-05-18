import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGraphStore, SqliteSnapshotStore } from "@ryanstark24/sfgraph-core";
import { type OrgId, asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ToolContext, closeAllContexts, setToolContextFactory } from "../context.js";
import { SfgraphMcpServer } from "../server.js";

// W1.5-08: integration test for the MCP `_meta.staleness` block. We swap
// in a real SqliteGraphStore against a temp DB (so the migration runs),
// then drive markSyncStarted / Complete / Failed on it and assert what
// dispatch returns.

let workDir: string;
let graphStore: SqliteGraphStore;
const ORG = "test-staleness-org";

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-stale-mcp-"));
  const dbPath = path.join(workDir, `${ORG}.sqlite`);
  graphStore = new SqliteGraphStore({
    dbPath,
    backupDir: path.join(workDir, "bkp"),
  });
  await graphStore.init();
  graphStore.upsertOrg({
    id: asOrgId(ORG),
    alias: ORG,
    instanceUrl: "https://x.my.salesforce.com",
    apiVersion: "62.0",
    createdAt: 1,
  });
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  setToolContextFactory(async () => {
    const ctx: ToolContext = {
      graphStore,
      snapshotStore,
      orgId: asOrgId(ORG) as OrgId,
    };
    return ctx;
  });
});

afterEach(async () => {
  await closeAllContexts();
  setToolContextFactory(null);
  try {
    await graphStore.close();
  } catch {
    /* ignore */
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("MCP dispatch _meta.staleness (W1.5-08)", () => {
  it("attaches default staleness block (gen=0, in_progress=false) before any sync", async () => {
    const server = new SfgraphMcpServer();
    // Register a tiny tool that takes an `org` arg so the dispatcher can
    // resolve a context.
    server.registry.register("probe", async () => ({ ok: true }), { description: "test probe" });
    const res = await server.dispatch("probe", { org: ORG });
    expect(res.isError).toBeUndefined();
    const staleness = res._meta?.staleness as
      | {
          generation: number;
          in_progress: boolean;
          started_at: string | null;
          last_sync_at: string | null;
        }
      | undefined;
    expect(staleness).toBeDefined();
    expect(staleness?.generation).toBe(0);
    expect(staleness?.in_progress).toBe(false);
    expect(staleness?.started_at).toBeNull();
    expect(staleness?.last_sync_at).toBeNull();
  });

  it("returns in_progress=true during an active ingest", async () => {
    graphStore.markSyncStarted(asOrgId(ORG), "2025-05-18T12:00:00.000Z");
    const server = new SfgraphMcpServer();
    server.registry.register("probe", async () => ({ ok: true }), { description: "test probe" });
    const res = await server.dispatch("probe", { org: ORG });
    const staleness = res._meta?.staleness as { in_progress: boolean; started_at: string | null };
    expect(staleness.in_progress).toBe(true);
    expect(staleness.started_at).toBe("2025-05-18T12:00:00.000Z");
  });

  it("after ingest completes, in_progress=false and generation incremented to 1", async () => {
    graphStore.markSyncStarted(asOrgId(ORG), "2025-05-18T12:00:00.000Z");
    graphStore.markSyncComplete(asOrgId(ORG), "2025-05-18T12:05:00.000Z");
    const server = new SfgraphMcpServer();
    server.registry.register("probe", async () => ({ ok: true }), { description: "test probe" });
    const res = await server.dispatch("probe", { org: ORG });
    const staleness = res._meta?.staleness as {
      generation: number;
      in_progress: boolean;
      last_sync_at: string | null;
    };
    expect(staleness.generation).toBe(1);
    expect(staleness.in_progress).toBe(false);
    expect(staleness.last_sync_at).toBe("2025-05-18T12:05:00.000Z");
  });

  it("staleness is null for tools called without an org argument", async () => {
    const server = new SfgraphMcpServer();
    server.registry.register("noOrgTool", async () => ({ ok: true }), {
      description: "test probe",
    });
    const res = await server.dispatch("noOrgTool", {});
    expect(res._meta?.staleness).toBeNull();
  });

  it("dispatch envelope shape preserved: content[0].text is the JSON payload", async () => {
    const server = new SfgraphMcpServer();
    server.registry.register("echo", async () => ({ ok: true, value: 42 }), {
      description: "test probe",
    });
    const res = await server.dispatch("echo", { org: ORG });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]?.type).toBe("text");
    // Staleness is in _meta, not in content
    expect(res._meta?.staleness).toBeDefined();
  });
});
