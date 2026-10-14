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

  // Cycle 3 T9 fix 1: the groups read A to Z, and the test classes left out are named.
  it("lists the classes A to Z, whatever their worst spot", async () => {
    addLoopMethod("Zeta", "EXECUTES_SOQL");
    addLoopMethod("Alpha", "EXECUTES_DML");
    addLoopMethod("Mid", "EXECUTES_SOQL");
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const md = r.markdown as string;
    const heads = [...md.matchAll(/^#### `([^`]+)`/gm)].map((m) => m[1]);
    expect(heads).toEqual(["ApexClass:Alpha", "ApexClass:Mid", "ApexClass:Zeta"]);
    const pieces = md.slice(
      md.indexOf("**What each piece does**"),
      md.indexOf("**Technical details**"),
    );
    expect(pieces.indexOf("`Alpha`")).toBeLessThan(pieces.indexOf("`Mid`"));
    expect(pieces.indexOf("`Mid`")).toBeLessThan(pieces.indexOf("`Zeta`"));
    expect(md).toMatch(/grouped by class or trigger, A to Z/i);
    // data keeps the documented priority order
    const risks = (r.data as { risks: Array<{ qualifiedName: string }> }).risks;
    expect(risks.map((x) => x.qualifiedName)).toEqual([
      "ApexMethod:Mid.run(0)",
      "ApexMethod:Zeta.run(0)",
      "ApexMethod:Alpha.run(0)",
    ]);
  });

  it("names the test classes whose spots were left out", async () => {
    addLoopMethod("Live", "EXECUTES_SOQL");
    for (const c of ["LiveTest", "OtherTest"]) {
      const m = `ApexMethod:${c}.run(0)`;
      fix.addNode({ qualifiedName: m, label: "ApexMethod", attributes: { isTest: true } });
      fix.addEdge({
        srcQualifiedName: m,
        dstQualifiedName: "CustomObject:Account",
        relType: "EXECUTES_SOQL",
        attributes: { inLoop: true, query: "[SELECT Id FROM Account]" },
      });
    }
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const md = r.markdown as string;
    expect(md).toContain("2 spots in test code were left out, in `LiveTest` and `OtherTest`");
    expect(md).toContain("Left out as test code: `ApexClass:LiveTest`, `ApexClass:OtherTest`");
    const withTests = await callTool("governor_risk_check", { org: fix.orgId, includeTests: true });
    expect(withTests.markdown as string).not.toContain("Left out as test code");
  });

  it("names the left-out test classes when nothing else is found", async () => {
    const m = "ApexMethod:OnlyTest.run(0)";
    fix.addNode({ qualifiedName: m, label: "ApexMethod", attributes: { isTest: true } });
    fix.addEdge({
      srcQualifiedName: m,
      dstQualifiedName: "DML:update",
      relType: "EXECUTES_DML",
      attributes: { inLoop: true, target: "acc" },
    });
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    expect(r.markdown as string).toContain("1 spot in test code was left out, in `OnlyTest`");
  });

  // Cycle 3 T9 fix 2: past `limit`, the classes whose spots were cut are still named.
  it("names the classes and triggers whose spots fall past the limit", async () => {
    addLoopMethod("Alpha", "EXECUTES_SOQL");
    addLoopMethod("Beta", "EXECUTES_SOQL");
    addLoopMethod("Cut", "EXECUTES_DML");
    const r = await callTool("governor_risk_check", { org: fix.orgId, limit: 2 });
    const md = r.markdown as string;
    expect(md).toMatch(
      /1 other spot is in 1 Apex class[^.]* not listed below; Technical details names it\./,
    );
    expect(md).toContain(
      "Not listed below (their spots rank lower), A to Z: `ApexClass:Cut` (1 spot).",
    );
    const all = await callTool("governor_risk_check", { org: fix.orgId });
    expect(all.markdown as string).not.toContain("Not listed below");
  });

  // Cycle 3 T9 review M2/M3: one over a cap is named, and Technical details lists are capped.
  it("names one spot over the cap instead of writing and 1 more", async () => {
    for (const n of ["a", "b", "c", "d"]) {
      const m = `ApexMethod:Four.${n}(0)`;
      fix.addNode({ qualifiedName: m, label: "ApexMethod" });
      fix.addEdge({
        srcQualifiedName: m,
        dstQualifiedName: "DML:update",
        relType: "EXECUTES_DML",
        attributes: { inLoop: true, target: "acc" },
      });
    }
    const md = (await callTool("governor_risk_check", { org: fix.orgId })).markdown as string;
    expect(md).not.toContain("and 1 more");
    expect(md).toMatch(/in `a`, .*in `b`, .*in `c` and .*in `d`\./);
  });

  it("caps the Technical details name lists at 50", async () => {
    const add = (cls: string, isTest: boolean) => {
      const m = `ApexMethod:${cls}.run(0)`;
      fix.addNode({
        qualifiedName: m,
        label: "ApexMethod",
        ...(isTest ? { attributes: { isTest } } : {}),
      });
      fix.addEdge({
        srcQualifiedName: m,
        dstQualifiedName: "DML:update",
        relType: "EXECUTES_DML",
        attributes: { inLoop: true, target: "acc" },
      });
    };
    for (let i = 0; i < 60; i++) add(`C${String(i).padStart(2, "0")}`, false);
    for (let i = 0; i < 60; i++) add(`T${String(i).padStart(2, "0")}Test`, true);
    const md = (await callTool("governor_risk_check", { org: fix.orgId, limit: 1 }))
      .markdown as string;
    const cut = md.split("\n").find((l) => l.startsWith("Not listed below"));
    expect(cut).toMatch(/ and 9 more \(`export_sarif` lists them all\)\.$/);
    expect(cut?.match(/`ApexClass:/g)).toHaveLength(50);
    const tests = md.split("\n").find((l) => l.startsWith("Left out as test code:"));
    expect(tests).toMatch(/ and 10 more\.$/);
    expect(tests?.match(/`ApexClass:/g)).toHaveLength(50);
  });
});
