import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("governor_risk_check", () => {
  // Detection reads real EXECUTES_SOQL / EXECUTES_DML edges stamped inLoop:true
  // by the Apex/trigger parsers — NOT a `hasSoqlInLoop` attribute (which no
  // parser ever set; the old placeholder made this tool fabricate "no risks").
  const addLoopMethod = (cls: string, rel: string): string => {
    const m = `ApexMethod:${cls}.run(0)`;
    fix.addNode({ qualifiedName: m, label: "ApexMethod" });
    fix.addEdge({
      srcQualifiedName: m,
      dstQualifiedName: rel === "EXECUTES_SOQL" ? "CustomObject:Account" : "DML:update",
      relType: rel,
      attributes: {
        inLoop: true,
        ...(rel === "EXECUTES_SOQL" ? { query: "[SELECT Id FROM Account]" } : { target: "acc" }),
      },
    });
    return m;
  };

  it("empty when a method has SOQL but NOT in a loop", async () => {
    const m = "ApexMethod:Clean.run(0)";
    fix.addNode({ qualifiedName: m, label: "ApexMethod" });
    fix.addEdge({
      srcQualifiedName: m,
      dstQualifiedName: "CustomObject:Account",
      relType: "EXECUTES_SOQL",
      attributes: { query: "[SELECT Id FROM Account]" }, // no inLoop
    });
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    expect((r.data as { risks: unknown[] }).risks.length).toBe(0);
  });

  it("flags soql_in_loop from an inLoop EXECUTES_SOQL edge", async () => {
    const m = addLoopMethod("Risky", "EXECUTES_SOQL");
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const risks = (r.data as { risks: Array<{ qualifiedName: string; risk: string }> }).risks;
    expect(risks.some((x) => x.qualifiedName === m && x.risk === "soql_in_loop")).toBe(true);
  });

  it("returns no-risks summary for empty graph", async () => {
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    expect(r.summary).toBe("no risks detected");
    expect((r.data as { risks: unknown[] }).risks).toEqual([]);
  });

  it("flags dml_in_loop from an inLoop EXECUTES_DML edge", async () => {
    const m = addLoopMethod("DmlLoop", "EXECUTES_DML");
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const risks = (r.data as { risks: Array<{ qualifiedName: string; risk: string }> }).risks;
    expect(risks.some((x) => x.qualifiedName === m && x.risk === "dml_in_loop")).toBe(true);
  });

  it("flags multiple methods independently", async () => {
    addLoopMethod("R1", "EXECUTES_SOQL");
    addLoopMethod("R2", "EXECUTES_DML");
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const risks = (r.data as { risks: Array<{ qualifiedName: string }> }).risks;
    expect(risks.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects empty org", async () => {
    await expect(callTool("governor_risk_check", { org: "" })).rejects.toThrow();
  });

  it("reports cached=false when no cache table is present", async () => {
    fix.addNode({ qualifiedName: "ApexClass:X", label: "ApexClass" });
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    expect((r.data as { cached: boolean }).cached).toBe(false);
  });
});
