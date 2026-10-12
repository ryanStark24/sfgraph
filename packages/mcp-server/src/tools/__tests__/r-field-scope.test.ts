import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// Batch R / S2 + S3: standard fields are kept but marked, managed-package
// types with no node are pseudo endpoints, and the flow map expands a reached
// method's owner class.

let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "LWC:entry", label: "LWC" });
  fix.addNode({ qualifiedName: "ApexClass:Ctrl", label: "ApexClass" });
  fix.addNode({ qualifiedName: "CustomObject:Account", label: "CustomObject" });
  fix.addNode({ qualifiedName: "CustomField:Account.Name", label: "CustomField" });
  fix.addNode({ qualifiedName: "CustomField:Account.Tier__c", label: "CustomField" });
  fix.addNode({ qualifiedName: "CustomField:Account.pkga__Score__c", label: "CustomField" });
  fix.addEdge({
    srcQualifiedName: "LWC:entry",
    dstQualifiedName: "ApexClass:Ctrl",
    relType: REL_TYPES.IMPORTS_APEX,
  });
  for (const f of ["Account.Name", "Account.Tier__c", "Account.pkga__Score__c"]) {
    fix.addEdge({
      srcQualifiedName: "ApexClass:Ctrl",
      dstQualifiedName: `CustomField:${f}`,
      relType: REL_TYPES.READS_FIELD,
    });
  }
  fix.addEdge({
    srcQualifiedName: "ApexClass:Ctrl",
    dstQualifiedName: "CustomObject:Account",
    relType: REL_TYPES.EXECUTES_SOQL,
  });
  // A packaged interface: no node, namespace known from pkga__Score__c.
  fix.addEdge({
    srcQualifiedName: "ApexClass:Ctrl",
    dstQualifiedName: "ApexClass:pkga.OpenInterface",
    relType: REL_TYPES.CALLS,
  });
});
afterEach(async () => {
  await fix.cleanup();
});

type Reached = { qualifiedName: string; role?: string };

describe("trace_downstream field and namespace scoping", () => {
  it("marks standard fields, keeps them, and does not count them", async () => {
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "ApexClass:Ctrl",
      depth: 1,
    });
    const d = r.data as {
      reached: Reached[];
      pseudo: Array<{ qualifiedName: string; pseudoKind: string }>;
    };
    const role = (q: string) => d.reached.find((e) => e.qualifiedName === q)?.role;
    expect(role("CustomField:Account.Name")).toBe("standard-field");
    expect(role("CustomField:Account.Tier__c")).toBeUndefined();
    expect(role("CustomField:Account.pkga__Score__c")).toBeUndefined();
    expect(role("CustomObject:Account")).toBeUndefined();
    expect(d.pseudo).toEqual([
      expect.objectContaining({
        qualifiedName: "ApexClass:pkga.OpenInterface",
        pseudoKind: "managed-package",
      }),
    ]);
    expect(r.summary).toMatch(/^3 downstream/);
    expect(r.markdown).toMatch(/Standard fields \(1/);
    expect(r.markdown).toContain("CustomField:Account.Name");
  });
});

describe("cross_layer_flow_map field and namespace scoping", () => {
  it("standard-field participants carry a role; packaged types are pseudo", async () => {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:entry" });
    const d = r.data as {
      participants: Array<{ id: string; role?: string }>;
      pseudo: Array<{ id: string; pseudoKind: string }>;
    };
    const role = (q: string) => d.participants.find((p) => p.id === q)?.role;
    expect(role("CustomField:Account.Name")).toBe("standard-field");
    expect(role("CustomField:Account.Tier__c")).toBeUndefined();
    expect(d.participants.some((p) => p.id === "ApexClass:pkga.OpenInterface")).toBe(false);
    expect(d.pseudo).toContainEqual({
      id: "ApexClass:pkga.OpenInterface",
      pseudoKind: "managed-package",
    });
    // Ctrl, Account, Tier__c, pkga__Score__c (entry and the standard field not counted).
    expect(r.summary).toMatch(/^4 participants/);
  });

  // T15 I-2 reverses S3: the owner class is drawn, its sibling methods' callees are not.
  it("a reached method draws its owner class but not its sibling methods' callees (T15 I-2)", async () => {
    fix.addNode({ qualifiedName: "LWC:m", label: "LWC" });
    fix.addNode({ qualifiedName: "ApexClass:Svc", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexMethod:Svc.a(0)", label: "ApexMethod" });
    fix.addNode({ qualifiedName: "ApexMethod:Svc.b(0)", label: "ApexMethod" });
    fix.addNode({ qualifiedName: "ApexClass:Helper", label: "ApexClass" });
    for (const m of ["a(0)", "b(0)"]) {
      fix.addEdge({
        srcQualifiedName: "ApexClass:Svc",
        dstQualifiedName: `ApexMethod:Svc.${m}`,
        relType: REL_TYPES.CONTAINS_METHOD,
      });
    }
    fix.addEdge({
      srcQualifiedName: "LWC:m",
      dstQualifiedName: "ApexMethod:Svc.a(0)",
      relType: REL_TYPES.CALLS_APEX_FROM_LWC,
    });
    fix.addEdge({
      srcQualifiedName: "ApexMethod:Svc.b(0)",
      dstQualifiedName: "ApexClass:Helper",
      relType: REL_TYPES.CALLS,
    });
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:m" });
    const ids = (r.data as { participants: Array<{ id: string }> }).participants.map((p) => p.id);
    expect(ids).toContain("ApexClass:Svc");
    expect(ids).not.toContain("ApexClass:Helper");
  });
});
