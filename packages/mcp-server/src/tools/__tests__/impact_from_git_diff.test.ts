import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

const DIFF = `diff --git a/force-app/main/default/classes/Foo.cls b/force-app/main/default/classes/Foo.cls
--- a/force-app/main/default/classes/Foo.cls
+++ b/force-app/main/default/classes/Foo.cls
@@ -1 +1 @@
-old
+new
`;

beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "ApexClass:Foo", label: "ApexClass" });
  fix.addNode({ qualifiedName: "ApexClass:Bar", label: "ApexClass" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Bar",
    dstQualifiedName: "ApexClass:Foo",
    relType: REL_TYPES.CALLS,
  });
});

afterEach(async () => {
  await fix.cleanup();
});

describe("impact_from_git_diff", () => {
  it("finds upstream dependents from diff", async () => {
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    const d = r.data as { impacted: string[] };
    expect(d.impacted).toContain("ApexClass:Bar");
  });

  it("includes seed in summary", async () => {
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    expect(r.summary).toMatch(/from 1 changed/);
  });

  it("rejects depth out of range", async () => {
    await expect(
      callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 99 }),
    ).rejects.toThrow();
  });

  it("rejects depth below minimum (0)", async () => {
    await expect(
      callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 0 }),
    ).rejects.toThrow();
  });

  it("rejects non-integer depth", async () => {
    await expect(
      callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 2.5 }),
    ).rejects.toThrow();
  });

  it("rejects empty diff", async () => {
    await expect(callTool("impact_from_git_diff", { org: fix.orgId, diff: "" })).rejects.toThrow();
  });

  it("rejects missing diff", async () => {
    await expect(callTool("impact_from_git_diff", { org: fix.orgId })).rejects.toThrow();
  });

  it("returns zero impacted when diff parses to no Salesforce paths", async () => {
    const nonSfDiff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: nonSfDiff });
    const d = r.data as { seedQnames: string[]; impacted: string[] };
    expect(d.seedQnames).toEqual([]);
    expect(d.impacted).toEqual([]);
  });

  it("returns the seed itself when the changed file has no dependents", async () => {
    const isolatedDiff = `diff --git a/force-app/main/default/classes/Bar.cls b/force-app/main/default/classes/Bar.cls
--- a/force-app/main/default/classes/Bar.cls
+++ b/force-app/main/default/classes/Bar.cls
@@ -1 +1 @@
-x
+y
`;
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: isolatedDiff });
    const d = r.data as { impacted: string[] };
    expect(d.impacted).toContain("ApexClass:Bar");
  });

  it("aggregates seeds across a multi-file diff", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Baz", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Baz",
      dstQualifiedName: "ApexClass:Foo",
      relType: REL_TYPES.CALLS,
    });
    const multi = `diff --git a/force-app/main/default/classes/Foo.cls b/force-app/main/default/classes/Foo.cls
--- a/force-app/main/default/classes/Foo.cls
+++ b/force-app/main/default/classes/Foo.cls
@@ -1 +1 @@
-a
+b
diff --git a/force-app/main/default/classes/Bar.cls b/force-app/main/default/classes/Bar.cls
--- a/force-app/main/default/classes/Bar.cls
+++ b/force-app/main/default/classes/Bar.cls
@@ -1 +1 @@
-x
+y
`;
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: multi });
    const d = r.data as { seedQnames: string[]; impacted: string[] };
    expect(d.seedQnames.length).toBe(2);
    expect(d.impacted).toContain("ApexClass:Baz");
    expect(r.summary).toMatch(/from 2 changed/);
  });

  it("respects custom depth=1 vs depth=3", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Baz", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Baz",
      dstQualifiedName: "ApexClass:Bar",
      relType: REL_TYPES.CALLS,
    });
    const r1 = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 1 });
    const r3 = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 3 });
    const d1 = r1.data as { impacted: string[] };
    const d3 = r3.data as { impacted: string[] };
    expect(d3.impacted.length).toBeGreaterThanOrEqual(d1.impacted.length);
  });
});
