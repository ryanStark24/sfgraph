import path from "node:path";
import { analyze } from "@ryanstark24/sfgraph-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit tools-17: the cached governor table keys rows by
 * (org, qname, risk_type, line) with line always -1, so two SOQL-in-loop
 * statements in one method collapse into one cached row; the cached path then
 * disagrees with the live path (and export_sarif). Test methods are also
 * dropped from the cache but kept by the live scan.
 */
let fix: Fixture;
let prevExports: string | undefined;

/**
 * A fixed sync instant long before any populate (cycle 3 T6). It used to be `Date.now() - 60s`,
 * which tied cache freshness to the wall clock: a clock step back of over a minute between
 * recordSync and the populate after it made the cache read as stale (live scan only).
 */
const SYNCED_AT = new Date(1_000).toISOString();

/** Mark the org synced in the past so a cache populated afterwards is fresh. */
function recordSync(): void {
  fix.ctx.graphStore.upsertOrg({
    id: fix.orgId,
    alias: "t17",
    instanceUrl: "https://example.my.salesforce.com",
    apiVersion: "62.0",
    createdAt: 1,
  });
  fix.ctx.graphStore.markSyncComplete(fix.orgId, SYNCED_AT);
}

beforeEach(async () => {
  fix = await createFixture();
  // export_sarif writes `<org>.sarif`; keep it in this test's own dir, not the exports dir every
  // test file in the run shares (they all use org "org1").
  prevExports = process.env.SFGRAPH_EXPORTS_DIR;
  process.env.SFGRAPH_EXPORTS_DIR = path.join(fix.workDir, "exports");
  const m = "ApexMethod:Multi.run(0)";
  fix.addNode({ qualifiedName: m, label: "ApexMethod" });
  for (const [obj, q] of [
    ["Account", "[SELECT Id FROM Account WHERE Id = :a]"],
    ["Contact", "[SELECT Id FROM Contact WHERE Id = :c]"],
  ] as const) {
    fix.addEdge({
      srcQualifiedName: m,
      dstQualifiedName: `CustomObject:${obj}`,
      relType: "EXECUTES_SOQL",
      attributes: { inLoop: true, query: q },
    });
  }
  (fix.ctx as { db?: unknown }).db = (fix.ctx.graphStore as unknown as { db: unknown }).db;
  analyze.populateGovernorRisks(
    fix.ctx.graphStore,
    fix.orgId,
    (fix.ctx.graphStore as unknown as { db: never }).db,
  );
});

afterEach(async () => {
  if (prevExports === undefined) {
    // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
    delete process.env.SFGRAPH_EXPORTS_DIR;
  } else process.env.SFGRAPH_EXPORTS_DIR = prevExports;
  await fix.cleanup();
});

describe("audit tools-17: governor_risk_check cache fidelity", () => {
  it("cached result reports every in-loop SOQL, matching the live scan", async () => {
    const live = analyze.findGovernorRisks(fix.ctx.graphStore, fix.orgId);
    expect(live.length).toBe(2);
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const d = r.data as { total: number; risks: unknown[] };
    expect(d.total).toBe(live.length);
  });

  it("excludes test code from both the live and cached paths (includeTests opts in)", async () => {
    const t = "TestMethod:MultiTest.loops(0)";
    fix.addNode({ qualifiedName: t, label: "TestMethod" });
    fix.addEdge({
      srcQualifiedName: t,
      dstQualifiedName: "CustomObject:Lead",
      relType: "EXECUTES_SOQL",
      attributes: { inLoop: true, query: "[SELECT Id FROM Lead]" },
    });
    // isTest class whose body-scan risk only exists in the cache.
    fix.addNode({
      qualifiedName: "ApexClass:MultiTest",
      label: "ApexClass",
      attributes: { isTest: true, hasSoqlInLoop: true },
    });
    recordSync();
    analyze.populateGovernorRisks(
      fix.ctx.graphStore,
      fix.orgId,
      (fix.ctx.graphStore as unknown as { db: never }).db,
    );
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const d = r.data as {
      total: number;
      risks: Array<{ qualifiedName: string }>;
      excludedTests: number;
    };
    expect(d.risks.map((x) => x.qualifiedName)).not.toContain(t);
    expect(d.risks.map((x) => x.qualifiedName)).not.toContain("ApexClass:MultiTest");
    expect(d.total).toBe(2);
    expect(d.excludedTests).toBe(2);
    const sarif = await callTool("export_sarif", { org: fix.orgId, audits: ["governor"] });
    expect((sarif.data as { findings: unknown[] }).findings.length).toBe(d.total);

    const withTests = await callTool("governor_risk_check", { org: fix.orgId, includeTests: true });
    const wq = (withTests.data as { risks: Array<{ qualifiedName: string }> }).risks.map(
      (x) => x.qualifiedName,
    );
    expect(wq).toContain(t);
    expect(wq).toContain("ApexClass:MultiTest");
  });

  it("orders risks by qualified name regardless of insertion order", async () => {
    for (const cls of ["Zeta", "Alpha", "Mid"]) {
      const m = `ApexMethod:${cls}.run(0)`;
      fix.addNode({ qualifiedName: m, label: "ApexMethod" });
      fix.addEdge({
        srcQualifiedName: m,
        dstQualifiedName: "CustomObject:Account",
        relType: "EXECUTES_SOQL",
        attributes: { inLoop: true, query: `[SELECT Id FROM Account /*${cls}*/]` },
      });
    }
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const q = (r.data as { risks: Array<{ qualifiedName: string }> }).risks.map(
      (x) => x.qualifiedName,
    );
    expect(q).toEqual([...q].sort((a, b) => a.localeCompare(b)));
    expect(q[0]).toBe("ApexMethod:Alpha.run(0)");
  });

  it("keeps cache-only risks the edge scan cannot see (class body scan)", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:Legacy",
      label: "ApexClass",
      attributes: { hasDmlInLoop: true },
    });
    recordSync();
    analyze.populateGovernorRisks(
      fix.ctx.graphStore,
      fix.orgId,
      (fix.ctx.graphStore as unknown as { db: never }).db,
    );
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const d = r.data as {
      total: number;
      source: string;
      risks: Array<{ qualifiedName: string; risk: string }>;
    };
    expect(d.source).toBe("live+cache");
    expect(d.risks).toContainEqual(
      expect.objectContaining({ qualifiedName: "ApexClass:Legacy", risk: "dml_in_loop" }),
    );
    expect(d.total).toBe(3);
  });

  it("ignores the cache supplement when freshness is unknown", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:Legacy",
      label: "ApexClass",
      attributes: { hasDmlInLoop: true },
    });
    analyze.populateGovernorRisks(
      fix.ctx.graphStore,
      fix.orgId,
      (fix.ctx.graphStore as unknown as { db: never }).db,
    );
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const d = r.data as { source: string; cache: string; total: number };
    expect(d.cache).toBe("unknown");
    expect(d.source).toBe("live");
    expect(d.total).toBe(2);
    expect(r.markdown).toMatch(/cache unverified/);
  });
});
