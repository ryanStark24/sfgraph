import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// Batch Q2 carry-ins from the Q1 re-review: L1 (hasClass also sees an
// ApexInterface, any case) and L3 (one code-point order for pseudo lists).
let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

type Row = { qualifiedName: string };
type TraceData = { reached: Row[]; pseudo: Row[] };
type FlowData = { participants: Array<{ id: string }>; pseudo: Array<{ id: string }> };

function n(q: string): void {
  fix.addNode({ qualifiedName: q, label: q.slice(0, q.indexOf(":")) });
}
function e(src: string, dst: string, rel: string): void {
  fix.addEdge({ srcQualifiedName: src, dstQualifiedName: dst, relType: rel });
}

describe("L1: a user ApexInterface named like a platform type is not pseudo", () => {
  beforeEach(() => {
    n("ApexClass:Root");
    n("ApexMethod:Root.run(0)");
    // Stored lower-case: the lookup must not depend on case.
    n("ApexInterface:callable");
    e("ApexClass:Root", "ApexMethod:Root.run(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexMethod:Root.run(0)", "ApexMethod:Callable.call(2)", REL_TYPES.CALLS);
    e("ApexMethod:Callable.call(2)", "ApexMethod:Root.run(0)", REL_TYPES.CALLS);
    e("ApexMethod:Root.run(0)", "ApexMethod:System.debug(1)", REL_TYPES.CALLS);
  });

  it("trace_downstream keeps it", async () => {
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:Root",
      depth: 1,
    });
    const d = r.data as TraceData;
    expect(d.reached.map((x) => x.qualifiedName)).toContain("ApexMethod:Callable.call(2)");
    expect(d.pseudo.map((x) => x.qualifiedName)).toEqual(["ApexMethod:System.debug(1)"]);
  });

  it("trace_upstream keeps it", async () => {
    const r = await callTool("trace_upstream", {
      org: fix.orgId,
      qname: "ApexMethod:Root.run(0)",
      depth: 1,
    });
    const d = r.data as TraceData;
    expect(d.reached.map((x) => x.qualifiedName)).toContain("ApexMethod:Callable.call(2)");
    expect(d.pseudo).toEqual([]);
  });

  it("cross_layer_flow_map keeps it", async () => {
    const f = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Root" });
    const fd = f.data as FlowData;
    expect(fd.pseudo.map((p) => p.id)).toEqual(["ApexMethod:System.debug(1)"]);
  });
});

describe("L3: pseudo lists use code-point order", () => {
  beforeEach(() => {
    n("ApexClass:Root");
    n("ApexMethod:Root.run(0)");
    e("ApexClass:Root", "ApexMethod:Root.run(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexMethod:Root.run(0)", "ApexMethod:system.debug(1)", REL_TYPES.CALLS);
    e("ApexMethod:Root.run(0)", "ApexMethod:Test.startTest(0)", REL_TYPES.CALLS);
  });

  it("trace and flow map agree: upper-case before lower-case", async () => {
    const want = ["ApexMethod:Test.startTest(0)", "ApexMethod:system.debug(1)"];
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:Root",
      depth: 1,
    });
    expect((r.data as TraceData).pseudo.map((x) => x.qualifiedName)).toEqual(want);
    const f = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Root" });
    expect((f.data as FlowData).pseudo.map((p) => p.id)).toEqual(want);
  });
});
