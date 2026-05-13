import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

const DIFF = `--- a/force-app/main/default/classes/Target.cls
+++ b/force-app/main/default/classes/Target.cls
@@
`;

beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "ApexClass:Target", label: "ApexClass" });
  fix.addNode({ qualifiedName: "ApexClass:Caller", label: "ApexClass" });
  fix.addNode({ qualifiedName: "ApexClass:Untested", label: "ApexClass" });
  fix.addNode({ qualifiedName: "ApexClass:CallerTest", label: "ApexClass" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Caller",
    dstQualifiedName: "ApexClass:Target",
    relType: REL_TYPES.CALLS,
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Untested",
    dstQualifiedName: "ApexClass:Target",
    relType: REL_TYPES.CALLS,
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:CallerTest",
    dstQualifiedName: "ApexClass:Caller",
    relType: REL_TYPES.IS_TEST_FOR,
  });
});

afterEach(async () => {
  await fix.cleanup();
});

describe("test_gap_intelligence_from_git_diff", () => {
  it("finds Untested dependent", async () => {
    const r = await callTool("test_gap_intelligence_from_git_diff", {
      org: fix.orgId,
      diff: DIFF,
    });
    const d = r.data as { gaps: string[]; covered: string[] };
    expect(d.gaps).toContain("ApexClass:Untested");
    expect(d.covered).toContain("ApexClass:Caller");
  });

  it("markdown lists gaps", async () => {
    const r = await callTool("test_gap_intelligence_from_git_diff", {
      org: fix.orgId,
      diff: DIFF,
    });
    expect(r.markdown).toContain("Untested");
  });
});
