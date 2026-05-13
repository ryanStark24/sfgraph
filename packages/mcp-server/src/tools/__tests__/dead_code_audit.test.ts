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
});
