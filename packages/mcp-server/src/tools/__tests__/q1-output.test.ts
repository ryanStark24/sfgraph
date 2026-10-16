import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// Batch Q1 (task 14): pseudo endpoints, root-member / entry roles, and the
// cross_layer_flow_map edge set.
let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

type Row = { qualifiedName: string; role?: string; pseudoKind?: string; hop: number };
type TraceData = { reached: Row[]; pseudo: Row[]; nodes: Array<{ qualifiedName: string }> };
type FlowData = {
  participants: Array<{ id: string; role?: string }>;
  messages: Array<{ fromId: string; toId: string; label: string }>;
  pseudo: Array<{ id: string; pseudoKind: string }>;
};

function n(q: string): void {
  fix.addNode({ qualifiedName: q, label: q.slice(0, q.indexOf(":")) });
}
function e(src: string, dst: string, rel: string, attributes?: Record<string, unknown>): void {
  fix.addEdge({
    srcQualifiedName: src,
    dstQualifiedName: dst,
    relType: rel,
    ...(attributes ? { attributes } : {}),
  });
}

describe("trace_downstream: pseudo endpoints and root members", () => {
  beforeEach(() => {
    for (const q of [
      "ApexClass:Root",
      "ApexMethod:Root.run(0)",
      "ApexClass:Svc",
      "ApexMethod:Svc.go(0)",
      "CustomObject:Obj__c",
    ]) {
      n(q);
    }
    e("ApexClass:Root", "ApexMethod:Root.run(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexClass:Svc", "ApexMethod:Svc.go(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexMethod:Root.run(0)", "ApexMethod:Svc.go(0)", REL_TYPES.CALLS);
    e("ApexMethod:Root.run(0)", "ApexMethod:System.debug(1)", REL_TYPES.CALLS);
    e("ApexMethod:Root.run(0)", "DML:update", REL_TYPES.EXECUTES_DML);
    e("ApexMethod:Root.run(0)", "CustomObject:Obj__c", REL_TYPES.EXECUTES_SOQL);
    e("ApexClass:Root", "Remote:Svc", REL_TYPES.REFERENCES);
  });

  it("moves stdlib, DML and duplicate Remote rows to data.pseudo", async () => {
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:Root",
      depth: 2,
    });
    const d = r.data as TraceData;
    const reached = d.reached.map((x) => x.qualifiedName);
    expect(reached).not.toContain("ApexMethod:System.debug(1)");
    expect(reached).not.toContain("DML:update");
    expect(reached).not.toContain("Remote:Svc");
    expect(d.pseudo.map((x) => [x.qualifiedName, x.pseudoKind]).sort()).toEqual([
      ["ApexMethod:System.debug(1)", "apex-platform"],
      ["DML:update", "dml"],
      ["Remote:Svc", "remote-duplicate"],
    ]);
    expect(r.markdown).toMatch(/pseudo endpoint/i);
  });

  it("marks the root's own methods role root-member and leaves them out of the count", async () => {
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:Root",
      depth: 1,
    });
    const d = r.data as TraceData;
    const root = d.reached.find((x) => x.qualifiedName === "ApexMethod:Root.run(0)");
    expect(root).toMatchObject({ role: "root-member", hop: 0 });
    const counted = d.reached.filter((x) => !x.role).length;
    expect(r.summary.startsWith(`${counted} downstream nodes`)).toBe(true);
    expect(r.markdown).toMatch(/root member/i);
    expect(d.reached.find((x) => x.qualifiedName === "CustomObject:Obj__c")?.hop).toBe(1);
  });
});

describe("trace_upstream: pseudo endpoints", () => {
  it("moves LWCProperty sources to data.pseudo", async () => {
    n("CustomField:A.F__c");
    e("LWCProperty:value", "CustomField:A.F__c", REL_TYPES.REFERENCES);
    e("LWC:c", "CustomField:A.F__c", REL_TYPES.LWC_BINDS_FIELD);
    const r = await callTool("trace_upstream", {
      org: fix.orgId,
      qname: "CustomField:A.F__c",
      depth: 1,
    });
    const d = r.data as TraceData;
    expect(d.reached.map((x) => x.qualifiedName)).toEqual(["LWC:c"]);
    expect(d.pseudo.map((x) => x.qualifiedName)).toEqual(["LWCProperty:value"]);
  });
});

describe("cross_layer_flow_map: edge set, roll-up, leaves, entry role", () => {
  beforeEach(() => {
    for (const q of [
      "LWC:entry",
      "ApexClass:Ctl",
      "ApexMethod:Ctl.get(0)",
      "ApexMethod:Ctl.save(1)",
      "ApexClass:Log",
      "ApexMethod:Log.write(1)",
      "CustomObject:Asset",
      "CustomField:Asset.Status__c",
      "CustomField:Asset.Formula__c",
      "CustomField:Asset.Base__c",
      "CustomObject:Log__c",
      "CustomField:Log__c.Msg__c",
      "LWC:other",
    ]) {
      n(q);
    }
    e("ApexClass:Ctl", "ApexMethod:Ctl.get(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexClass:Ctl", "ApexMethod:Ctl.save(1)", REL_TYPES.CONTAINS_METHOD);
    e("ApexClass:Log", "ApexMethod:Log.write(1)", REL_TYPES.CONTAINS_METHOD);
    e("LWC:entry", "ApexMethod:Ctl.get(0)", REL_TYPES.USES_WIRE);
    e("LWC:entry", "ApexMethod:Ctl.save(1)", REL_TYPES.IMPORTS_APEX);
    e("ApexMethod:Ctl.get(0)", "CustomObject:Asset", REL_TYPES.EXECUTES_SOQL);
    e("ApexMethod:Ctl.get(0)", "CustomField:Asset.Formula__c", REL_TYPES.READS_FIELD);
    e("CustomField:Asset.Formula__c", "CustomField:Asset.Base__c", REL_TYPES.READS_FIELD);
    e("ApexMethod:Ctl.save(1)", "CustomField:Asset.Status__c", REL_TYPES.WRITES_FIELD);
    e("ApexMethod:Ctl.save(1)", "ApexMethod:Log.write(1)", REL_TYPES.CALLS);
    e("ApexMethod:Ctl.save(1)", "ApexMethod:System.debug(1)", REL_TYPES.CALLS);
    e("ApexMethod:Log.write(1)", "CustomObject:Log__c", REL_TYPES.REFERENCES);
    e("ApexMethod:Log.write(1)", "CustomField:Log__c.Msg__c", REL_TYPES.WRITES_FIELD);
    e("ApexMethod:Log.write(1)", "LWC:other", REL_TYPES.REFERENCES);
  });

  it("follows USES_WIRE / IMPORTS_APEX / WRITES_FIELD / REFERENCES-to-object and rolls methods up", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:entry" });
    const d = r.data as FlowData;
    const ids = d.participants.map((p) => p.id).sort();
    expect(ids).toEqual(
      [
        "LWC:entry",
        "ApexClass:Ctl",
        "ApexClass:Log",
        "CustomObject:Asset",
        "CustomField:Asset.Formula__c",
        "CustomField:Asset.Status__c",
        "CustomObject:Log__c",
        "CustomField:Log__c.Msg__c",
      ].sort(),
    );
    // fields are leaves (no Formula__c -> Base__c), REFERENCES only to objects
    expect(ids).not.toContain("CustomField:Asset.Base__c");
    expect(ids).not.toContain("LWC:other");
    expect(d.messages.some((m) => m.fromId === "ApexClass:Ctl" && m.toId === "ApexClass:Log")).toBe(
      true,
    );
  });

  it("marks the entry role entry and does not count it; platform calls go to pseudo", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:entry" });
    const d = r.data as FlowData;
    expect(d.participants[0]).toMatchObject({ id: "LWC:entry", role: "entry" });
    expect(d.participants.filter((p) => p.role === "entry")).toHaveLength(1);
    expect(r.summary.startsWith(`${d.participants.length - 1} participants`)).toBe(true);
    expect(d.pseudo).toEqual([{ id: "ApexMethod:System.debug(1)", pseudoKind: "apex-platform" }]);
    expect(d.participants.map((p) => p.id)).not.toContain("ApexMethod:System.debug(1)");
  });

  it("enters a Flow through its FlowVersion (FLOW_INVOKES_APEX_METHOD) without listing it", async () => {
    n("Flow:F");
    n("FlowVersion:F.v2");
    e("Flow:F", "FlowVersion:F.v2", REL_TYPES.CONTAINS);
    e("FlowVersion:F.v2", "ApexMethod:Ctl.get(0)", REL_TYPES.FLOW_INVOKES_APEX_METHOD);
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "Flow:F" });
    const ids = (r.data as FlowData).participants.map((p) => p.id);
    expect(ids).toContain("ApexClass:Ctl");
    expect(ids).toContain("CustomObject:Asset");
    expect(ids).not.toContain("FlowVersion:F.v2");
  });

  it("follows an ApexPage's CONTROLLED_BY controller into its methods", async () => {
    n("ApexPage:P");
    e("ApexPage:P", "ApexClass:Log", REL_TYPES.CONTROLLED_BY);
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexPage:P" });
    const ids = (r.data as FlowData).participants.map((p) => p.id);
    expect(ids).toContain("ApexClass:Log");
    expect(ids).toContain("CustomField:Log__c.Msg__c");
  });
});

// Fix round 1 (review-t14-batchQ1).
describe("fix round 1: tool wiring", () => {
  it("I4: a 120-method controller does not trip the flow-map node cap", async () => {
    n("ApexPage:big");
    n("ApexClass:Big");
    n("CustomObject:Acct");
    for (let i = 0; i < 120; i++) {
      n(`ApexMethod:Big.m${i}(0)`);
      e("ApexClass:Big", `ApexMethod:Big.m${i}(0)`, REL_TYPES.CONTAINS_METHOD);
    }
    e("ApexPage:big", "ApexClass:Big", REL_TYPES.CONTROLLED_BY);
    e("ApexMethod:Big.m119(0)", "CustomObject:Acct", REL_TYPES.EXECUTES_SOQL);
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexPage:big" });
    const d = r.data as FlowData & { truncated: boolean };
    expect(d.participants.map((p) => p.id)).toEqual([
      "ApexPage:big",
      "ApexClass:Big",
      "CustomObject:Acct",
    ]);
    expect(d.truncated).toBe(false);
  });

  it("M7: a FlowVersion entry is drawn as its Flow with the Flow layer", async () => {
    n("Flow:F");
    n("FlowVersion:F.v2");
    n("ApexClass:A");
    n("ApexMethod:A.go(0)");
    e("Flow:F", "FlowVersion:F.v2", REL_TYPES.CONTAINS);
    e("ApexClass:A", "ApexMethod:A.go(0)", REL_TYPES.CONTAINS_METHOD);
    e("FlowVersion:F.v2", "ApexMethod:A.go(0)", REL_TYPES.FLOW_INVOKES_APEX_METHOD);
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "FlowVersion:F.v2" });
    const d = r.data as { participants: Array<{ id: string; layer: string; role?: string }> };
    expect(d.participants[0]).toMatchObject({ id: "Flow:F", layer: "Flow", role: "entry" });
  });

  it("M1: a call into a user class named like a platform namespace is not pseudo", async () => {
    n("ApexClass:Root");
    n("ApexMethod:Root.run(0)");
    n("ApexClass:Security");
    e("ApexClass:Root", "ApexMethod:Root.run(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexMethod:Root.run(0)", "ApexMethod:Security.check(2)", REL_TYPES.CALLS);
    e("ApexMethod:Root.run(0)", "ApexMethod:System.debug(1)", REL_TYPES.CALLS);
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:Root",
      depth: 2,
    });
    const d = r.data as TraceData;
    expect(d.pseudo.map((x) => x.qualifiedName)).toEqual(["ApexMethod:System.debug(1)"]);
    expect(d.reached.map((x) => x.qualifiedName)).toContain("ApexMethod:Security.check(2)");
    const f = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Root" });
    const fd = f.data as FlowData;
    expect(fd.pseudo.map((p) => p.id)).toEqual(["ApexMethod:System.debug(1)"]);
  });

  it("M2: Remote:<root> is a remote-duplicate pseudo endpoint in a trace", async () => {
    n("ApexClass:Root");
    n("ApexClass:Other");
    e("ApexClass:Root", "Remote:Root", REL_TYPES.REFERENCES);
    e("ApexClass:Root", "ApexClass:Other", REL_TYPES.REFERENCES);
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:Root",
      depth: 1,
    });
    const d = r.data as TraceData;
    expect(d.reached.map((x) => x.qualifiedName)).toEqual(["ApexClass:Other"]);
    expect(d.pseudo.map((x) => x.qualifiedName)).toEqual(["Remote:Root"]);
  });

  it("I5c: trace_upstream mermaid draws a folded FlowVersion edge from its Flow", async () => {
    n("Flow:F");
    n("FlowVersion:F.v2");
    n("ApexClass:X");
    n("ApexMethod:X.m(0)");
    n("LWC:card");
    e("Flow:F", "FlowVersion:F.v2", REL_TYPES.CONTAINS);
    e("ApexClass:X", "ApexMethod:X.m(0)", REL_TYPES.CONTAINS_METHOD);
    e("FlowVersion:F.v2", "ApexMethod:X.m(0)", REL_TYPES.FLOW_INVOKES_APEX_METHOD);
    // A screen-layer caller too, so the picture rule draws the Picture (cycle 3 T3 fix round 1).
    e("LWC:card", "ApexMethod:X.m(0)", REL_TYPES.CALLS_APEX_FROM_LWC);
    const r = await callTool("trace_upstream", {
      org: fix.orgId,
      qname: "ApexMethod:X.m(0)",
      depth: 2,
      mermaid: true,
    });
    // Cycle 3 T3: the core diagram became the report Picture.
    const pic = r.markdown.slice(
      r.markdown.indexOf("```mermaid"),
      r.markdown.indexOf("**Technical details**"),
    );
    const id = (text: string) =>
      new RegExp(`(n\\d+)\\["${text.replace(/[()]/g, "\\$&")}"\\]`).exec(pic)?.[1];
    const flow = id("Flow: F");
    const cls = id("Apex method: X.m(0)");
    expect(flow).toBeDefined();
    expect(cls).toBeDefined();
    expect(pic).toMatch(new RegExp(`${flow} -->\\|runs the Apex method\\| ${cls}`));
    expect(pic).not.toContain("Flow version");
    // The folded row stays in Technical details.
    expect(r.markdown).toMatch(/Flow:F \(\+FlowVersion:F\.v2\).*FLOW_INVOKES_APEX_METHOD/);
  });
});
