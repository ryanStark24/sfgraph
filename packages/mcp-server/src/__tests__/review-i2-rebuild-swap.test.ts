import { mkdtempSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedIngestedOrgDb } from "./_seed-org-db.js";

// review I2: `sfgraph ingest --rebuild` renames <orgId>.sqlite away and builds
// a new file. A cached ToolContext must not keep serving the old inode.
const ORG = "00D000000000001AAA";
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-i2-swap-"));
  vi.doMock("@ryanstark24/sfgraph-shared", async () => {
    const actual = await vi.importActual<typeof import("@ryanstark24/sfgraph-shared")>(
      "@ryanstark24/sfgraph-shared",
    );
    return {
      ...actual,
      getSfgraphPaths: () => ({
        data: workDir,
        cache: workDir,
        log: workDir,
        config: workDir,
        temp: workDir,
      }),
    };
  });
});

afterEach(async () => {
  const { closeAllContexts } = await import("../context.js");
  await closeAllContexts();
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

/**
 * What `sfgraph ingest --rebuild` does to the graph file: rename it to a
 * backup, or unlink it (`--no-backup`), sidecars included. On Windows a file
 * another connection (the cached tool context) has open cannot be moved, so
 * the swap these tests cover cannot happen there: the move is refused and the
 * CLI reports it (onGraphFile). Returns false then.
 */
function moveAside(dbPath: string, mode: "rename" | "unlink"): boolean {
  if (process.platform === "win32") {
    const move = () =>
      mode === "unlink" ? unlinkSync(dbPath) : renameSync(dbPath, `${dbPath}.bak`);
    expect(move).toThrow(/EBUSY|EPERM|EACCES/);
    return false;
  }
  for (const s of ["", "-wal", "-shm"]) {
    try {
      if (mode === "unlink") unlinkSync(dbPath + s);
      else renameSync(dbPath + s, `${dbPath}.bak${s}`);
    } catch {
      /* absent */
    }
  }
  return true;
}

describe("review I2: cached tool context follows a rebuild file swap", () => {
  it("reopens every store on the new file after dbPath is renamed away and recreated", async () => {
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    const { SqliteGraphStore } = await import("@ryanstark24/sfgraph-core");
    const { asOrgId, asQualifiedName, asSha256 } = await import("@ryanstark24/sfgraph-shared");
    setToolContextFactory(null);
    await seedIngestedOrgDb(workDir, ORG, "swap");
    const ctx1 = await getToolContext({ orgId: ORG });
    expect(ctx1.graphStore.getNode(asOrgId(ORG), asQualifiedName("NewGraph"))).toBeNull();

    const dbPath = path.join(workDir, `${ORG}.sqlite`);
    if (!moveAside(dbPath, "rename")) return;
    await seedIngestedOrgDb(workDir, ORG, "swap");
    const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
    await g.init();
    g.mergeNodes([
      {
        orgId: asOrgId(ORG),
        qualifiedName: asQualifiedName("NewGraph"),
        label: "ApexClass",
        attributes: {},
        sourceHash: asSha256("h"),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
    ]);
    g.markSyncComplete(asOrgId(ORG), new Date().toISOString());
    await g.close();

    const ctx2 = await getToolContext({ orgId: ORG });
    expect(ctx2.graphStore.getNode(asOrgId(ORG), asQualifiedName("NewGraph"))).not.toBeNull();
    // The raw handle the analysis caches read and the snapshot store must be on the new file too.
    const raw = ctx2.db as { prepare(s: string): { get(): unknown } };
    expect(
      raw
        .prepare("SELECT COUNT(*) AS c FROM _sfgraph_node_index WHERE qualified_name = 'NewGraph'")
        .get(),
    ).toEqual({ c: 1 });
    expect((ctx2.snapshotStore as unknown as { db: unknown }).db).toBe(ctx2.db);
  });

  // review R1-1: the rebuild builds the new file in place for minutes. Until
  // it has finished, tools keep answering from the complete old graph (its
  // inode stays readable after rename or unlink), then switch.
  for (const mode of ["rename (backup)", "unlink (--no-backup)"] as const) {
    it(`keeps the old graph while the new file is mid-rebuild, then switches: ${mode}`, async () => {
      const { getToolContext, setToolContextFactory } = await import("../context.js");
      const { SqliteGraphStore } = await import("@ryanstark24/sfgraph-core");
      const { asOrgId, asQualifiedName, asSha256 } = await import("@ryanstark24/sfgraph-shared");
      setToolContextFactory(null);
      const org = asOrgId(ORG);
      const node = (q: string) => ({
        orgId: org,
        qualifiedName: asQualifiedName(q),
        label: "ApexClass",
        attributes: {},
        sourceHash: asSha256("h"),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      });
      const dbPath = path.join(workDir, `${ORG}.sqlite`);
      await seedIngestedOrgDb(workDir, ORG, "swap");
      const old = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
      await old.init();
      old.mergeNodes([node("OldGraph")]);
      old.markSyncComplete(org, new Date().toISOString());
      await old.close();
      const ctx1 = await getToolContext({ orgId: ORG });
      expect(ctx1.graphStore.getNode(org, asQualifiedName("OldGraph"))).not.toBeNull();

      if (!moveAside(dbPath, mode === "unlink (--no-backup)" ? "unlink" : "rename")) return;
      // The rebuild, in progress: org row, live sync owner, open bulk window.
      await seedIngestedOrgDb(workDir, ORG, "swap");
      const g = new SqliteGraphStore({ dbPath, backupDir: path.join(workDir, "bkp") });
      await g.init();
      try {
        g.markSyncStarted(org, new Date().toISOString());
        g.beginBulk();
        g.mergeNodes([node("NewGraph")]);
        for (let i = 0; i < 2; i++) {
          const mid = await getToolContext({ orgId: ORG });
          expect(mid).toBe(ctx1);
          expect(mid.graphStore.getNode(org, asQualifiedName("OldGraph"))).not.toBeNull();
          expect(mid.graphStore.getNode(org, asQualifiedName("NewGraph"))).toBeNull();
          const raw = mid.db as { prepare(s: string): { get(): unknown } };
          expect(
            raw
              .prepare(
                "SELECT COUNT(*) AS c FROM _sfgraph_node_index WHERE qualified_name = 'OldGraph'",
              )
              .get(),
          ).toEqual({ c: 1 });
          if (i === 0) g.endBulk(); // indexes back, but the sync is still running
        }
        g.markSyncComplete(org, new Date().toISOString());
      } finally {
        await g.close();
      }
      const ctx2 = await getToolContext({ orgId: ORG });
      expect(ctx2).not.toBe(ctx1);
      expect(ctx2.graphStore.getNode(org, asQualifiedName("NewGraph"))).not.toBeNull();
      expect(ctx2.graphStore.getNode(org, asQualifiedName("OldGraph"))).toBeNull();
    });
  }

  it("review R1-2: the MCP graph store never swaps files itself (context eviction does)", async () => {
    const { getToolContext, setToolContextFactory } = await import("../context.js");
    setToolContextFactory(null);
    await seedIngestedOrgDb(workDir, ORG, "swap");
    const ctx = await getToolContext({ orgId: ORG });
    const opts = (ctx.graphStore as unknown as { opts: { fileCheckIntervalMs?: number } }).opts;
    expect(opts.fileCheckIntervalMs).toBeLessThan(0);
  });
});
