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

type Data = {
  nodes: Array<{ qualifiedName: string }>;
  reached: Array<{ qualifiedName: string; hop: number; relType: string; hasNode: boolean }>;
};
const names = (r: { data?: unknown }): string[] =>
  (r.data as Data).reached.map((e) => e.qualifiedName);

/** IP -> DR -> object with 50 fields, VR and formula field. */
function objectFixture(): void {
  fix.addNode({ qualifiedName: "IntegrationProcedure:Proc_One", label: "IntegrationProcedure" });
  fix.addNode({ qualifiedName: "DataRaptor:Writer", label: "DataRaptor" });
  fix.addNode({ qualifiedName: "CustomObject:Big__c", label: "CustomObject" });
  fix.addNode({ qualifiedName: "ValidationRule:Big__c.VR1", label: "ValidationRule" });
  fix.addEdge({
    srcQualifiedName: "IntegrationProcedure:Proc_One",
    dstQualifiedName: "DataRaptor:Writer",
    relType: REL_TYPES.IP_CALLS_DR,
  });
  fix.addEdge({
    srcQualifiedName: "DataRaptor:Writer",
    dstQualifiedName: "CustomObject:Big__c",
    relType: REL_TYPES.REFERENCES_OBJECT,
  });
  fix.addEdge({
    srcQualifiedName: "CustomObject:Big__c",
    dstQualifiedName: "ValidationRule:Big__c.VR1",
    relType: REL_TYPES.HAS_VALIDATION_RULE,
  });
  for (let i = 0; i < 50; i++) {
    const f = `CustomField:Big__c.F${i}__c`;
    fix.addNode({ qualifiedName: f, label: "CustomField" });
    fix.addEdge({
      srcQualifiedName: "CustomObject:Big__c",
      dstQualifiedName: f,
      relType: REL_TYPES.DEFINES_FIELD,
    });
  }
  fix.addNode({ qualifiedName: "CustomField:Other.Status", label: "CustomField" });
  fix.addEdge({
    srcQualifiedName: "DataRaptor:Writer",
    dstQualifiedName: "CustomField:Big__c.F1__c",
    relType: REL_TYPES.DR_WRITES_FIELD,
  });
  fix.addEdge({
    srcQualifiedName: "CustomField:Big__c.F1__c",
    dstQualifiedName: "CustomField:Other.Status",
    relType: REL_TYPES.READS_FIELD,
  });
}

describe("trace_downstream: containment is not a dependency", () => {
  it("does not expand a reached object's fields or a formula field by default", async () => {
    objectFixture();
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "IntegrationProcedure:Proc_One",
      depth: 4,
    });
    expect(names(r).sort()).toEqual([
      "CustomField:Big__c.F1__c",
      "CustomObject:Big__c",
      "DataRaptor:Writer",
    ]);
    expect(r.markdown).toContain("include_structure");
  });

  it("include_structure:true restores the expansion", async () => {
    objectFixture();
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "IntegrationProcedure:Proc_One",
      depth: 4,
      include_structure: true,
    });
    const n = names(r);
    expect(n).toContain("CustomField:Big__c.F49__c");
    expect(n).toContain("ValidationRule:Big__c.VR1");
    expect(n).toContain("CustomField:Other.Status");
  });

  it("rolls an imported ApexMethod up to its class and the class's other methods", async () => {
    fix.addNode({ qualifiedName: "LWC:cmp", label: "LWC" });
    fix.addNode({ qualifiedName: "ApexClass:Ctl", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexMethod:Ctl.m1(0)", label: "ApexMethod" });
    fix.addNode({ qualifiedName: "ApexMethod:Ctl.m2(0)", label: "ApexMethod" });
    fix.addNode({ qualifiedName: "CustomField:Obj__c.F__c", label: "CustomField" });
    for (const [s, d, rel] of [
      ["LWC:cmp", "ApexMethod:Ctl.m1(0)", REL_TYPES.IMPORTS_APEX],
      ["ApexClass:Ctl", "ApexMethod:Ctl.m1(0)", REL_TYPES.CONTAINS_METHOD],
      ["ApexClass:Ctl", "ApexMethod:Ctl.m2(0)", REL_TYPES.CONTAINS_METHOD],
      ["ApexMethod:Ctl.m2(0)", "CustomField:Obj__c.F__c", REL_TYPES.READS_FIELD],
    ] as const) {
      fix.addEdge({ srcQualifiedName: s, dstQualifiedName: d, relType: rel });
    }
    const r = await callTool("trace_downstream", { org: fix.orgId, qname: "LWC:cmp", depth: 2 });
    expect(names(r)).toContain("ApexClass:Ctl");
    expect(names(r)).toContain("CustomField:Obj__c.F__c");
  });

  it("upstream lists the defining object as a leaf; include_structure expands it", async () => {
    objectFixture();
    const r = await callTool("trace_upstream", {
      org: fix.orgId,
      qname: "CustomField:Big__c.F7__c",
      depth: 3,
    });
    const n = (r.data as Data).nodes.map((x) => x.qualifiedName);
    expect(n).toEqual(["CustomObject:Big__c"]);
    const full = await callTool("trace_upstream", {
      org: fix.orgId,
      qname: "CustomField:Big__c.F7__c",
      depth: 3,
      include_structure: true,
    });
    const m = (full.data as Data).nodes.map((x) => x.qualifiedName);
    expect(m).toContain("DataRaptor:Writer");
    expect(m).toContain("IntegrationProcedure:Proc_One");
  });
});

describe("trace_* plain-list output", () => {
  it("lists full qnames grouped by label with hop and rel, and a count header", async () => {
    objectFixture();
    const longName = "CustomField:Big__c.A_Very_Long_Field_Name_That_Exceeds_Thirty__c";
    fix.addNode({ qualifiedName: longName, label: "CustomField" });
    fix.addEdge({
      srcQualifiedName: "DataRaptor:Writer",
      dstQualifiedName: longName,
      relType: REL_TYPES.DR_READS_FIELD,
    });
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "IntegrationProcedure:Proc_One",
      depth: 4,
    });
    const md = r.markdown as string;
    // Cycle 3 T3: the Picture is shown by default; `mermaid: false` hides it.
    expect(md).toContain("```mermaid");
    const off = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "IntegrationProcedure:Proc_One",
      depth: 4,
      mermaid: false,
    });
    expect(off.markdown).not.toContain("```mermaid");
    expect(md).toContain("CustomField 2");
    expect(md).toContain("CustomObject 1");
    expect(md).toContain("DataRaptor 1");
    expect(md).toContain("### CustomField (2)");
    expect(md).toContain(`- ${longName} — hop 2 via DR_READS_FIELD`);
    expect(md).toContain("- DataRaptor:Writer — hop 1 via IP_CALLS_DR");
  });

  it("includes dangling targets with the label from the qname prefix", async () => {
    fix.addNode({ qualifiedName: "DataRaptor:D", label: "DataRaptor" });
    fix.addEdge({
      srcQualifiedName: "DataRaptor:D",
      dstQualifiedName: "CustomObject:NoRowObject",
      relType: REL_TYPES.REFERENCES_OBJECT,
    });
    const r = await callTool("trace_downstream", { org: fix.orgId, qname: "DataRaptor:D" });
    const md = r.markdown as string;
    expect(md).toContain("### CustomObject (1)");
    expect(md).toContain("- CustomObject:NoRowObject — hop 1 via REFERENCES_OBJECT (no node)");
  });

  it("dangling sources appear in the upstream list too", async () => {
    fix.addNode({ qualifiedName: "ApexClass:T", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "Flow:Ghost",
      dstQualifiedName: "ApexClass:T",
      relType: REL_TYPES.FLOW_INVOKES_APEX,
    });
    const r = await callTool("trace_upstream", { org: fix.orgId, qname: "ApexClass:T" });
    expect(r.markdown).toContain("- Flow:Ghost — hop 1 via FLOW_INVOKES_APEX (no node)");
  });

  it("caps the list at 300 entries and says how to narrow", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Hub", label: "ApexClass" });
    for (let i = 0; i < 320; i++) {
      fix.addNode({ qualifiedName: `ApexClass:Leaf${i}`, label: "ApexClass" });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Hub",
        dstQualifiedName: `ApexClass:Leaf${i}`,
        relType: REL_TYPES.CALLS,
      });
    }
    const r = await callTool("trace_downstream", { org: fix.orgId, qname: "ApexClass:Hub" });
    const md = r.markdown as string;
    const entries = md.split("\n").filter((l) => l.startsWith("- ApexClass:Leaf"));
    expect(entries.length).toBe(300);
    expect(md).toContain("20 more entries omitted");
    expect(md).toContain("ApexClass 320");
    expect(md).toMatch(/depth/);
    expect(md).toMatch(/labels/);
  });

  it("labels filter narrows the list", async () => {
    objectFixture();
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "IntegrationProcedure:Proc_One",
      depth: 4,
      labels: ["CustomObject"],
    });
    const md = r.markdown as string;
    expect(md).toContain("- CustomObject:Big__c");
    expect(md).not.toContain("- DataRaptor:Writer");
  });

  it("mermaid:true appends the diagram", async () => {
    objectFixture();
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "IntegrationProcedure:Proc_One",
      mermaid: true,
    });
    expect(r.markdown).toContain("```mermaid");
    expect(r.markdown).toContain("- DataRaptor:Writer");
  });
});

describe("trace_downstream: roll-up methods do not crowd the cap", () => {
  it("collapses roll-up sibling methods under the class line and still shows other labels", async () => {
    fix.addNode({ qualifiedName: "LWC:cmp", label: "LWC" });
    fix.addNode({ qualifiedName: "ApexClass:Huge", label: "ApexClass" });
    for (let i = 0; i < 400; i++) {
      const m = `ApexMethod:Huge.m${i}(0)`;
      fix.addNode({ qualifiedName: m, label: "ApexMethod" });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Huge",
        dstQualifiedName: m,
        relType: REL_TYPES.CONTAINS_METHOD,
      });
    }
    fix.addEdge({
      srcQualifiedName: "LWC:cmp",
      dstQualifiedName: "ApexMethod:Huge.m0(0)",
      relType: REL_TYPES.IMPORTS_APEX,
    });
    for (let i = 0; i < 5; i++) {
      const f = `CustomField:Obj__c.Fld${i}__c`;
      fix.addNode({ qualifiedName: f, label: "CustomField" });
      fix.addEdge({
        srcQualifiedName: "ApexMethod:Huge.m1(0)",
        dstQualifiedName: f,
        relType: REL_TYPES.READS_FIELD,
      });
    }
    const r = await callTool("trace_downstream", { org: fix.orgId, qname: "LWC:cmp", depth: 2 });
    const md = r.markdown as string;
    for (let i = 0; i < 5; i++) expect(md).toContain(`- CustomField:Obj__c.Fld${i}__c`);
    expect(md).toContain("- ApexClass:Huge");
    expect(md).toContain("(+399 methods via roll-up)");
    expect(md).not.toContain("- ApexMethod:Huge.m7(0)");
    expect(md).not.toContain("more entries omitted");
    expect(names(r).length).toBe(406);
  });
});

describe("trace_downstream: labels including ApexMethod", () => {
  it("lists direct entries before roll-up siblings so other labels survive the cap", async () => {
    fix.addNode({ qualifiedName: "LWC:cmp", label: "LWC" });
    fix.addNode({ qualifiedName: "ApexClass:Huge", label: "ApexClass" });
    for (let i = 0; i < 400; i++) {
      const m = `ApexMethod:Huge.a${i}(0)`;
      fix.addNode({ qualifiedName: m, label: "ApexMethod" });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Huge",
        dstQualifiedName: m,
        relType: REL_TYPES.CONTAINS_METHOD,
      });
    }
    fix.addEdge({
      srcQualifiedName: "LWC:cmp",
      dstQualifiedName: "ApexMethod:Huge.a0(0)",
      relType: REL_TYPES.IMPORTS_APEX,
    });
    for (let i = 0; i < 5; i++) {
      const f = `CustomField:Obj__c.Fld${i}__c`;
      fix.addNode({ qualifiedName: f, label: "CustomField" });
      fix.addEdge({
        srcQualifiedName: "ApexMethod:Huge.a1(0)",
        dstQualifiedName: f,
        relType: REL_TYPES.READS_FIELD,
      });
    }
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "LWC:cmp",
      depth: 2,
      labels: ["ApexMethod", "CustomField"],
    });
    const md = r.markdown as string;
    for (let i = 0; i < 5; i++) expect(md).toContain(`- CustomField:Obj__c.Fld${i}__c`);
    expect(md).toContain("- ApexMethod:Huge.a0(0)");
  });
});

// Cycle 2 T5 fix round 1: a reached method is a member of its class; the list names the
// class beside each method row and lists the classes of the listed methods, so a reader
// naming components (`ApexClass:<Name>`) does not have to derive them or drop the rows.
describe("trace lists: classes of the listed methods", () => {
  function callers(): void {
    fix.addNode({ qualifiedName: "ApexClass:Svc", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexMethod:Svc.x(0)", label: "ApexMethod" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Svc",
      dstQualifiedName: "ApexMethod:Svc.x(0)",
      relType: REL_TYPES.CONTAINS_METHOD,
    });
    for (const [cls, m, label] of [
      ["Caller", "ApexMethod:Caller.run(0)", "ApexMethod"],
      ["SvcTest", "ApexMethod:SvcTest.t1(0)", "TestMethod"],
      ["SvcTest", "ApexMethod:SvcTest.t2(0)", "TestMethod"],
    ] as const) {
      fix.addNode({ qualifiedName: `ApexClass:${cls}`, label: "ApexClass" });
      fix.addNode({ qualifiedName: m, label });
      fix.addEdge({
        srcQualifiedName: `ApexClass:${cls}`,
        dstQualifiedName: m,
        relType: REL_TYPES.CONTAINS_METHOD,
      });
      fix.addEdge({
        srcQualifiedName: m,
        dstQualifiedName: "ApexMethod:Svc.x(0)",
        relType: REL_TYPES.CALLS,
      });
    }
    fix.addEdge({
      srcQualifiedName: "ApexClass:SvcTest",
      dstQualifiedName: "ApexClass:Svc",
      relType: REL_TYPES.IS_TEST_FOR,
    });
  }

  it("upstream: each method row names its class; classes not listed themselves are listed apart", async () => {
    callers();
    const md = (
      await callTool("trace_upstream", { org: fix.orgId, qname: "ApexClass:Svc", depth: 1 })
    ).markdown as string;
    expect(md).toContain("- ApexMethod:Caller.run(0) (in ApexClass:Caller) — hop 1 via CALLS");
    expect(md).toContain("- ApexMethod:SvcTest.t1(0) (in ApexClass:SvcTest) — hop 1 via CALLS");
    // SvcTest is listed itself (IS_TEST_FOR); Caller is reached only through its method.
    expect(md).toContain(
      "### Classes of the listed methods (1 not listed above)\n- ApexClass:Caller",
    );
  });

  it("no section when every method's class is listed", async () => {
    callers();
    fix.addEdge({
      srcQualifiedName: "ApexClass:Caller",
      dstQualifiedName: "ApexClass:Svc",
      relType: REL_TYPES.REFERENCES,
    });
    const md = (
      await callTool("trace_upstream", { org: fix.orgId, qname: "ApexClass:Svc", depth: 1 })
    ).markdown as string;
    expect(md).not.toContain("### Classes of the listed methods");
    expect(md).toContain("- ApexMethod:Caller.run(0) (in ApexClass:Caller) — hop 1 via CALLS");
  });
});

// Cycle 2 T5 fix round 1: a dynamic query's objects and fields are in a string built at run
// time, so the graph has no edge to them; the list says so and where the source is.
describe("trace_downstream: dynamic queries are flagged", () => {
  function dyn(platformCall: string): void {
    fix.addNode({ qualifiedName: "LWC:cmp", label: "LWC" });
    fix.addNode({ qualifiedName: "ApexClass:Ctl", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexMethod:Ctl.find(1)", label: "ApexMethod" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Ctl",
      dstQualifiedName: "ApexMethod:Ctl.find(1)",
      relType: REL_TYPES.CONTAINS_METHOD,
    });
    fix.addEdge({
      srcQualifiedName: "LWC:cmp",
      dstQualifiedName: "ApexMethod:Ctl.find(1)",
      relType: REL_TYPES.IMPORTS_APEX,
    });
    fix.addEdge({
      srcQualifiedName: "ApexMethod:Ctl.find(1)",
      dstQualifiedName: platformCall,
      relType: REL_TYPES.CALLS,
    });
  }

  it("a reached Database.query call adds the dynamic-query note", async () => {
    dyn("ApexMethod:Database.query(1)");
    const md = (await callTool("trace_downstream", { org: fix.orgId, qname: "LWC:cmp", depth: 2 }))
      .markdown as string;
    expect(md).toContain(
      "_Dynamic queries reached_ (`Database.query(1)`): objects and fields named in a query string built at run time have no edge, so they are not listed — read the calling methods' source (`explain_code`) for them.",
    );
  });

  it("other platform calls do not", async () => {
    dyn("ApexMethod:String.escapeSingleQuotes(1)");
    const md = (await callTool("trace_downstream", { org: fix.orgId, qname: "LWC:cmp", depth: 2 }))
      .markdown as string;
    expect(md).not.toContain("Dynamic queries");
  });
});

// Cycle 3 T9 fix round 1: a root's own members (a flow's versions) are the root in the report, and
// the technical list says why its count is not the In short count.
describe("trace report: root members and method counts", () => {
  it("draws and describes a link from the root's version as the root's own", async () => {
    fix.addNode({ qualifiedName: "Flow:Req_Flow", label: "Flow" });
    fix.addNode({ qualifiedName: "FlowVersion:Req_Flow.v3", label: "FlowVersion" });
    fix.addNode({ qualifiedName: "CustomObject:Req__c", label: "CustomObject" });
    fix.addNode({ qualifiedName: "CustomField:Req__c.State__c", label: "CustomField" });
    fix.addEdge({
      srcQualifiedName: "Flow:Req_Flow",
      dstQualifiedName: "FlowVersion:Req_Flow.v3",
      relType: REL_TYPES.CONTAINS,
    });
    fix.addEdge({
      srcQualifiedName: "FlowVersion:Req_Flow.v3",
      dstQualifiedName: "CustomObject:Req__c",
      relType: REL_TYPES.TRIGGER_FIRES_ON,
    });
    fix.addEdge({
      srcQualifiedName: "FlowVersion:Req_Flow.v3",
      dstQualifiedName: "CustomField:Req__c.State__c",
      relType: REL_TYPES.READS_FIELD,
    });
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "Flow:Req_Flow",
      depth: 1,
    });
    const md = r.markdown as string;
    expect(md).toMatch(/n0 -->\|runs when records change on\| n\d/);
    expect(md).toMatch(/n0 -->\|reads the field\| n\d/);
    expect(md).toContain("the flow `Req_Flow` runs when `Req__c` records change");
    expect(md).not.toContain('reached through a "runs when records change on" link');
  });

  it("says the technical list counts methods one by one when the In short counts their classes", async () => {
    fix.addNode({ qualifiedName: "Flow:Up_Flow", label: "Flow" });
    fix.addNode({ qualifiedName: "ApexClass:Svc", label: "ApexClass" });
    for (const m of ["a(0)", "b(1)"]) {
      fix.addNode({ qualifiedName: `ApexMethod:Svc.${m}`, label: "ApexMethod" });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Svc",
        dstQualifiedName: `ApexMethod:Svc.${m}`,
        relType: REL_TYPES.CONTAINS_METHOD,
      });
    }
    fix.addEdge({
      srcQualifiedName: "Flow:Up_Flow",
      dstQualifiedName: "ApexMethod:Svc.a(0)",
      relType: REL_TYPES.FLOW_INVOKES_APEX_METHOD,
    });
    fix.addEdge({
      srcQualifiedName: "ApexMethod:Svc.a(0)",
      dstQualifiedName: "ApexMethod:Svc.b(1)",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "Flow:Up_Flow",
      depth: 2,
    });
    const md = r.markdown as string;
    expect(md).toContain("relies on 1 piece");
    expect(md).toContain(
      "The list below counts each Apex method on its own (a method is part of its class above), so it shows 3 entries.",
    );
  });

  it("adds no count note when the counts agree", async () => {
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:A",
      depth: 2,
    });
    expect(r.markdown as string).not.toContain("counts each Apex method on its own");
  });
});
