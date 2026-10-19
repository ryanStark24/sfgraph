import { analyze } from "@ryanstark24/sfgraph-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Hand-off from the core analyze batch:
 * 1. dead_code_audit and the SARIF dead-code source read the score cache via
 *    core's version-stamped readDeadCodeScores, so unstamped (pre-fix) rows
 *    are never served. M1 still applies: only a fresh cache is trusted.
 * 2. The live path uses core's deadCodeCandidates + scoreDeadCode(testOnlyRefs):
 *    a class referenced only by tests is listed apart in `referencedOnlyByTests`
 *    with `referenced_only_by_tests`; an unreferenced @isTest class is dead
 *    with `isTest: true` (Batch R / S6: test references count).
 */
let fix: Fixture;
const ancient = Date.now() - 1000 * 60 * 60 * 24 * 1000;
type Row = { qualifiedName: string; reasons: string[] };

function db(): { exec: (s: string) => void } {
  return (fix.ctx.graphStore as unknown as { db: { exec: (s: string) => void } }).db;
}
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
  (fix.ctx as { db?: unknown }).db = db();
  fix.addNode({ qualifiedName: "ApexClass:Orphan", label: "ApexClass", lastModifiedAt: ancient });
  fix.addNode({
    qualifiedName: "ApexClass:OnlyTested",
    label: "ApexClass",
    lastModifiedAt: ancient,
  });
  fix.addNode({
    qualifiedName: "ApexClass:OnlyTestedTest",
    label: "ApexClass",
    lastModifiedAt: ancient,
    attributes: { isTest: true },
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:OnlyTestedTest",
    dstQualifiedName: "ApexClass:OnlyTested",
    relType: REL_TYPES.CALLS,
  });
});
afterEach(async () => {
  await fix.cleanup();
});

describe("dead-code cache goes through core's version-stamped reader", () => {
  it("dead_code_audit ignores an unstamped legacy cache even when it looks fresh", async () => {
    recordSync();
    db().exec(`CREATE TABLE IF NOT EXISTS _sfgraph_dead_code_scores (
      org_id TEXT, qualified_name TEXT, score REAL, confidence TEXT, reasons TEXT, computed_at INTEGER,
      PRIMARY KEY (org_id, qualified_name));
      INSERT INTO _sfgraph_dead_code_scores VALUES
      ('${fix.orgId}', 'ApexClass:Ghostly', 0.01, 'high', '["no_incoming_edges"]', ${Date.now()});`);
    const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    const d = r.data as { dead: Array<Row | string>; cached: boolean };
    expect(d.cached).toBe(false);
    const names = d.dead.map((x) => (typeof x === "string" ? x : x.qualifiedName));
    expect(names).not.toContain("ApexClass:Ghostly");
    expect(names).toContain("ApexClass:Orphan");
  });

  it("export_sarif dead-code source ignores an unstamped legacy cache", async () => {
    recordSync();
    db().exec(`CREATE TABLE IF NOT EXISTS _sfgraph_dead_code_scores (
      org_id TEXT, qualified_name TEXT, score REAL, confidence TEXT, reasons TEXT, computed_at INTEGER,
      PRIMARY KEY (org_id, qualified_name));
      INSERT INTO _sfgraph_dead_code_scores VALUES
      ('${fix.orgId}', 'ApexClass:Orphan', 0.01, 'high', '["no_incoming_edges"]', ${Date.now()});`);
    const r = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    expect((r.data as { sources: Record<string, string> }).sources["dead-code"]).toMatch(/^live/);
  });

  it("a stamped, fresh cache is served; the same cache with no recorded sync is not (M1)", async () => {
    analyze.populateDeadCodeScores(fix.ctx.graphStore as never, fix.orgId as never, db() as never);
    const unknown = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    expect((unknown.data as { cached: boolean }).cached).toBe(false);
    recordSync();
    analyze.populateDeadCodeScores(fix.ctx.graphStore as never, fix.orgId as never, db() as never);
    const fresh = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    expect((fresh.data as { cached: boolean }).cached).toBe(true);
    const sarif = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    expect((sarif.data as { sources: Record<string, string> }).sources["dead-code"]).toBe("cache");
  });
});

describe("stamped cache keeps referenced_only_by_tests rows (core e32f861)", () => {
  it("a fresh stamped cache with a test-only row is served on both paths", async () => {
    recordSync();
    analyze.populateDeadCodeScores(fix.ctx.graphStore as never, fix.orgId as never, db() as never);
    const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    const d = r.data as { dead: Row[]; referencedOnlyByTests: Row[]; cached: boolean };
    expect(d.cached).toBe(true);
    const row = d.referencedOnlyByTests.find((x) => x.qualifiedName === "ApexClass:OnlyTested");
    expect(row?.reasons).toContain("referenced_only_by_tests");
    expect(d.dead.some((x) => x.qualifiedName === "ApexClass:OnlyTested")).toBe(false);
    const sarif = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    expect((sarif.data as { sources: Record<string, string> }).sources["dead-code"]).toBe("cache");
    // SARIF lists dead code only: the test-only class is not a dead finding.
    const report = JSON.stringify((sarif.data as { report: unknown }).report);
    expect(report).toContain("ApexClass:Orphan");
    expect(report).not.toMatch(/ApexClass:OnlyTested(?!Test)/);
  });
});

describe("live dead-code path uses deadCodeCandidates + testOnlyRefs", () => {
  it("lists a class referenced only by tests apart; the unreferenced @isTest class is dead", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    const d = r.data as { dead: Row[]; referencedOnlyByTests: Row[]; cached: boolean };
    expect(d.cached).toBe(false);
    const row = (q: string) => d.dead.find((x) => x.qualifiedName === q);
    // Review N1: the reason is in `data`, not only in the markdown.
    expect(
      d.referencedOnlyByTests.find((x) => x.qualifiedName === "ApexClass:OnlyTested")?.reasons,
    ).toContain("referenced_only_by_tests");
    expect(row("ApexClass:OnlyTested")).toBeUndefined();
    expect(row("ApexClass:Orphan")?.reasons).not.toContain("referenced_only_by_tests");
    expect(row("ApexClass:OnlyTestedTest")).toMatchObject({ isTest: true });
    expect(row("ApexClass:OnlyTestedTest")?.reasons).toContain("test_class");
    const line = (q: string) => r.markdown.split("\n").find((l) => l.startsWith(`- ${q} `)) ?? "";
    expect(line("ApexClass:OnlyTestedTest")).toMatch(/test_class/);
    expect(line("ApexClass:Orphan")).not.toMatch(/referenced_only_by_tests/);
    expect(r.markdown).toMatch(/Referenced only by tests \(1/);
  });
});

describe("review N1: data.dead has one row shape on the live and cached paths", () => {
  it("live and cached rows have identical keys and values", async () => {
    const live = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    expect((live.data as { cached: boolean }).cached).toBe(false);
    recordSync();
    analyze.populateDeadCodeScores(fix.ctx.graphStore as never, fix.orgId as never, db() as never);
    const cached = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    expect((cached.data as { cached: boolean }).cached).toBe(true);
    type R = {
      qualifiedName: string;
      isTest: boolean;
      score: number;
      confidence: string;
      reasons: string[];
    };
    const norm = (rows: R[]) =>
      rows
        .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }))
        .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    const liveRows = (live.data as { dead: R[] }).dead;
    const cachedRows = (cached.data as { dead: R[] }).dead;
    expect(liveRows.length).toBeGreaterThan(0);
    for (const r of [...liveRows, ...cachedRows]) {
      expect(typeof r).toBe("object");
      expect(Object.keys(r).sort()).toEqual([
        "confidence",
        "isTest",
        "qualifiedName",
        "reasons",
        "score",
      ]);
    }
    expect(norm(liveRows)).toEqual(norm(cachedRows));
  });

  it("unscored labels use the same row shape with null score/confidence", async () => {
    fix.addNode({ qualifiedName: "DataRaptor:Orphan", label: "DataRaptor" });
    fix.addNode({ qualifiedName: "DataRaptor:Used", label: "DataRaptor" });
    fix.addNode({ qualifiedName: "OmniScript:Caller", label: "OmniScript" });
    fix.addEdge({
      srcQualifiedName: "OmniScript:Caller",
      dstQualifiedName: "DataRaptor:Used",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("dead_code_audit", { org: fix.orgId, label: "DataRaptor" });
    const d = r.data as { dead: unknown[]; scored: boolean; live: boolean };
    expect(d.scored).toBe(false);
    expect(d.live).toBe(true);
    expect(d.dead).toEqual([
      {
        qualifiedName: "DataRaptor:Orphan",
        isTest: false,
        score: null,
        confidence: null,
        reasons: [],
      },
    ]);
  });
});
