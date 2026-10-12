import { analyze } from "@ryanstark24/sfgraph-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/** The Technical details section: the plain list lives there, below the report's other lists. */
const technical = (md: string): string =>
  md.slice(md.indexOf("**Technical details**")).split("**What to check next**")[0] ?? "";

let fix: Fixture;

/** qnames of `data.dead` (one row shape on the live and cached paths; review N1). */
const deadNames = (r: { data: unknown }): string[] =>
  (r.data as { dead: Array<{ qualifiedName: string }> }).dead.map((d) => d.qualifiedName);

/** Mark the org synced in the past so a cache populated afterwards is fresh
 *  (only a fresh, version-stamped score cache is served; review M1). */
function recordSync(): void {
  fix.ctx.graphStore.upsertOrg({
    id: fix.orgId,
    alias: "dc",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "62.0",
    createdAt: Date.now(),
  });
  fix.ctx.graphStore.markSyncComplete(fix.orgId, new Date(Date.now() - 60_000).toISOString());
}

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("dead_code_audit", () => {
  it("flags stale untouched class", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:Stale",
      label: "ApexClass",
      lastModifiedAt: Date.now() - 1000 * 60 * 60 * 24 * 1000,
    });
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect(deadNames(r)).toContain("ApexClass:Stale");
  });

  it("ignores stale class with incoming edges", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:Used",
      label: "ApexClass",
      lastModifiedAt: Date.now() - 1000 * 60 * 60 * 24 * 1000,
    });
    fix.addNode({ qualifiedName: "ApexClass:Caller", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Caller",
      dstQualifiedName: "ApexClass:Used",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect(deadNames(r)).not.toContain("ApexClass:Used");
  });

  it("returns empty dead list for empty graph", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    const d = r.data as { dead: unknown[] };
    expect(d.dead).toEqual([]);
    expect(r.markdown).toContain("no dead code detected");
  });

  it("lists a recently-modified isolated class (freshness only grades confidence)", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:JustWritten",
      label: "ApexClass",
      lastModifiedAt: Date.now(),
    });
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect(deadNames(r)).toContain("ApexClass:JustWritten");
  });

  it("rejects empty org", async () => {
    await expect(callTool("dead_code_audit", { org: "" })).rejects.toThrow();
  });

  it("reports cached=false when no cache table is present", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect((r.data as { cached: boolean }).cached).toBe(false);
  });

  it("handles many isolated stale nodes", async () => {
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 1000;
    for (let i = 0; i < 30; i++) {
      fix.addNode({
        qualifiedName: `ApexClass:Old${i}`,
        label: "ApexClass",
        lastModifiedAt: ancient,
      });
    }
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect(deadNames(r).length).toBeGreaterThanOrEqual(30);
  });

  describe("label / pattern filters and plain list", () => {
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 1000;
    beforeEach(() => {
      for (const q of ["ApexClass:Acme_One", "ApexClass:Acme_Two", "ApexClass:Other"]) {
        fix.addNode({ qualifiedName: q, label: "ApexClass", lastModifiedAt: ancient });
      }
      fix.addNode({ qualifiedName: "Flow:Acme_Flow", label: "Flow", lastModifiedAt: ancient });
    });

    it("filters by label", async () => {
      const r = await callTool("dead_code_audit", { org: fix.orgId, label: "Flow" });
      const md = r.markdown as string;
      expect(md).toContain("- Flow:Acme_Flow");
      expect(md).not.toContain("ApexClass:");
      expect((r.data as { total: number }).total).toBe(1);
    });

    it("filters by name prefix (with or without label)", async () => {
      const r = await callTool("dead_code_audit", { org: fix.orgId, pattern: "Acme_" });
      const md = r.markdown as string;
      expect(md).toContain("- ApexClass:Acme_One");
      expect(md).toContain("- Flow:Acme_Flow");
      expect(md).not.toContain("ApexClass:Other");
      const r2 = await callTool("dead_code_audit", { org: fix.orgId, pattern: "ApexClass:Acme" });
      expect((r2.data as { total: number }).total).toBe(2);
    });

    it("filters by glob, combined with label", async () => {
      const r = await callTool("dead_code_audit", {
        org: fix.orgId,
        pattern: "*_T?o",
        label: "ApexClass",
      });
      const md = r.markdown as string;
      expect(md).toContain("- ApexClass:Acme_Two");
      expect((r.data as { total: number }).total).toBe(1);
    });

    it("emits a plain list, not a table, and caps with a narrowing hint", async () => {
      for (let i = 0; i < 60; i++) {
        fix.addNode({
          qualifiedName: `ApexClass:Bulk${i}`,
          label: "ApexClass",
          lastModifiedAt: ancient,
        });
      }
      const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 10 });
      const md = r.markdown as string;
      expect(md).not.toContain("| qname");
      expect(
        technical(md)
          .split("\n")
          .filter((l) => l.startsWith("- ")).length,
      ).toBe(10);
      expect(md).toMatch(/\d+ more.*(label|pattern)/);
    });
  });

  describe("label not in the score cache", () => {
    // A fresh, stamped cache holding one candidate; nodes added afterwards are
    // not in it.
    function seedCache(): void {
      const db = (fix.ctx.graphStore as unknown as { db: never }).db;
      fix.addNode({ qualifiedName: "ApexClass:Scored", label: "ApexClass" });
      recordSync();
      analyze.populateDeadCodeScores(fix.ctx.graphStore as never, fix.ctx.orgId as never, db);
      (fix.ctx as { db?: unknown }).db = db;
    }

    it("computes zero-inbound candidates live for an unscored label", async () => {
      seedCache();
      fix.addNode({ qualifiedName: "DataRaptor:Orphan", label: "DataRaptor" });
      fix.addNode({ qualifiedName: "DataRaptor:Used", label: "DataRaptor" });
      fix.addNode({ qualifiedName: "OmniScript:Caller", label: "OmniScript" });
      fix.addEdge({
        srcQualifiedName: "OmniScript:Caller",
        dstQualifiedName: "DataRaptor:Used",
        relType: REL_TYPES.CALLS,
      });
      const r = await callTool("dead_code_audit", { org: fix.orgId, label: "DataRaptor" });
      const md = r.markdown as string;
      expect(md).toContain("- DataRaptor:Orphan");
      expect(md).not.toContain("DataRaptor:Used");
      expect(md).not.toContain("no dead code detected");
    });

    it("keeps saying no dead code for a scored label with no cached candidates", async () => {
      seedCache();
      fix.addNode({ qualifiedName: "Flow:Fresh", label: "Flow", lastModifiedAt: Date.now() });
      const r = await callTool("dead_code_audit", { org: fix.orgId, label: "Flow" });
      expect(r.markdown).toContain("no dead code detected");
      expect(r.markdown).not.toContain("Flow:Fresh");
    });

    it("matches unscored labels case-insensitively and notes ignored filters", async () => {
      seedCache();
      fix.addNode({ qualifiedName: "DataRaptor:Orphan", label: "DataRaptor" });
      const r = await callTool("dead_code_audit", {
        org: fix.orgId,
        label: "dataraptor",
        confidence: "high",
      });
      const md = r.markdown as string;
      expect(md).toContain("- DataRaptor:Orphan");
      expect(md).toMatch(/confidence\/freshness filters do not apply/);
    });

    it("applies pattern and limit on the live path", async () => {
      seedCache();
      for (const n of ["Acme_A", "Acme_B", "Acme_C", "Other_D"]) {
        fix.addNode({ qualifiedName: `DataRaptor:${n}`, label: "DataRaptor" });
      }
      const r = await callTool("dead_code_audit", {
        org: fix.orgId,
        label: "DataRaptor",
        pattern: "Acme_",
        limit: 2,
      });
      const md = r.markdown as string;
      expect(
        technical(md)
          .split("\n")
          .filter((l) => l.startsWith("- ")).length,
      ).toBe(2);
      expect(md).not.toContain("Other_D");
      expect((r.data as { total: number }).total).toBe(3);
      expect(md).toMatch(/1 more not shown/);
    });

    it("says the label is not scored when it has no nodes, never 'no dead code'", async () => {
      seedCache();
      const r = await callTool("dead_code_audit", { org: fix.orgId, label: "Nonexistent" });
      const md = r.markdown as string;
      expect(md).toContain("label Nonexistent is not scored by dead_code_audit");
      expect(md).not.toContain("no dead code detected");
    });
  });

  describe("label=LWC uses the scored path", () => {
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 1000;
    beforeEach(() => {
      fix.addNode({ qualifiedName: "LWC:lonelyCard", label: "LWC", lastModifiedAt: ancient });
      fix.addEdge({
        srcQualifiedName: "LWCBundle:lonelyCard",
        dstQualifiedName: "LWC:lonelyCard",
        relType: REL_TYPES.CONTAINS_COMPONENT,
      });
      fix.addNode({ qualifiedName: "LWC:childCard", label: "LWC", lastModifiedAt: ancient });
      fix.addEdge({
        srcQualifiedName: "LWC:parentCard",
        dstQualifiedName: "LWC:childCard",
        relType: REL_TYPES.EMBEDS_LWC,
      });
    });

    it("returns a bundle-only LWC without a cache (findDeadCode)", async () => {
      const r = await callTool("dead_code_audit", { org: fix.orgId, label: "LWC" });
      const d = r.data as {
        dead: Array<{ qualifiedName: string }>;
        scored?: boolean;
        live?: boolean;
      };
      const names = d.dead.map((x) => String(x.qualifiedName ?? x));
      expect(names).toContain("LWC:lonelyCard");
      expect(names).not.toContain("LWC:childCard");
      expect(d.scored).not.toBe(false);
      expect(d.live).toBeUndefined();
    });

    it("returns it from the populated score cache", async () => {
      const db = (fix.ctx.graphStore as unknown as { db: never }).db;
      recordSync();
      analyze.populateDeadCodeScores(fix.ctx.graphStore as never, fix.ctx.orgId as never, db);
      (fix.ctx as { db?: unknown }).db = db;
      const r = await callTool("dead_code_audit", { org: fix.orgId, label: "lwc" });
      const d = r.data as {
        dead: Array<{ qualifiedName: string; confidence: string; reasons: string[] }>;
        cached: boolean;
      };
      expect(d.cached).toBe(true);
      const row = (q: string) => d.dead.find((x) => x.qualifiedName === q);
      expect(row("LWC:lonelyCard")?.reasons).toContain("no_incoming_edges");
      // Stale but embedded: a real inbound edge, so not a candidate at all.
      expect(row("LWC:childCard")).toBeUndefined();
    });
  });

  describe("score cache lists only zero-inbound nodes", () => {
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 1000;
    type Row = { qualifiedName: string; confidence: string };
    function populate(): void {
      const db = (fix.ctx.graphStore as unknown as { db: never }).db;
      recordSync();
      analyze.populateDeadCodeScores(fix.ctx.graphStore as never, fix.ctx.orgId as never, db);
      (fix.ctx as { db?: unknown }).db = db;
    }
    beforeEach(() => {
      fix.addNode({
        qualifiedName: "ApexClass:StaleUsed",
        label: "ApexClass",
        lastModifiedAt: ancient,
      });
      fix.addNode({
        qualifiedName: "ApexClass:Caller",
        label: "ApexClass",
        lastModifiedAt: Date.now(),
      });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Caller",
        dstQualifiedName: "ApexClass:StaleUsed",
        relType: REL_TYPES.CALLS,
      });
      fix.addNode({
        qualifiedName: "ApexClass:StaleOrphan",
        label: "ApexClass",
        lastModifiedAt: ancient,
      });
      fix.addNode({ qualifiedName: "Flow:StaleUsedFlow", label: "Flow", lastModifiedAt: ancient });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Caller",
        dstQualifiedName: "Flow:StaleUsedFlow",
        relType: REL_TYPES.REFERENCES,
      });
      fix.addNode({
        qualifiedName: "Flow:StaleOrphanFlow",
        label: "Flow",
        lastModifiedAt: ancient,
      });
      fix.addNode({ qualifiedName: "LWC:lonelyCard", label: "LWC", lastModifiedAt: ancient });
      fix.addEdge({
        srcQualifiedName: "LWCBundle:lonelyCard",
        dstQualifiedName: "LWC:lonelyCard",
        relType: REL_TYPES.CONTAINS_COMPONENT,
      });
    });

    it("does not list a stale node with one real inbound edge, at any confidence", async () => {
      populate();
      for (const confidence of [undefined, "high", "medium", "low"] as const) {
        const r = await callTool("dead_code_audit", {
          org: fix.orgId,
          limit: 500,
          ...(confidence ? { confidence } : {}),
        });
        const names = (r.data as { dead: Row[] }).dead.map((d) => d.qualifiedName);
        expect(names).not.toContain("ApexClass:StaleUsed");
        expect(names).not.toContain("Flow:StaleUsedFlow");
      }
    });

    it("lists a stale node with zero inbound as high", async () => {
      populate();
      const r = await callTool("dead_code_audit", {
        org: fix.orgId,
        confidence: "high",
        limit: 500,
      });
      const names = (r.data as { dead: Row[] }).dead.map((d) => d.qualifiedName);
      expect(names).toContain("ApexClass:StaleOrphan");
      expect(names).toContain("Flow:StaleOrphanFlow");
      expect(names).toContain("LWC:lonelyCard");
    });

    it("cached and uncached results are the same set of qnames", async () => {
      const live = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
      expect((live.data as { cached: boolean }).cached).toBe(false);
      const liveNames = deadNames(live).sort();
      populate();
      const cached = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
      expect((cached.data as { cached: boolean }).cached).toBe(true);
      const cachedNames = (cached.data as { dead: Row[] }).dead.map((d) => d.qualifiedName).sort();
      expect(cachedNames).toEqual(liveNames);
      expect(cachedNames.length).toBeGreaterThan(0);
    });

    it("uncached confidence=high never lists a fresh node; rows show score and reasons", async () => {
      fix.addNode({
        qualifiedName: "ApexClass:FreshOrphan",
        label: "ApexClass",
        lastModifiedAt: Date.now(),
      });
      const r = await callTool("dead_code_audit", {
        org: fix.orgId,
        confidence: "high",
        limit: 500,
      });
      const d = r.data as { cached: boolean; byConfidence: Record<string, number> };
      const dead = deadNames(r);
      expect(d.cached).toBe(false);
      expect(dead).not.toContain("ApexClass:FreshOrphan");
      expect(dead).not.toContain("ApexClass:Caller");
      expect(dead).toContain("ApexClass:StaleOrphan");
      expect(Object.keys(d.byConfidence)).toEqual(["high"]);
      expect(r.markdown).toMatch(
        /- ApexClass:StaleOrphan — high 0\.\d\d \(no_incoming_edges, stale_freshness\)/,
      );
      const low = await callTool("dead_code_audit", {
        org: fix.orgId,
        confidence: "low",
        limit: 500,
      });
      expect(deadNames(low)).toContain("ApexClass:FreshOrphan");
    });

    it("falls back to the live scan when a legacy cache holds only used-node rows", async () => {
      const db = (fix.ctx.graphStore as unknown as { db: { exec: (s: string) => void } }).db;
      populate();
      db.exec(`DELETE FROM _sfgraph_dead_code_scores;
        INSERT INTO _sfgraph_dead_code_scores VALUES
        ('${fix.orgId}', 'ApexClass:StaleUsed', 0.08, 'high', '["stale_freshness"]', 1);`);
      const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
      const d = r.data as { cached: boolean };
      expect(d.cached).toBe(false);
      expect(deadNames(r)).toContain("ApexClass:StaleOrphan");
      expect(deadNames(r)).not.toContain("ApexClass:StaleUsed");
    });

    it("ignores rows from an older cache that records a real inbound edge", async () => {
      const db = (fix.ctx.graphStore as unknown as { db: { exec: (s: string) => void } }).db;
      populate();
      // Current computed_at keeps the stamped cache fresh, so the stray row
      // reaches the reader and must be dropped there.
      db.exec(`INSERT OR REPLACE INTO _sfgraph_dead_code_scores VALUES
        ('${fix.orgId}', 'ApexClass:StaleUsed', 0.08, 'high', '["stale_freshness"]', ${Date.now()});`);
      const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
      expect((r.data as { cached: boolean }).cached).toBe(true);
      const names = (r.data as { dead: Row[] }).dead.map((d) => d.qualifiedName);
      expect(names).not.toContain("ApexClass:StaleUsed");
      expect(names).toContain("ApexClass:StaleOrphan");
    });
  });
});
