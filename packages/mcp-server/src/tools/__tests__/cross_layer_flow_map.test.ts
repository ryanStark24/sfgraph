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
});
