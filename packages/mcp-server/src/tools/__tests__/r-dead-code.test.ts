import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// Batch R / S6: test references count as references. Unreferenced test
// classes are dead (isTest: true); production code used only by tests is in
// data.referencedOnlyByTests, not in dead.
let fix: Fixture;
const ancient = Date.now() - 1000 * 60 * 60 * 24 * 1000;
type Row = { qualifiedName: string; isTest?: boolean; reasons: string[] };

beforeEach(async () => {
  fix = await createFixture();
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
  fix.addNode({ qualifiedName: "DataRaptor:DR_Orphan", label: "DataRaptor" });
  fix.addNode({ qualifiedName: "DataRaptor:DR_Tested", label: "DataRaptor" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:OnlyTestedTest",
    dstQualifiedName: "DataRaptor:DR_Tested",
    relType: REL_TYPES.REFERENCES,
  });
});
afterEach(async () => {
  await fix.cleanup();
});

describe("dead_code_audit: test references count", () => {
  it("lists unreferenced test classes as dead with isTest, test-only code apart", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    const d = r.data as { dead: Row[]; referencedOnlyByTests: Row[] };
    const dead = new Map(d.dead.map((x) => [x.qualifiedName, x]));
    expect(dead.get("ApexClass:Orphan")?.isTest).toBe(false);
    expect(dead.get("ApexClass:OnlyTestedTest")?.isTest).toBe(true);
    expect(dead.has("ApexClass:OnlyTested")).toBe(false);
    expect(d.referencedOnlyByTests.map((x) => x.qualifiedName)).toEqual(["ApexClass:OnlyTested"]);
    expect(r.markdown).toMatch(/Referenced only by tests/);
  });

  it("unscored labels use the same rule", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, label: "DataRaptor" });
    const d = r.data as { dead: Row[]; referencedOnlyByTests: Row[] };
    expect(d.dead.map((x) => x.qualifiedName)).toEqual(["DataRaptor:DR_Orphan"]);
    expect(d.referencedOnlyByTests.map((x) => x.qualifiedName)).toEqual(["DataRaptor:DR_Tested"]);
  });
  it("an unscored label with no nodes returns the same keys, empty (fix M-5)", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, label: "VlocityCard" });
    const d = r.data as Record<string, unknown>;
    expect(d.dead).toEqual([]);
    expect(d.total).toBe(0);
    expect(d.referencedOnlyByTests).toEqual([]);
    expect(d.referencedOnlyByTestsTotal).toBe(0);
  });

  it("the unscored-label prose says test references count (fix M-4)", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, label: "DataRaptor" });
    expect(r.markdown).not.toMatch(/no real incoming reference/);
    expect(r.markdown).toMatch(/no incoming reference \(test references count\)/);
  });
});

// Cycle 3 T5 fix 1 (M3): the test-class note shows only when a test class is listed.
describe("dead_code_audit test-class note", () => {
  const NOTE = /References from tests count, so an unused test class is listed/;
  it("is shown when an unused test class is listed", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 500 });
    expect(r.markdown).toMatch(NOTE);
  });

  it("is left out when no test class is listed", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, label: "DataRaptor" });
    expect(r.markdown).toMatch(/DR_Orphan/);
    expect(r.markdown).not.toMatch(NOTE);
  });
});
