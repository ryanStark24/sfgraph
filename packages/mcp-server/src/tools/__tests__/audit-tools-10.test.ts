import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit tools-10: with an empty pre-sync baseline every node is "added", yet
 * what_broke reports "no changes" because it only seeds from changed+removed.
 */
let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("audit tools-10: what_broke with an empty baseline snapshot", () => {
  it("does not claim 'no changes' when all nodes were added after the baseline", async () => {
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync-first", true);
    fix.addNode({ qualifiedName: "ApexClass:Fresh", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexClass:Caller", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Caller",
      dstQualifiedName: "ApexClass:Fresh",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("what_broke", { org: fix.orgId, since: snap.id });
    expect(r.summary).not.toBe("no changes");
    expect(r.markdown).not.toMatch(/no changes since snapshot/);
  });

  it("without `since`, skips/flags an empty auto baseline instead of 'no changes'", async () => {
    fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync-first", true);
    fix.addNode({ qualifiedName: "ApexClass:Fresh2", label: "ApexClass" });
    const r = await callTool("what_broke", { org: fix.orgId });
    expect(r.summary).not.toBe("no changes");
  });

  it("treats nodes added after a non-empty baseline as change seeds", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Old", label: "ApexClass" });
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync-2", true);
    fix.addNode({ qualifiedName: "ApexClass:New", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Old",
      dstQualifiedName: "ApexClass:New",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("what_broke", { org: fix.orgId });
    const d = r.data as { added: string[]; atRisk: string[] };
    expect(d.added).toContain("ApexClass:New");
    expect(d.atRisk).toContain("ApexClass:Old");
    expect(snap.id).toBeTruthy();
  });

  it("caps changed/added lists with counts + truncated (review M3)", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Base", label: "ApexClass" });
    fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync-3", true);
    for (let i = 0; i < 30; i++) {
      fix.addNode({ qualifiedName: `ApexClass:Added${i}`, label: "ApexClass" });
    }
    const r = await callTool("what_broke", { org: fix.orgId, limit: 5 });
    const d = r.data as {
      changed: string[];
      added: string[];
      counts: { changed: number; added: number };
      truncated: boolean;
    };
    expect(d.added.length).toBe(5);
    expect(d.changed.length).toBeLessThanOrEqual(5);
    expect(d.counts.added).toBe(30);
    expect(d.truncated).toBe(true);
  });

  it("counts a dependent shared by several seeds once (review M3)", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Shared", label: "ApexClass" });
    fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync-4", true);
    for (const n of ["A", "B", "C"]) {
      fix.addNode({ qualifiedName: `ApexClass:${n}`, label: "ApexClass" });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Shared",
        dstQualifiedName: `ApexClass:${n}`,
        relType: REL_TYPES.CALLS,
      });
    }
    const r = await callTool("what_broke", { org: fix.orgId });
    const d = r.data as { atRisk: string[]; counts: { atRisk: number } };
    expect(d.atRisk.filter((q) => q === "ApexClass:Shared")).toHaveLength(1);
    expect(d.counts.atRisk).toBe(d.atRisk.length);
    expect(r.summary).toBe("1 dependents at risk");
  });

  it("sets truncated when change seeds are capped at 200, even if no list is cut (review N3)", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Base", label: "ApexClass" });
    fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync-5", true);
    for (let i = 0; i < 205; i++) {
      fix.addNode({ qualifiedName: `ApexClass:Seed${i}`, label: "ApexClass" });
    }
    const r = await callTool("what_broke", { org: fix.orgId, limit: 1000 });
    const d = r.data as {
      added: string[];
      counts: { added: number };
      truncated: boolean;
      seedsTraced: number;
      seedsTruncated: number;
    };
    expect(d.added.length).toBe(205); // no list was cut by `limit`
    expect(d.seedsTraced).toBe(200);
    expect(d.seedsTruncated).toBe(5);
    expect(d.truncated).toBe(true);
  });

  it("reports seedsTruncated 0 when every seed was traced (review N3)", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Base", label: "ApexClass" });
    fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync-6", true);
    fix.addNode({ qualifiedName: "ApexClass:One", label: "ApexClass" });
    const r = await callTool("what_broke", { org: fix.orgId });
    const d = r.data as { truncated: boolean; seedsTruncated: number; seedsTraced: number };
    expect(d.seedsTruncated).toBe(0);
    expect(d.seedsTraced).toBe(1);
    expect(d.truncated).toBe(false);
  });
});
