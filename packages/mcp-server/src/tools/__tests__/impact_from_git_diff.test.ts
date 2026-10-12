import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool, defaultRegistry } from "./_runner.js";

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

// Cycle 2 T3 fix 1 (M-5): an unchanged containment parent (the object of a changed field) is not
// itself impacted, unless it also depends on the change through a non-containment edge.
describe("impact_from_git_diff containment parents (cycle 2 T3 fix 1)", () => {
  const FIELD_DIFF = `diff --git a/force-app/main/default/objects/Cfg__mdt/fields/Map__c.field-meta.xml b/force-app/main/default/objects/Cfg__mdt/fields/Map__c.field-meta.xml
--- a/force-app/main/default/objects/Cfg__mdt/fields/Map__c.field-meta.xml
+++ b/force-app/main/default/objects/Cfg__mdt/fields/Map__c.field-meta.xml
@@ -1 +1 @@
-<label>a</label>
+<label>b</label>
`;
  const seedField = (): void => {
    fix.addNode({ qualifiedName: "CustomObject:Cfg__mdt", label: "CustomObject" });
    fix.addNode({ qualifiedName: "CustomField:Cfg__mdt.Map__c", label: "CustomField" });
    fix.addNode({ qualifiedName: "ApexClass:Reader", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "CustomObject:Cfg__mdt",
      dstQualifiedName: "CustomField:Cfg__mdt.Map__c",
      relType: REL_TYPES.DEFINES_FIELD,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Reader",
      dstQualifiedName: "CustomField:Cfg__mdt.Map__c",
      relType: REL_TYPES.READS_FIELD,
    });
  };

  it("does not list the object of a changed field as impacted", async () => {
    seedField();
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: FIELD_DIFF });
    const d = r.data as { impacted: string[] };
    expect(d.impacted).toContain("CustomField:Cfg__mdt.Map__c");
    expect(d.impacted).toContain("ApexClass:Reader");
    expect(d.impacted).not.toContain("CustomObject:Cfg__mdt");
  });

  it("keeps the object when it also depends on the change through a non-containment edge", async () => {
    seedField();
    fix.addEdge({
      srcQualifiedName: "CustomObject:Cfg__mdt",
      dstQualifiedName: "CustomField:Cfg__mdt.Map__c",
      relType: REL_TYPES.REFERENCES,
    });
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: FIELD_DIFF });
    expect((r.data as { impacted: string[] }).impacted).toContain("CustomObject:Cfg__mdt");
  });
});

// Cycle 2 T3 fix 1 (ruling, round 3): dependents hop at component (class) level, as wip_impact does:
// a reached method's class counts as reached, so callers of its sibling methods are the next hop.
describe("impact_from_git_diff component-level hops (cycle 2 T3 fix 1)", () => {
  it("a caller of a sibling method of a reached class is a hop-2 dependent", async () => {
    for (const q of [
      "ApexClass:Mid",
      "ApexMethod:Mid.uses(0)",
      "ApexMethod:Mid.other(0)",
      "ApexClass:Far",
    ])
      fix.addNode({ qualifiedName: q, label: q.slice(0, q.indexOf(":")) });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Mid",
      dstQualifiedName: "ApexMethod:Mid.uses(0)",
      relType: REL_TYPES.CONTAINS_METHOD,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Mid",
      dstQualifiedName: "ApexMethod:Mid.other(0)",
      relType: REL_TYPES.CONTAINS_METHOD,
    });
    fix.addEdge({
      srcQualifiedName: "ApexMethod:Mid.uses(0)",
      dstQualifiedName: "ApexClass:Foo",
      relType: REL_TYPES.CALLS,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Far",
      dstQualifiedName: "ApexMethod:Mid.other(0)",
      relType: REL_TYPES.CALLS,
    });
    const r2 = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 2 });
    const r1 = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 1 });
    expect((r2.data as { impacted: string[] }).impacted).toContain("ApexClass:Far");
    expect((r1.data as { impacted: string[] }).impacted).not.toContain("ApexClass:Far");
  });
});

describe("impact_from_git_diff hub class under component-level hops (cycle 2 T3 fix 2)", () => {
  const METHODS = 30;
  const CALLERS_PER_METHOD = 10;
  // Util is a widely used utility class: one of its methods calls the changed Foo, and each of its
  // METHODS methods has CALLERS_PER_METHOD distinct caller classes.
  function addHub() {
    fix.addNode({ qualifiedName: "ApexClass:Util", label: "ApexClass" });
    for (let m = 0; m < METHODS; m++) {
      const method = `ApexMethod:Util.m${m}(0)`;
      fix.addNode({ qualifiedName: method, label: "ApexMethod" });
      fix.addEdge({ srcQualifiedName: "ApexClass:Util", dstQualifiedName: method, relType: REL_TYPES.CONTAINS_METHOD });
      for (let c = 0; c < CALLERS_PER_METHOD; c++) {
        const caller = `ApexClass:Caller_${m}_${c}`;
        fix.addNode({ qualifiedName: caller, label: "ApexClass" });
        fix.addEdge({ srcQualifiedName: caller, dstQualifiedName: method, relType: REL_TYPES.CALLS });
      }
    }
    fix.addEdge({ srcQualifiedName: "ApexMethod:Util.m0(0)", dstQualifiedName: "ApexClass:Foo", relType: REL_TYPES.CALLS });
  }

  it("stays bounded by the hub's real callers at depth 2", async () => {
    addHub();
    const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 2 });
    const data = r.data as { impacted: string[]; truncated: boolean };
    expect(data.truncated).toBe(false);
    // Foo, Bar, Util.m0 (hop 1) and its class Util; hop 2 reaches the callers of every Util method.
    const callers = data.impacted.filter((q) => q.startsWith("ApexClass:Caller_"));
    expect(callers).toHaveLength(METHODS * CALLERS_PER_METHOD);
    // Nothing beyond Foo, Bar, Util, Util's methods and their callers.
    expect(data.impacted.length).toBeLessThanOrEqual(3 + METHODS + METHODS * CALLERS_PER_METHOD);
    expect(new Set(data.impacted).size).toBe(data.impacted.length);
  });

  it("reports truncation when the hub blows the traversal node cap", async () => {
    addHub();
    const prev = process.env.SFGRAPH_TRAVERSAL_NODE_CAP;
    process.env.SFGRAPH_TRAVERSAL_NODE_CAP = "50";
    try {
      const r = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF, depth: 2 });
      const data = r.data as { impacted: string[]; truncated: boolean };
      expect(data.truncated).toBe(true);
      expect(r.summary).toContain("(truncated)");
      expect(r.markdown).toContain("_truncated_");
      expect(data.impacted.length).toBeLessThanOrEqual(60);
    } finally {
      if (prev === undefined) delete process.env.SFGRAPH_TRAVERSAL_NODE_CAP;
      else process.env.SFGRAPH_TRAVERSAL_NODE_CAP = prev;
    }
  });
});

// Cycle 3 T5: the rule moved from the description into the result text. Fix 1 (I1): each note
// shows only when it applies.
describe("impact_from_git_diff notes in the result (cycle 3 T5)", () => {
  const APEX =
    "A changed Apex class counts only the methods its changed lines touch, when they can be found; otherwise the whole class.";
  const USES =
    "What the changed files themselves use is not counted as impact; run `trace_downstream` for that.";
  const CONTAIN =
    "An unchanged containing object of a changed or dependent member is not listed, unless it is reached through a non-containment edge.";
  const FIELD_DIFF = `diff --git a/force-app/main/default/objects/Cfg__mdt/fields/Map__c.field-meta.xml b/force-app/main/default/objects/Cfg__mdt/fields/Map__c.field-meta.xml
--- a/force-app/main/default/objects/Cfg__mdt/fields/Map__c.field-meta.xml
+++ b/force-app/main/default/objects/Cfg__mdt/fields/Map__c.field-meta.xml
@@ -1 +1 @@
-<label>a</label>
+<label>b</label>
`;
  const seedField = (): void => {
    fix.addNode({ qualifiedName: "CustomObject:Cfg__mdt", label: "CustomObject" });
    fix.addNode({ qualifiedName: "CustomField:Cfg__mdt.Map__c", label: "CustomField" });
    fix.addEdge({
      srcQualifiedName: "CustomObject:Cfg__mdt",
      dstQualifiedName: "CustomField:Cfg__mdt.Map__c",
      relType: REL_TYPES.DEFINES_FIELD,
    });
  };

  it("the Apex note shows when an Apex class changed, and not otherwise", async () => {
    const apex = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    expect(apex.markdown).toContain(APEX);
    seedField();
    const field = await callTool("impact_from_git_diff", { org: fix.orgId, diff: FIELD_DIFF });
    expect(field.markdown).not.toContain(APEX);
  });

  it("the uses note shows when the changed files use something, and not otherwise", async () => {
    const none = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    expect(none.markdown).not.toContain(USES);
    fix.addNode({ qualifiedName: "ApexClass:Baz", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Foo",
      dstQualifiedName: "ApexClass:Baz",
      relType: REL_TYPES.CALLS,
    });
    const uses = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    expect(uses.markdown).toContain(USES);
  });

  it("the containment note shows when a containing object was left out, and not otherwise", async () => {
    const apex = await callTool("impact_from_git_diff", { org: fix.orgId, diff: DIFF });
    expect(apex.markdown).not.toContain(CONTAIN);
    seedField();
    const field = await callTool("impact_from_git_diff", { org: fix.orgId, diff: FIELD_DIFF });
    expect((field.data as { impacted: string[] }).impacted).not.toContain("CustomObject:Cfg__mdt");
    expect(field.markdown).toContain(CONTAIN);
    expect(field.markdown).not.toContain("The unchanged containment parent of a changed member");
    const d = defaultRegistry.get("impact_from_git_diff")?.schema.description ?? "";
    expect(d).not.toMatch(/containing object/);
  });
});
