import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit tools-24: impact_from_git_diff unions findDependents and
 * findDependencies, so a changed class's own contained method (a downstream
 * dependency) is reported as "impacted".
 */
let fix: Fixture;

const DIFF = `diff --git a/force-app/main/default/classes/LoopGuard.cls b/force-app/main/default/classes/LoopGuard.cls
--- a/force-app/main/default/classes/LoopGuard.cls
+++ b/force-app/main/default/classes/LoopGuard.cls
@@ -1 +1 @@
-old
+new
`;

beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "ApexClass:LoopGuard", label: "ApexClass" });
  fix.addNode({ qualifiedName: "ApexMethod:LoopGuard.run(0)", label: "ApexMethod" });
  fix.addNode({ qualifiedName: "ApexClass:Caller", label: "ApexClass" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:LoopGuard",
    dstQualifiedName: "ApexMethod:LoopGuard.run(0)",
    relType: REL_TYPES.CONTAINS_METHOD,
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Caller",
    dstQualifiedName: "ApexClass:LoopGuard",
    relType: REL_TYPES.CALLS,
  });
});

afterEach(async () => {
  await fix.cleanup();
});

describe("audit tools-24: impact_from_git_diff direction", () => {
  it("reports dependents only, not the changed class's own dependencies", async () => {
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    const d = r.data as { impacted: string[] };
    expect(d.impacted).toContain("ApexClass:Caller");
    expect(d.impacted).not.toContain("ApexMethod:LoopGuard.run(0)");
  });

  it("keeps downstream nodes in a separate dependencies list", async () => {
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    const d = r.data as { dependencies: string[]; dependents: string[] };
    expect(d.dependencies).toContain("ApexMethod:LoopGuard.run(0)");
    expect(d.dependents).toEqual(["ApexClass:Caller"]);
  });

  it("lists impacted nodes in markdown, including callers of the class's methods", async () => {
    fix.addNode({ qualifiedName: "ApexClass:MethodCaller", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:MethodCaller",
      dstQualifiedName: "ApexMethod:LoopGuard.run(0)",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    expect((r.data as { impacted: string[] }).impacted).toContain("ApexClass:MethodCaller");
    expect(r.markdown).toContain("- `ApexClass:Caller` (ApexClass)");
    expect(r.markdown).toContain("- `ApexClass:MethodCaller` (ApexClass)");
    expect(r.markdown).toContain("- `ApexClass:LoopGuard` (ApexClass) — changed");
  });
});

// Cycle 2 T5 fix round 1: the impacted list is grouped (changed first, then dependents by
// label, production before tests) and each method row names its class; the diagram draws
// methods as their class.
describe("impact_from_git_diff: grouped list, method classes", () => {
  function callers(): void {
    for (const [cls, m, label] of [
      ["Worker", "ApexMethod:Worker.go(0)", "ApexMethod"],
      ["LoopGuardTest", "ApexMethod:LoopGuardTest.t(0)", "TestMethod"],
    ] as const) {
      fix.addNode({ qualifiedName: `ApexClass:${cls}`, label: "ApexClass" });
      fix.addNode({ qualifiedName: m, label });
      fix.addEdge({
        srcQualifiedName: `ApexClass:${cls}`,
        dstQualifiedName: m,
        relType: REL_TYPES.CONTAINS_METHOD,
      });
      fix.addEdge({
        srcQualifiedName: m,
        dstQualifiedName: "ApexMethod:LoopGuard.run(0)",
        relType: REL_TYPES.CALLS,
      });
    }
  }

  it("groups changed, then dependents by label with tests last", async () => {
    callers();
    const md = (await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 1 }))
      .markdown;
    const i = (s: string) => md.indexOf(s);
    expect(i("### Changed (1)\n- `ApexClass:LoopGuard` (ApexClass) — changed")).toBeGreaterThan(-1);
    expect(i("### Dependents: ApexClass")).toBeGreaterThan(i("### Changed"));
    expect(
      i(
        "### Dependents: ApexMethod (1)\n- `ApexMethod:Worker.go(0)` (ApexMethod, in ApexClass:Worker)",
      ),
    ).toBeGreaterThan(-1);
    expect(
      i(
        "### Dependents: TestMethod (1)\n- `ApexMethod:LoopGuardTest.t(0)` (TestMethod, in ApexClass:LoopGuardTest)",
      ),
    ).toBeGreaterThan(i("### Dependents: ApexMethod"));
  });

  it("lists the classes of dependent methods not listed themselves", async () => {
    callers();
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 1 });
    // depth 1 reaches the methods, not their classes.
    expect((r.data as { impacted: string[] }).impacted).not.toContain("ApexClass:Worker");
    expect(r.markdown).toContain(
      "### Classes of the listed methods (2 not listed above)\n- `ApexClass:LoopGuardTest`\n- `ApexClass:Worker`",
    );
  });

  it("the diagram draws a method as its class", async () => {
    callers();
    const md = (await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 1 }))
      .markdown;
    const diagram = md.slice(md.indexOf("```mermaid"));
    // Cycle 3 T3: the report's Picture (`Kind: Name` node text) replaced the core diagram.
    expect(diagram).not.toContain("Apex method: Worker.go(0)");
    expect(diagram).toContain('["Apex class: Worker"]');
  });
});
