import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// T15 query I-4: impact_from_git_diff seeds the changed method when the
// hunks identify it, and reports what it cannot map instead of dropping it.

let fix: Fixture;
const CLS = "force-app/main/default/classes/Svc.cls";
const diffOf = (hunk: string) =>
  `diff --git a/${CLS} b/${CLS}\nindex 1..2 100644\n--- a/${CLS}\n+++ b/${CLS}\n${hunk}\n`;

beforeEach(async () => {
  fix = await createFixture();
  const add = (q: string) => fix.addNode({ qualifiedName: q, label: q.slice(0, q.indexOf(":")) });
  const e = (s: string, r: string, d: string) =>
    fix.addEdge({ srcQualifiedName: s, dstQualifiedName: d, relType: r });
  for (const q of ["ApexClass:Svc", "ApexMethod:Svc.a(0)", "ApexMethod:Svc.b(0)"]) add(q);
  for (const q of ["ApexClass:CallsA", "ApexClass:CallsB", "ApexClass:UsesClass"]) add(q);
  e("ApexClass:Svc", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Svc.a(0)");
  e("ApexClass:Svc", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Svc.b(0)");
  e("ApexClass:CallsA", REL_TYPES.CALLS, "ApexMethod:Svc.a(0)");
  e("ApexClass:CallsB", REL_TYPES.CALLS, "ApexMethod:Svc.b(0)");
  e("ApexClass:UsesClass", REL_TYPES.REFERENCES, "ApexClass:Svc");
  const body = (q: string, text: string) =>
    fix.ctx.graphStore.upsertSnippet({
      orgId: fix.orgId,
      qualifiedName: asQualifiedName(q),
      sourceFormat: "apex" as never,
      sourceText: text,
      sourceHash: asSha256(`s-${q}`),
    });
  body("ApexMethod:Svc.a(0)", "public static void a() {\n    Integer alpha = 1;\n  }");
  body("ApexMethod:Svc.b(0)", "public static void b() {\n    Integer beta = 2;\n  }");
});
afterEach(async () => {
  await fix.cleanup();
});

type Data = {
  seedQnames: string[];
  changed: string[];
  changedMembers: string[];
  impacted: string[];
  unmapped: Array<{ path: string; reason: string }>;
};

describe("T15 I-4 impact_from_git_diff", () => {
  it("a change inside one method seeds that method: its callers, not its siblings'", async () => {
    const r = await callTool("impact_from_git_diff", {
      org: fix.orgId,
      diff: diffOf("@@ -2,1 +2,1 @@\n-    Integer alpha = 1;\n+    Integer alpha = 3;"),
    });
    const d = r.data as Data;
    expect(d.changedMembers).toEqual(["ApexMethod:Svc.a(0)"]);
    expect(d.changed).toEqual(["ApexClass:Svc"]);
    expect(d.impacted).toEqual(
      expect.arrayContaining(["ApexClass:Svc", "ApexClass:CallsA", "ApexClass:UsesClass"]),
    );
    expect(d.impacted).not.toContain("ApexClass:CallsB");
  });

  it("an unidentifiable line falls back to the class (every method's callers)", async () => {
    const r = await callTool("impact_from_git_diff", {
      org: fix.orgId,
      diff: diffOf(
        "@@ -1,1 +1,1 @@\n-  private static Integer counter = 0;\n+  private static Integer counter = 1;",
      ),
    });
    const d = r.data as Data;
    expect(d.changedMembers).toEqual([]);
    expect(d.seedQnames).toEqual(["ApexClass:Svc"]);
    expect(d.impacted).toEqual(expect.arrayContaining(["ApexClass:CallsA", "ApexClass:CallsB"]));
  });

  it("binary and unknown paths are listed in data.unmapped and the markdown", async () => {
    const diff = [
      "diff --git a/force-app/main/default/staticresources/x.zip b/force-app/main/default/staticresources/x.zip",
      "Binary files a/force-app/main/default/staticresources/x.zip and b/force-app/main/default/staticresources/x.zip differ",
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b",
    ].join("\n");
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff });
    const d = r.data as Data;
    expect(d.unmapped).toEqual([
      { path: "force-app/main/default/staticresources/x.zip", reason: "binary" },
      { path: "README.md", reason: "no-qname" },
    ]);
    expect(r.markdown).toContain("README.md");
    expect(r.summary).toMatch(/2 unmapped/);
  });
});

describe("T15 I-4 test_gap_intelligence_from_git_diff", () => {
  it("reports unmapped paths too", async () => {
    const diff =
      "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b";
    const r = await callTool("test_gap_intelligence_from_git_diff", { org: fix.orgId, diff });
    expect((r.data as Data).unmapped).toEqual([{ path: "README.md", reason: "no-qname" }]);
  });
});
