import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// Batch Q2 (task 14, B7): test-coverage tools decide coverage and test-ness on
// the owning class, report component rows, and default to direct dependents.
let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

function n(q: string, attributes?: Record<string, unknown>, label?: string, sourceHash?: string) {
  fix.addNode({
    qualifiedName: q,
    label: label ?? q.slice(0, q.indexOf(":")),
    ...(attributes ? { attributes } : {}),
    ...(sourceHash ? { sourceHash } : {}),
  });
}
function e(src: string, dst: string, rel: string): void {
  fix.addEdge({ srcQualifiedName: src, dstQualifiedName: dst, relType: rel });
}
function method(cls: string, m: string, attributes?: Record<string, unknown>, label?: string) {
  n(`ApexMethod:${cls}.${m}`, attributes, label);
  e(`ApexClass:${cls}`, `ApexMethod:${cls}.${m}`, REL_TYPES.CONTAINS_METHOD);
}

/** Target.run <- Caller.use <- Far.go; Covered.x (tested); CallerTest.t (a
 *  test method); an LWC import; a trigger. */
function graph(targetHash = "v1"): void {
  n("ApexClass:Target", undefined, undefined, targetHash);
  method("Target", "run(0)");
  n("ApexClass:Caller");
  method("Caller", "use(0)");
  method("Caller", "other(0)");
  n("ApexClass:Far");
  method("Far", "go(0)");
  n("ApexClass:Covered");
  method("Covered", "x(0)");
  n("ApexClass:CoveredTest", { isTest: true });
  method("CoveredTest", "t(0)", { isTest: true }, "TestMethod");
  n("ApexClass:CallerTest", { isTest: true });
  method("CallerTest", "t(0)", { isTest: true }, "TestMethod");
  n("ApexTrigger:Trg");
  n("LWC:ui");
  e("ApexClass:CoveredTest", "ApexClass:Covered", REL_TYPES.IS_TEST_FOR);
  e("ApexMethod:Caller.use(0)", "ApexMethod:Target.run(0)", REL_TYPES.CALLS);
  e("ApexMethod:Far.go(0)", "ApexMethod:Caller.use(0)", REL_TYPES.CALLS);
  e("ApexMethod:Covered.x(0)", "ApexMethod:Target.run(0)", REL_TYPES.CALLS);
  e("ApexMethod:CallerTest.t(0)", "ApexMethod:Target.run(0)", REL_TYPES.CALLS);
  e("ApexTrigger:Trg", "ApexMethod:Target.run(0)", REL_TYPES.CALLS);
  e("LWC:ui", "ApexMethod:Target.run(0)", REL_TYPES.IMPORTS_APEX);
}

const DIFF = `--- a/force-app/main/default/classes/Target.cls
+++ b/force-app/main/default/classes/Target.cls
@@
`;

type GapData = {
  gaps: string[];
  covered: string[];
  tests: string[];
  notApplicable: string[];
  changedGaps: string[];
};

describe("test_gap_intelligence_from_git_diff (B7)", () => {
  beforeEach(() => graph());

  it("direct dependents at class level; tests skipped; non-Apex not applicable", async () => {
    const r = await callTool("test_gap_intelligence_from_git_diff", { org: fix.orgId, diff: DIFF });
    const d = r.data as GapData;
    // The changed class itself is evaluated too ("changed ... or directly depending").
    expect(d.gaps).toEqual(["ApexClass:Caller", "ApexClass:Target", "ApexTrigger:Trg"]);
    expect(d.changedGaps).toEqual(["ApexClass:Target"]);
    expect(d.covered).toEqual(["ApexClass:Covered"]);
    expect(d.tests).toEqual(["ApexClass:CallerTest"]);
    expect(d.notApplicable).toEqual(["LWC:ui"]);
  });

  it("depth widens the dependents", async () => {
    const r = await callTool("test_gap_intelligence_from_git_diff", {
      org: fix.orgId,
      diff: DIFF,
      depth: 2,
    });
    expect((r.data as GapData).gaps).toContain("ApexClass:Far");
  });

  it("a method of a covered class is covered, not a gap", async () => {
    e("ApexClass:CoveredTest", "ApexClass:Caller", REL_TYPES.IS_TEST_FOR);
    const r = await callTool("test_gap_intelligence_from_git_diff", { org: fix.orgId, diff: DIFF });
    const d = r.data as GapData;
    expect(d.gaps).not.toContain("ApexClass:Caller");
    expect(d.covered).toContain("ApexClass:Caller");
    expect(d.gaps.some((g) => g.startsWith("ApexMethod:"))).toBe(false);
  });
});

type BrokeData = {
  changed: string[];
  added: string[];
  removed: string[];
  atRisk: string[];
  covered: string[];
  counts: Record<string, number>;
};

describe("what_broke (B7)", () => {
  async function run(extra: Record<string, unknown> = {}): Promise<BrokeData> {
    graph("v1");
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true);
    // Target's class and its method changed.
    n("ApexClass:Target", undefined, undefined, "v2");
    n("ApexMethod:Target.run(0)", undefined, undefined, "v2");
    const r = await callTool("what_broke", { org: fix.orgId, since: snap.id, ...extra });
    return r.data as BrokeData;
  }

  it("rolls up to class, direct dependents, keeps test classes after production", async () => {
    const d = await run();
    expect(d.changed).toEqual(["ApexClass:Target"]);
    expect(d.removed).toEqual([]);
    expect(d.atRisk).toEqual([
      "ApexClass:Caller",
      "ApexTrigger:Trg",
      "LWC:ui",
      "ApexClass:CallerTest",
    ]);
    expect(d.covered).toEqual(["ApexClass:Covered"]);
    expect(d.counts.tests).toBe(1);
  });

  it("sorts before the limit cut", async () => {
    const d = await run({ limit: 1 });
    expect(d.atRisk).toEqual(["ApexClass:Caller"]);
    expect(d.counts.atRisk).toBe(4);
  });

  it("depth widens the dependents", async () => {
    const d = await run({ depth: 2 });
    expect(d.atRisk).toContain("ApexClass:Far");
  });
});

describe("what_broke (fix round 1: M3, M4, M9)", () => {
  async function call(
    mutate: () => void,
    extra: Record<string, unknown> = {},
  ): Promise<{ markdown: string; data: BrokeData }> {
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true);
    mutate();
    const r = await callTool("what_broke", { org: fix.orgId, since: snap.id, ...extra });
    return { markdown: r.markdown, data: r.data as BrokeData };
  }

  // Batch R / S1: a removed member folds into its class by qname grammar
  // (it has no live containment edge left). The class still exists, so it
  // is changed, not removed.
  it("a removed method seed is listed as its class, changed and not removed", async () => {
    graph("v1");
    method("Target", "old(0)");
    e("ApexMethod:Caller.other(0)", "ApexMethod:Target.old(0)", REL_TYPES.CALLS);
    const { data } = await call(() => {
      fix.ctx.graphStore.deleteEdgesFor(fix.orgId, "ApexMethod:Target.old(0)" as never);
      fix.ctx.graphStore.deleteNode(fix.orgId, "ApexMethod:Target.old(0)" as never);
    });
    expect(data.removed).toEqual([]);
    expect(data.changed).toContain("ApexClass:Target");
    expect(data.changed).not.toContain("ApexMethod:Target.old(0)");
    expect(data.counts.removed).toBe(0);
  });

  it("the header prints the component counts of data.counts", async () => {
    graph("v1");
    const { markdown, data } = await call(() => {
      n("ApexClass:Target", undefined, undefined, "v2");
      n("ApexMethod:Target.run(0)", undefined, undefined, "v2");
    });
    expect(data.counts.changed).toBe(1);
    // Cycle 3 T3: the header opens Technical details.
    const lines = markdown.split("\n");
    expect(lines[lines.indexOf("**Technical details**") + 2]).toBe(
      "Changed: 1, added: 0, removed: 0; at risk: 4 (1 test class), covered: 1",
    );
  });

  it("test classes are not listed under 'At risk (no tests)'", async () => {
    graph("v1");
    // Over the mermaid cap, so the lists are printed.
    for (let i = 0; i < 110; i++) {
      n(`ApexClass:Fill${i}`);
      e(`ApexClass:Fill${i}`, "ApexMethod:Target.run(0)", REL_TYPES.CALLS);
    }
    const { markdown, data } = await call(
      () => {
        n("ApexClass:Target", undefined, undefined, "v2");
      },
      { limit: 500 },
    );
    expect(data.atRisk).toContain("ApexClass:CallerTest");
    const lines = markdown.split("\n");
    const risk = lines.indexOf("**At risk (no tests)**");
    const tests = lines.indexOf("**Test classes depending on a change**");
    expect(risk).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(risk);
    expect(lines.slice(risk, tests)).not.toContain("- ApexClass:CallerTest");
    expect(lines.slice(tests)).toContain("- ApexClass:CallerTest");
  });
});
