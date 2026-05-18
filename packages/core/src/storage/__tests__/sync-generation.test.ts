import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Org } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

// W1.5-08: sync-generation counter + in-progress flag tests. These all
// exercise the additive ALTER TABLE migration on `_sfgraph_orgs` plus the
// four lifecycle helpers (markSyncStarted / markSyncComplete / markSyncFailed
// / getSyncStatus).

let workDir: string;
let store: SqliteGraphStore;
const ORG = asOrgId("org-w1508");

function freshOrg(): Org {
  return {
    id: ORG,
    alias: "DevHub",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "62.0",
    createdAt: 1,
  };
}

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-syncgen-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "bkp"),
  });
  await store.init();
  store.upsertOrg(freshOrg());
});

afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("W1.5-08 sync-generation lifecycle", () => {
  it("default state for a freshly-upserted org is (0, false, null, null)", () => {
    const s = store.getSyncStatus(ORG);
    expect(s).toEqual({
      generation: 0,
      in_progress: false,
      started_at: null,
      last_sync_at: null,
    });
  });

  it("markSyncStarted sets in_progress=true and started_at, generation stays 0", () => {
    const iso = new Date("2025-01-01T00:00:00Z").toISOString();
    store.markSyncStarted(ORG, iso);
    const s = store.getSyncStatus(ORG);
    expect(s.in_progress).toBe(true);
    expect(s.started_at).toBe(iso);
    expect(s.generation).toBe(0);
    expect(s.last_sync_at).toBeNull();
  });

  it("markSyncComplete increments generation, clears in_progress and started_at, updates last_sync_at", () => {
    const startIso = "2025-01-01T00:00:00Z";
    const endIso = "2025-01-01T00:05:00Z";
    store.markSyncStarted(ORG, startIso);
    store.markSyncComplete(ORG, endIso);
    const s = store.getSyncStatus(ORG);
    expect(s.generation).toBe(1);
    expect(s.in_progress).toBe(false);
    expect(s.started_at).toBeNull();
    expect(s.last_sync_at).toBe(Date.parse(endIso));
  });

  it("markSyncFailed clears in_progress and started_at but does NOT increment generation", () => {
    store.markSyncStarted(ORG, "2025-01-01T00:00:00Z");
    store.markSyncFailed(ORG);
    const s = store.getSyncStatus(ORG);
    expect(s.generation).toBe(0);
    expect(s.in_progress).toBe(false);
    expect(s.started_at).toBeNull();
    expect(s.last_sync_at).toBeNull();
  });

  it("getSyncStatus returns combined state at each lifecycle stage", () => {
    // Pre-start
    expect(store.getSyncStatus(ORG).in_progress).toBe(false);
    // In flight
    store.markSyncStarted(ORG, "2025-01-01T00:00:00Z");
    expect(store.getSyncStatus(ORG)).toMatchObject({
      generation: 0,
      in_progress: true,
      started_at: "2025-01-01T00:00:00Z",
    });
    // Complete
    store.markSyncComplete(ORG, "2025-01-01T00:01:00Z");
    expect(store.getSyncStatus(ORG)).toMatchObject({
      generation: 1,
      in_progress: false,
      started_at: null,
    });
  });

  it("generation is monotonic across three successful ingests (0 -> 1 -> 2 -> 3)", () => {
    expect(store.getSyncStatus(ORG).generation).toBe(0);
    for (let i = 1; i <= 3; i += 1) {
      store.markSyncStarted(ORG, new Date(1_700_000_000_000 + i).toISOString());
      store.markSyncComplete(ORG, new Date(1_700_000_000_000 + i * 1000).toISOString());
      expect(store.getSyncStatus(ORG).generation).toBe(i);
    }
  });

  it("failed ingest does not increment generation even when sandwiched between successes", () => {
    store.markSyncStarted(ORG, "2025-01-01T00:00:00Z");
    store.markSyncComplete(ORG, "2025-01-01T00:01:00Z");
    expect(store.getSyncStatus(ORG).generation).toBe(1);

    // Failed in the middle — generation should still be 1.
    store.markSyncStarted(ORG, "2025-01-02T00:00:00Z");
    store.markSyncFailed(ORG);
    expect(store.getSyncStatus(ORG).generation).toBe(1);

    // Next success brings us to 2 (not 3).
    store.markSyncStarted(ORG, "2025-01-03T00:00:00Z");
    store.markSyncComplete(ORG, "2025-01-03T00:01:00Z");
    expect(store.getSyncStatus(ORG).generation).toBe(2);
  });

  it("getSyncStatus on an unknown org returns the zero-defaults block", () => {
    const s = store.getSyncStatus(asOrgId("does-not-exist"));
    expect(s).toEqual({
      generation: 0,
      in_progress: false,
      started_at: null,
      last_sync_at: null,
    });
  });

  it("migration is idempotent — reopening an existing DB does not error", async () => {
    // Drive state into the DB, close, reopen via a fresh store.
    store.markSyncStarted(ORG, "2025-01-01T00:00:00Z");
    store.markSyncComplete(ORG, "2025-01-01T00:01:00Z");
    const dbPath = path.join(workDir, "g.sqlite");
    await store.close();

    const reopened = new SqliteGraphStore({
      dbPath,
      backupDir: path.join(workDir, "bkp"),
    });
    await reopened.init();
    const s = reopened.getSyncStatus(ORG);
    expect(s.generation).toBe(1);
    expect(s.in_progress).toBe(false);
    await reopened.close();

    // Reassign so afterEach's close() is a no-op on the closed handle.
    store = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
    await store.init();
  });

  it("markSyncComplete uses a transaction — readers never see partial state", () => {
    // We can't truly observe a partial state in single-threaded better-sqlite3,
    // but we can at least assert that all four mutations land together.
    store.markSyncStarted(ORG, "2025-01-01T00:00:00Z");
    store.markSyncComplete(ORG, "2025-01-01T00:01:00Z");
    const s = store.getSyncStatus(ORG);
    // All four mutations must have applied — if any one didn't, this fails.
    expect(s.generation).toBe(1);
    expect(s.in_progress).toBe(false);
    expect(s.started_at).toBeNull();
    expect(s.last_sync_at).toBe(Date.parse("2025-01-01T00:01:00Z"));
  });

  it("invalid ISO timestamps to markSyncStarted / markSyncComplete throw", () => {
    expect(() => store.markSyncStarted(ORG, "not-an-iso")).toThrow();
    expect(() => store.markSyncComplete(ORG, "")).toThrow();
  });
});
