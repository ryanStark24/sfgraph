import { spawnSync } from "node:child_process";
import os from "node:os";
import { analyze } from "@ryanstark24/sfgraph-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SfgraphMcpServer } from "../server.js";
import { type Fixture, createFixture } from "../tools/__tests__/_fixture.js";

// review I3: a killed ingest leaves sync_in_progress = 1. getSyncStatus sees
// the dead owner; the analysis caches must too, instead of recomputing live
// on every call until the next successful ingest.
let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture("org1");
});
afterEach(async () => {
  await fix.cleanup();
});

describe("review I3: analysis caches ignore a dead sync owner", () => {
  it("dead_code_audit serves the fresh cache when the in-progress flag belongs to a killed process", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:Lonely",
      label: "ApexClass",
      lastModifiedAt: Date.now() - 1e11,
    });
    const g = fix.ctx.graphStore;
    g.upsertOrg({
      id: fix.orgId,
      alias: "i3",
      instanceUrl: "https://x.my.salesforce.com",
      apiVersion: "62.0",
      createdAt: Date.now(),
    });
    g.markSyncComplete(fix.orgId, new Date(Date.now() - 60_000).toISOString());
    const db = (g as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } })
      .db;
    analyze.populateDeadCodeScores(g as never, fix.orgId as never, db as never);
    (fix.ctx as { db?: unknown }).db = db;
    // An ingest that was SIGKILLed: its pid is gone, the flag is still set.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    db.prepare(
      `UPDATE _sfgraph_orgs SET sync_in_progress = 1, sync_started_at = ?, sync_owner_pid = ?,
              sync_owner_host = ?, sync_owner_start_ms = ? WHERE id = ?`,
    ).run(new Date().toISOString(), dead, os.hostname(), Date.now() - 5000, String(fix.orgId));
    expect(g.getSyncStatus(fix.orgId).in_progress).toBe(false);

    const server = new SfgraphMcpServer();
    await server.loadAllTools();
    const res = await server.dispatch("dead_code_audit", { org: fix.orgId });
    const text = res.content[0]?.text ?? "";
    expect(text).not.toMatch(/sync is in progress/);
    expect((res._meta?.data as { cached: boolean }).cached).toBe(true);
    expect((res._meta?.staleness as { in_progress: boolean }).in_progress).toBe(false);
  });
});
