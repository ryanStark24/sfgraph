import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "LWC:myCmp", label: "LWC" });
  fix.addNode({ qualifiedName: "ApexClass:Ctrl", label: "ApexClass" });
  fix.addNode({ qualifiedName: "CustomField:Account.Name", label: "CustomField" });
  fix.addEdge({
    srcQualifiedName: "LWC:myCmp",
    dstQualifiedName: "ApexClass:Ctrl",
    relType: REL_TYPES.CALLS_APEX_FROM_LWC,
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Ctrl",
    dstQualifiedName: "CustomField:Account.Name",
    relType: REL_TYPES.READS_FIELD,
  });
});

afterEach(async () => {
  await fix.cleanup();
});

describe("cross_layer_flow_map", () => {
  it("produces sequenceDiagram", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" });
    expect(r.markdown).toContain("sequenceDiagram");
  });

  it("traces through 3 layers", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" });
    const d = r.data as { participants: unknown[] };
    expect(d.participants.length).toBeGreaterThanOrEqual(3);
  });

  it("returns single-participant diagram for unknown entry", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:ghost" });
    const d = r.data as { participants: Array<{ layer: string }> };
    expect(d.participants.length).toBe(1);
    expect(d.participants[0]?.layer).toBe("Entry");
  });

  it("handles isolated node with no outgoing edges", async () => {
    fix.addNode({ qualifiedName: "LWC:lonely", label: "LWC" });
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:lonely" });
    const d = r.data as { participants: unknown[]; messages: unknown[] };
    expect(d.participants.length).toBe(1);
    expect(d.messages.length).toBe(0);
  });

  it("does not loop forever on cycles", async () => {
    fix.addNode({ qualifiedName: "ApexClass:A1", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexClass:A2", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:A1",
      dstQualifiedName: "ApexClass:A2",
      relType: REL_TYPES.CALLS,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:A2",
      dstQualifiedName: "ApexClass:A1",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:A1" });
    const d = r.data as { participants: unknown[]; truncated: boolean };
    expect(d.participants.length).toBe(2);
    expect(d.truncated).toBe(false);
  });

  it("truncates and flags when exceeding NODE_CAP (100)", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Hub", label: "ApexClass" });
    for (let i = 0; i < 150; i++) {
      fix.addNode({ qualifiedName: `ApexClass:Leaf${i}`, label: "ApexClass" });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Hub",
        dstQualifiedName: `ApexClass:Leaf${i}`,
        relType: REL_TYPES.CALLS,
      });
    }
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Hub" });
    const d = r.data as { truncated: boolean };
    expect(d.truncated).toBe(true);
    expect(r.markdown).toContain("_truncated_");
  });

  it("rejects empty entry", async () => {
    await expect(callTool("cross_layer_flow_map", { org: fix.orgId, entry: "" })).rejects.toThrow();
  });

  it("traces a 4-layer LWC -> Apex -> Apex -> CustomField chain", async () => {
    fix.addNode({ qualifiedName: "LWC:deep", label: "LWC" });
    fix.addNode({ qualifiedName: "ApexClass:L1", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexClass:L2", label: "ApexClass" });
    fix.addNode({ qualifiedName: "CustomField:Account.X", label: "CustomField" });
    fix.addEdge({
      srcQualifiedName: "LWC:deep",
      dstQualifiedName: "ApexClass:L1",
      relType: REL_TYPES.CALLS_APEX_FROM_LWC,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:L1",
      dstQualifiedName: "ApexClass:L2",
      relType: REL_TYPES.CALLS,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:L2",
      dstQualifiedName: "CustomField:Account.X",
      relType: REL_TYPES.READS_FIELD,
    });
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:deep" });
    const d = r.data as { participants: Array<{ layer: string }> };
    const layers = new Set(d.participants.map((p) => p.layer));
    expect(layers.has("LWC")).toBe(true);
    expect(layers.has("Apex")).toBe(true);
    expect(layers.has("Field")).toBe(true);
  });
});
