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
  // Cycle 3 T3: the core sequenceDiagram is replaced by the report Picture (a flowchart) and a
  // "### Steps" list under Technical details.
  it("produces a flowchart picture and a steps list", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" });
    expect(r.markdown).toContain("```mermaid\nflowchart LR");
    expect(r.markdown).toContain("### Steps (2)");
    expect(r.markdown).not.toContain("sequenceDiagram");
  });

  it("traces through 3 layers", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" });
    const d = r.data as { participants: unknown[] };
    expect(d.participants.length).toBeGreaterThanOrEqual(3);
  });

  it("reports an unknown entry as not found (audit tools-12)", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:ghost" });
    expect(r.summary).toBe("entry not found");
    expect((r.data as { found: boolean }).found).toBe(false);
    expect(r.markdown).toMatch(/find_nodes/);
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

describe("cross_layer_flow_map layerFor (cycle 2 T1)", () => {
  it("puts the LWCBundle node label (as in ENTRY_LABELS) in the LWC layer", async () => {
    const { ENTRY_LABELS, layerFor } = await import("../cross_layer_flow_map.js");
    expect(ENTRY_LABELS).toContain("LWCBundle");
    expect(layerFor("LWCBundle")).toBe("LWC");
    expect(layerFor("LWC")).toBe("LWC");
    // the metadata type name is not a node label
    expect(layerFor("LightningComponentBundle")).toBe("LightningComponentBundle");
  });
});

describe("cross_layer_flow_map data and constant steps (cycle 2 T3)", () => {
  type Flow = {
    participants: Array<{ id: string }>;
    messages: Array<{ fromId: string; toId: string; label: string }>;
  };
  const node = (q: string): void =>
    fix.addNode({ qualifiedName: q, label: q.slice(0, q.indexOf(":")) });
  const edge = (
    src: string,
    rel: string,
    dst: string,
    attributes?: Record<string, unknown>,
  ): void =>
    fix.addEdge({
      srcQualifiedName: src,
      dstQualifiedName: dst,
      relType: rel,
      ...(attributes ? { attributes } : {}),
    });

  it("lists the object whose fields a reached method writes (DML on a typed record)", async () => {
    for (const q of [
      "ApexClass:Saver",
      "ApexMethod:Saver.save(1)",
      "CustomObject:Log__c",
      "CustomField:Log__c.Msg__c",
    ])
      node(q);
    edge("ApexClass:Saver", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Saver.save(1)");
    edge("ApexMethod:Saver.save(1)", REL_TYPES.WRITES_FIELD, "CustomField:Log__c.Msg__c");
    edge("ApexMethod:Saver.save(1)", REL_TYPES.EXECUTES_DML, "DML:insert");
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Saver" });
    const d = r.data as Flow;
    const ids = d.participants.map((p) => p.id);
    expect(ids).toContain("CustomObject:Log__c");
    expect(ids).toContain("CustomField:Log__c.Msg__c");
    // T3 fix 1 M-2: the object is linked by containment (object -> field), not by the field's rel type
    expect(d.messages).toContainEqual({
      fromId: "CustomObject:Log__c",
      toId: "CustomField:Log__c.Msg__c",
      label: REL_TYPES.CONTAINS,
    });
    expect(
      d.messages.some((m) => m.fromId === "ApexClass:Saver" && m.toId === "CustomObject:Log__c"),
    ).toBe(false);
  });

  it("adds no object arrow when the same source already links the object (T3 fix 1 M-2)", async () => {
    for (const q of ["ApexClass:Saver", "CustomObject:Log__c", "CustomField:Log__c.Msg__c"])
      node(q);
    edge("ApexClass:Saver", REL_TYPES.WRITES_FIELD, "CustomField:Log__c.Msg__c");
    edge("ApexClass:Saver", REL_TYPES.EXECUTES_SOQL, "CustomObject:Log__c");
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Saver" });
    const d = r.data as Flow;
    const toObj = d.messages.filter(
      (m) => m.toId === "CustomObject:Log__c" || m.fromId === "CustomObject:Log__c",
    );
    expect(toObj).toEqual([
      { fromId: "ApexClass:Saver", toId: "CustomObject:Log__c", label: REL_TYPES.EXECUTES_SOQL },
    ]);
  });

  it("does not invent an object row for a field whose object has no node", async () => {
    node("ApexClass:Saver");
    node("CustomField:Ghost__c.Msg__c");
    edge("ApexClass:Saver", REL_TYPES.READS_FIELD, "CustomField:Ghost__c.Msg__c");
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Saver" });
    const ids = (r.data as Flow).participants.map((p) => p.id);
    expect(ids).toContain("CustomField:Ghost__c.Msg__c");
    expect(ids).not.toContain("CustomObject:Ghost__c");
  });

  it("follows a static-member reference to a constants class, without expanding its methods", async () => {
    for (const q of [
      "ApexClass:Page",
      "ApexMethod:Page.load(0)",
      "ApexClass:Consts",
      "ApexMethod:Consts.helper(0)",
      "ApexClass:Unrelated",
      "ApexClass:Guess",
    ])
      node(q);
    edge("ApexClass:Page", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Page.load(0)");
    edge("ApexClass:Consts", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Consts.helper(0)");
    edge("ApexMethod:Page.load(0)", REL_TYPES.REFERENCES, "ApexClass:Consts", {
      via: "static-member",
    });
    // a sibling method of the constants class is not on the path
    edge("ApexMethod:Consts.helper(0)", REL_TYPES.CALLS, "ApexClass:Unrelated");
    // a reflection guess is still not followed
    edge("ApexMethod:Page.load(0)", REL_TYPES.REFERENCES, "ApexClass:Guess", {
      source: "reflection",
    });
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Page" });
    const ids = (r.data as Flow).participants.map((p) => p.id);
    expect(ids).toContain("ApexClass:Consts");
    expect(ids).not.toContain("ApexClass:Unrelated");
    expect(ids).not.toContain("ApexClass:Guess");
  });

  it("still ignores a plain (non static-member) REFERENCES edge to a class", async () => {
    node("ApexClass:Page");
    node("ApexClass:TypeOnly");
    edge("ApexClass:Page", REL_TYPES.REFERENCES, "ApexClass:TypeOnly");
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "ApexClass:Page" });
    expect((r.data as Flow).participants.map((p) => p.id)).not.toContain("ApexClass:TypeOnly");
  });
});

// Cycle 2 T5 fix round 1: the diagram alone was the whole text. A lead-in names every reached
// component by full qname, grouped by label, before the diagram; one arrow per participant pair.
describe("cross_layer_flow_map: lead-in list and merged arrows", () => {
  it("lists the reached components by label before the diagram", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Rating__c", label: "CustomField" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Ctrl",
      dstQualifiedName: "CustomField:Account.Rating__c",
      relType: REL_TYPES.WRITES_FIELD,
    });
    const md = (await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" }))
      .markdown;
    expect(md).toContain(
      [
        "Flow from `LWC:myCmp`: 2 components reached (the entry and standard fields not counted).",
        "",
        "### ApexClass (1)",
        "- ApexClass:Ctrl",
        "",
        "### CustomField (1)",
        "- CustomField:Account.Rating__c",
      ].join("\n"),
    );
    // Cycle 3 T3: the diagram is now the Picture, above Technical details; the steps follow the list.
    expect(md.indexOf("### ApexClass")).toBeLessThan(md.indexOf("### Steps"));
  });

  it("draws one arrow per participant pair with the rel types joined; data keeps every message", async () => {
    fix.addEdge({
      srcQualifiedName: "LWC:myCmp",
      dstQualifiedName: "ApexClass:Ctrl",
      relType: REL_TYPES.IMPORTS_APEX,
    });
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" });
    // Cycle 3 T3: one "### Steps" line per participant pair (was one sequenceDiagram arrow).
    const arrows = r.markdown.split("\n").filter((l) => l.startsWith("- LWC:myCmp -> "));
    expect(arrows).toHaveLength(1);
    expect(arrows[0]).toMatch(
      /: (CALLS_APEX_FROM_LWC, IMPORTS_APEX|IMPORTS_APEX, CALLS_APEX_FROM_LWC)$/,
    );
    const msgs = (r.data as { messages: Array<{ fromId: string }> }).messages.filter(
      (m) => m.fromId === "LWC:myCmp",
    );
    expect(msgs).toHaveLength(2);
  });
});

// Cycle 3 T3 fix round 2: the path sentence says it is one path when the flow branches.
describe("cross_layer_flow_map: path sentence", () => {
  const inShortOf = (md: string) => {
    const lines = md.split("\n");
    return lines[lines.indexOf("**In short**") + 1] ?? "";
  };

  it("keeps the plain wording when the flow does not branch", async () => {
    const md = (await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" }))
      .markdown;
    expect(inShortOf(md)).toContain("`myCmp` calls `Ctrl`; together they read 1 standard field.");
    expect(inShortOf(md)).not.toContain("One path");
  });

  // Cycle 3 T9 fix round 1: the path sentence counts standard fields apart, as the In short does.
  it("counts custom and standard fields apart in the path sentence", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Tier__c", label: "CustomField" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Ctrl",
      dstQualifiedName: "CustomField:Account.Tier__c",
      relType: REL_TYPES.READS_FIELD,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Ctrl",
      dstQualifiedName: "CustomField:Account.Tier__c",
      relType: REL_TYPES.WRITES_FIELD,
    });
    const md = (await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" }))
      .markdown;
    expect(inShortOf(md)).toContain(
      "together they read 1 field and 1 standard field and write 1 field.",
    );
  });

  it("says it is one path, and where the flow branches, when it branches", async () => {
    for (const q of ["ApexClass:A", "ApexClass:B"]) {
      fix.addNode({ qualifiedName: q, label: "ApexClass" });
      fix.addEdge({
        srcQualifiedName: "ApexClass:Ctrl",
        dstQualifiedName: q,
        relType: REL_TYPES.CALLS,
      });
    }
    const md = (await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:myCmp" }))
      .markdown;
    expect(inShortOf(md)).toContain(
      "One path through it: `myCmp` calls `Ctrl`, which calls `A`; together they read 1 standard field (the flow also branches at 1 step; all steps are listed under Technical details).",
    );
  });
});
