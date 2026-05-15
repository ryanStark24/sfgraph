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

  it("upstream returns empty nodes for unknown qname", async () => {
    const r = await callTool("trace_upstream", { org: fix.orgId, qname: "ApexClass:Phantom" });
    const d = r.data as { nodes: unknown[] };
    expect(d.nodes).toEqual([]);
  });

  it("downstream returns empty nodes for isolated node", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Island", label: "ApexClass" });
    const r = await callTool("trace_downstream", { org: fix.orgId, qname: "ApexClass:Island" });
    const d = r.data as { nodes: unknown[] };
    expect(d.nodes).toEqual([]);
  });

  it("respects depth=1 (only direct neighbor)", async () => {
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:A",
      depth: 1,
    });
    const d = r.data as { nodes: Array<{ qualifiedName: string }> };
    const names = d.nodes.map((n) => n.qualifiedName);
    expect(names).toContain("ApexClass:B");
    expect(names).not.toContain("ApexClass:C");
  });

  it("does not loop forever on cycles (upstream)", async () => {
    fix.addEdge({
      srcQualifiedName: "ApexClass:C",
      dstQualifiedName: "ApexClass:A",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("trace_upstream", {
      org: fix.orgId,
      qname: "ApexClass:A",
      depth: 5,
    });
    const d = r.data as { nodes: Array<{ qualifiedName: string }> };
    const seen = new Set(d.nodes.map((n) => n.qualifiedName));
    expect(seen.size).toBe(d.nodes.length);
  });

  it("rejects upstream depth>5", async () => {
    await expect(
      callTool("trace_upstream", { org: fix.orgId, qname: "ApexClass:A", depth: 99 }),
    ).rejects.toThrow();
  });

  it("rejects downstream depth=0", async () => {
    await expect(
      callTool("trace_downstream", { org: fix.orgId, qname: "ApexClass:A", depth: 0 }),
    ).rejects.toThrow();
  });

  it("rejects empty qname for upstream", async () => {
    await expect(callTool("trace_upstream", { org: fix.orgId, qname: "" })).rejects.toThrow();
  });

  it("rejects missing qname for downstream", async () => {
    await expect(callTool("trace_downstream", { org: fix.orgId })).rejects.toThrow();
  });

  it("walks a 5-hop deep chain end-to-end at depth=5", async () => {
    for (const q of ["ApexClass:D", "ApexClass:E", "ApexClass:F"]) {
      fix.addNode({ qualifiedName: q, label: "ApexClass" });
    }
    fix.addEdge({
      srcQualifiedName: "ApexClass:C",
      dstQualifiedName: "ApexClass:D",
      relType: REL_TYPES.CALLS,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:D",
      dstQualifiedName: "ApexClass:E",
      relType: REL_TYPES.CALLS,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:E",
      dstQualifiedName: "ApexClass:F",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:A",
      depth: 5,
    });
    const names = (r.data as { nodes: Array<{ qualifiedName: string }> }).nodes.map(
      (n) => n.qualifiedName,
    );
    expect(names).toContain("ApexClass:F");
  });

  it("handles wide fan-out (1 source -> 50 children)", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Hub", label: "ApexClass" });
    for (let i = 0; i < 50; i++) {
      fix.addNode({ qualifiedName: `ApexClass:Leaf${i}`, label: "ApexClass" });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Hub",
        dstQualifiedName: `ApexClass:Leaf${i}`,
        relType: REL_TYPES.CALLS,
      });
    }
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:Hub",
      depth: 1,
    });
    const d = r.data as { nodes: Array<{ qualifiedName: string }> };
    expect(d.nodes.length).toBeGreaterThanOrEqual(50);
  });
});
