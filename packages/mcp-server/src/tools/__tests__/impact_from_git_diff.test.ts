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
});
