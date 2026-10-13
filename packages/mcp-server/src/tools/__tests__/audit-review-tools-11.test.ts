import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit tools-11 hand-off: core traversals report `found: false` for a seed
 * that is neither a node nor an edge endpoint. The tools must say "node not
 * found" (with a find_nodes hint) instead of an empty success.
 */
let fix: Fixture;

const diffFor = (
  cls: string,
) => `diff --git a/force-app/main/default/classes/${cls}.cls b/force-app/main/default/classes/${cls}.cls
--- a/force-app/main/default/classes/${cls}.cls
+++ b/force-app/main/default/classes/${cls}.cls
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

describe("audit tools-11 hand-off: unknown seed is reported, not an empty success", () => {
  for (const tool of ["trace_upstream", "trace_downstream"]) {
    it(`${tool}: unknown qname -> node not found + find_nodes hint`, async () => {
      const r = await callTool(tool, { org: fix.orgId, qname: "ApexClass:Fooo" });
      expect(r.summary).toMatch(/node not found/i);
      expect(r.markdown).toMatch(/find_nodes/);
      expect(r.markdown).toMatch(/\*Fooo\*/);
      // Review N2: the direction word is interpolated, not a literal `$upstream`.
      const dir = tool === "trace_upstream" ? "upstream" : "downstream";
      expect(r.markdown).toContain(`nothing ${dir} of it`);
      expect(r.markdown).not.toContain("$");
      expect(r.follow_up_tools?.[0]).toBe("find_nodes");
      const d = r.data as { found: boolean; nodes: unknown[]; reached: unknown[] };
      expect(d.found).toBe(false);
      expect(d.nodes).toEqual([]);
      expect(d.reached).toEqual([]);
    });

    it(`${tool}: known qname -> found: true, normal summary`, async () => {
      const r = await callTool(tool, { org: fix.orgId, qname: "ApexClass:Foo" });
      expect(r.summary).not.toMatch(/not found/i);
      expect((r.data as { found: boolean }).found).toBe(true);
    });
  }

  it("impact_from_git_diff lists seeds missing from the graph in data.notFound", async () => {
    const r = await callTool("impact_from_git_diff", {
      org: fix.orgId,
      diff: `${diffFor("Foo")}${diffFor("Ghost")}`,
    });
    const d = r.data as { notFound: string[]; dependents: string[] };
    expect(d.notFound).toEqual(["ApexClass:Ghost"]);
    expect(d.dependents).toEqual(["ApexClass:Bar"]);
    expect(r.markdown).toMatch(/not in the graph/);
    expect(r.markdown).toMatch(/find_nodes/);
  });

  it("test_gap_intelligence_from_git_diff lists seeds missing from the graph", async () => {
    const r = await callTool("test_gap_intelligence_from_git_diff", {
      org: fix.orgId,
      diff: diffFor("Ghost"),
    });
    const d = r.data as { notFound: string[]; gaps: string[] };
    expect(d.notFound).toEqual(["ApexClass:Ghost"]);
    expect(d.gaps).toEqual([]);
    expect(r.summary).toMatch(/1 changed file not found/);
  });
});
