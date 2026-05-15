import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("dead_code_audit", () => {
  it("flags stale untouched class", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:Stale",
      label: "ApexClass",
      lastModifiedAt: Date.now() - 1000 * 60 * 60 * 24 * 1000,
    });
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect((r.data as { dead: string[] }).dead).toContain("ApexClass:Stale");
  });

  it("ignores stale class with incoming edges", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:Used",
      label: "ApexClass",
      lastModifiedAt: Date.now() - 1000 * 60 * 60 * 24 * 1000,
    });
    fix.addNode({ qualifiedName: "ApexClass:Caller", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Caller",
      dstQualifiedName: "ApexClass:Used",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect((r.data as { dead: string[] }).dead).not.toContain("ApexClass:Used");
  });

  it("returns empty dead list for empty graph", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    const d = r.data as { dead: unknown[] };
    expect(d.dead).toEqual([]);
    expect(r.markdown).toContain("no dead code detected");
  });

  it("does not flag recently-modified class even when isolated", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:JustWritten",
      label: "ApexClass",
      lastModifiedAt: Date.now(),
    });
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect((r.data as { dead: string[] }).dead).not.toContain("ApexClass:JustWritten");
  });

  it("rejects empty org", async () => {
    await expect(callTool("dead_code_audit", { org: "" })).rejects.toThrow();
  });

  it("reports cached=false when no cache table is present", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect((r.data as { cached: boolean }).cached).toBe(false);
  });

  it("handles many isolated stale nodes", async () => {
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 1000;
    for (let i = 0; i < 30; i++) {
      fix.addNode({
        qualifiedName: `ApexClass:Old${i}`,
        label: "ApexClass",
        lastModifiedAt: ancient,
      });
    }
    const r = await callTool("dead_code_audit", { org: fix.orgId });
    expect((r.data as { dead: string[] }).dead.length).toBeGreaterThanOrEqual(30);
  });
});
