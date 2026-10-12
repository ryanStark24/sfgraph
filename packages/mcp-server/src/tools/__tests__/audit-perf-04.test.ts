import { analyze } from "@ryanstark24/sfgraph-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit perf-04: export_sarif recomputes every audit live (findDeadCode calls
 * listEdgesTo for every candidate node) even when the analysis cache tables
 * are populated. Mechanism test: with the dead-code cache populated, the
 * dead-code audit must not walk incoming edges node by node.
 */
let fix: Fixture;

/** Record a completed sync for the fixture org (the cache is only trusted
 *  when it was computed after the last sync: review M1). */
function recordSync(iso: string): void {
  fix.ctx.graphStore.upsertOrg({
    id: fix.orgId,
    alias: "perf04",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "62.0",
    createdAt: Date.now(),
  });
  fix.ctx.graphStore.markSyncComplete(fix.orgId, iso);
}

beforeEach(async () => {
  fix = await createFixture();
  for (let i = 0; i < 40; i++) {
    fix.addNode({ qualifiedName: `ApexClass:Orphan${i}`, label: "ApexClass" });
  }
  (fix.ctx as { db?: unknown }).db = (fix.ctx.graphStore as unknown as { db: unknown }).db;
  recordSync(new Date(Date.now() - 60_000).toISOString());
  await analyze.populateAnalysisTables(
    fix.ctx.graphStore,
    fix.orgId,
    (fix.ctx.graphStore as unknown as { db: never }).db,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fix.cleanup();
});

describe("audit perf-04: export_sarif uses cached analysis tables", () => {
  it("dead-code audit does not call listEdgesTo per node when the cache is populated", async () => {
    const spy = vi.spyOn(fix.ctx.graphStore, "listEdgesTo");
    const r = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    // Still reports the dead-code findings...
    expect(r.summary).toMatch(/findings/);
    // ...but from the cache, not by N per-node edge lookups.
    expect(spy.mock.calls.length).toBeLessThan(5);
  });

  it("cache-backed dead-code findings equal the live scan's", async () => {
    const r = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    const d = r.data as { findings: unknown[]; sources: Record<string, string> };
    expect(d.sources["dead-code"]).toBe("cache");
    const live = analyze.collectFindings({
      deadCode: analyze.findDeadCode(fix.ctx.graphStore, fix.orgId),
    });
    const key = (f: unknown) => JSON.stringify(f);
    expect(d.findings.map(key).sort()).toEqual(live.map(key).sort());
  });

  it("ignores and reports a stale cache (computed before the last sync)", async () => {
    // A sync completing after the cache was computed makes it stale.
    recordSync(new Date(Date.now() + 60_000).toISOString());
    const spy = vi.spyOn(fix.ctx.graphStore, "listEdgesTo");
    const r = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    const d = r.data as { findings: unknown[]; sources: Record<string, string> };
    expect(d.sources["dead-code"]).toMatch(/^live \(cache stale: computed before the last sync/);
    expect(r.markdown).toMatch(/cache stale/);
    expect(d.findings.length).toBe(40);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(40);
  });

  it("does not trust a cache whose freshness is unknown (no recorded sync)", async () => {
    (fix.ctx.graphStore as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db
      .prepare("DELETE FROM _sfgraph_orgs")
      .run();
    const spy = vi.spyOn(fix.ctx.graphStore, "listEdgesTo");
    const r = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    const d = r.data as { findings: unknown[]; sources: Record<string, string> };
    expect(d.sources["dead-code"]).toMatch(/^live \(cache unverified: no recorded sync/);
    expect(d.findings.length).toBe(40);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(40);
  });
});
