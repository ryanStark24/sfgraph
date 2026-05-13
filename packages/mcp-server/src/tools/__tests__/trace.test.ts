import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "ApexClass:A", label: "ApexClass" });
  fix.addNode({ qualifiedName: "ApexClass:B", label: "ApexClass" });
  fix.addNode({ qualifiedName: "ApexClass:C", label: "ApexClass" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:A",
    dstQualifiedName: "ApexClass:B",
    relType: REL_TYPES.CALLS,
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:B",
    dstQualifiedName: "ApexClass:C",
    relType: REL_TYPES.CALLS,
  });
});

afterEach(async () => {
  await fix.cleanup();
});

describe("trace_upstream / trace_downstream", () => {
  it("upstream finds A from C", async () => {
    const r = await callTool("trace_upstream", { org: fix.orgId, qname: "ApexClass:C" });
    const d = r.data as { nodes: Array<{ qualifiedName: string }> };
    expect(d.nodes.map((n) => n.qualifiedName)).toContain("ApexClass:A");
  });

  it("downstream finds C from A", async () => {
    const r = await callTool("trace_downstream", { org: fix.orgId, qname: "ApexClass:A" });
    const d = r.data as { nodes: Array<{ qualifiedName: string }> };
    expect(d.nodes.map((n) => n.qualifiedName)).toContain("ApexClass:C");
  });
});
