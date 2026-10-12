import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APEX_PLATFORM_NAMESPACES as DOMAIN_APEX_PLATFORM_NAMESPACES,
  REL_TYPES,
} from "../../domain/index.js";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/index.js";
import { APEX_PLATFORM_NAMESPACES, isApexPlatformQname } from "../apex-platform.js";
import { findDependencies } from "../dependencies.js";
import { type ReachedEntry, findDependents } from "../dependents.js";
import { partitionPseudoEndpoints, pseudoEndpointKind } from "../pseudo-endpoints.js";

// Batch Q1 (task 14): containment at zero hop cost, upstream structural
// leaves, component-level Apex hops, folded containers, pseudo endpoints.
const orgId = asOrgId("orgQ1");
let store: SqliteGraphStore;

beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

function node(qn: string): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qn),
    label: qn.slice(0, qn.indexOf(":")),
    attributes: {},
    sourceHash: asSha256(`h-${qn}`),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(src: string, dst: string, rel: string): EdgeFact {
  return {
    orgId,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as never,
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}
function add(nodes: string[], edges: Array<[string, string, string]>): void {
  store.mergeNodes(nodes.map(node));
  store.mergeEdges(edges.map(([s, d, r]) => edge(s, d, r)));
}
const q = asQualifiedName;
const byQ = (r: { reached?: ReachedEntry[] }) =>
  new Map((r.reached ?? []).map((e) => [e.qualifiedName, e]));
const rows = (r: { reached?: ReachedEntry[] }) => (r.reached ?? []).map((e) => e.qualifiedName);

describe("downstream: containment costs no hop", () => {
  it("a reached ApexClass expands its methods at the same hop", () => {
    add(
      ["IntegrationProcedure:IP", "ApexClass:C", "ApexMethod:C.m(0)", "CustomObject:Obj__c"],
      [
        ["IntegrationProcedure:IP", "ApexClass:C", REL_TYPES.VLOCITY_INVOKES_APEX],
        ["ApexClass:C", "ApexMethod:C.m(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexMethod:C.m(0)", "CustomObject:Obj__c", REL_TYPES.EXECUTES_SOQL],
      ],
    );
    const r = findDependencies(store, orgId, q("IntegrationProcedure:IP"), 2, {
      leafStructure: true,
      rollupApexClass: true,
    });
    const m = byQ(r);
    expect(m.get("ApexClass:C")?.hop).toBe(1);
    expect(m.get("ApexMethod:C.m(0)")?.hop).toBe(1);
    expect(m.get("CustomObject:Obj__c")?.hop).toBe(2);
  });

  it("without rollupApexClass a reached class does not pull in its methods (review M5)", () => {
    add(
      ["LWC:cmp", "ApexClass:C", "ApexMethod:C.a(0)", "ApexMethod:C.b(0)"],
      [
        ["LWC:cmp", "ApexClass:C", REL_TYPES.REFERENCES],
        ["ApexClass:C", "ApexMethod:C.a(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexClass:C", "ApexMethod:C.b(0)", REL_TYPES.CONTAINS_METHOD],
      ],
    );
    const r = findDependencies(store, orgId, q("LWC:cmp"), 1);
    expect(rows(r)).toEqual(["ApexClass:C"]);
  });

  it("a root Flow's FlowVersion is a hop-0 root member; its targets are hop 1", () => {
    add(
      ["Flow:F", "FlowVersion:F.v3", "ApexClass:C", "ApexMethod:C.m(0)", "CustomObject:Obj__c"],
      [
        ["Flow:F", "FlowVersion:F.v3", REL_TYPES.CONTAINS],
        ["FlowVersion:F.v3", "ApexClass:C", REL_TYPES.FLOW_INVOKES_APEX],
        ["ApexClass:C", "ApexMethod:C.m(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexMethod:C.m(0)", "CustomObject:Obj__c", REL_TYPES.EXECUTES_SOQL],
      ],
    );
    const r = findDependencies(store, orgId, q("Flow:F"), 2, {
      leafStructure: true,
      rollupApexClass: true,
    });
    const m = byQ(r);
    expect(m.get("FlowVersion:F.v3")).toMatchObject({ hop: 0, role: "root-member" });
    expect(m.get("ApexClass:C")?.hop).toBe(1);
    expect(m.get("CustomObject:Obj__c")?.hop).toBe(2);
  });

  it("a root ApexClass's own methods are hop-0 root members", () => {
    add(
      ["ApexClass:R", "ApexMethod:R.a(0)", "CustomObject:Obj__c"],
      [
        ["ApexClass:R", "ApexMethod:R.a(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexMethod:R.a(0)", "CustomObject:Obj__c", REL_TYPES.EXECUTES_SOQL],
      ],
    );
    const r = findDependencies(store, orgId, q("ApexClass:R"), 1, { rollupApexClass: true });
    const m = byQ(r);
    expect(m.get("ApexMethod:R.a(0)")).toMatchObject({ hop: 0, role: "root-member" });
    expect(m.get("CustomObject:Obj__c")?.hop).toBe(1);
  });

  it("folds a reached Flow's FlowVersion into the Flow row", () => {
    add(
      ["Flow:Parent", "FlowVersion:Parent.v1", "Flow:Sub", "FlowVersion:Sub.v2", "CustomObject:O"],
      [
        ["Flow:Parent", "FlowVersion:Parent.v1", REL_TYPES.CONTAINS],
        ["FlowVersion:Parent.v1", "Flow:Sub", REL_TYPES.FLOW_INVOKES_SUBFLOW],
        ["Flow:Sub", "FlowVersion:Sub.v2", REL_TYPES.CONTAINS],
        ["FlowVersion:Sub.v2", "CustomObject:O", REL_TYPES.REFERENCES_OBJECT],
      ],
    );
    const r = findDependencies(store, orgId, q("Flow:Parent"), 2, { leafStructure: true });
    const m = byQ(r);
    expect(rows(r)).not.toContain("FlowVersion:Sub.v2");
    expect(m.get("Flow:Sub")).toMatchObject({ hop: 1, folded: ["FlowVersion:Sub.v2"] });
    expect(m.get("CustomObject:O")?.hop).toBe(2);
  });

  it("folds a reached LWC's bundle into the LWC row", () => {
    add(
      ["LWC:parent", "LWC:child", "LWCBundle:child"],
      [
        ["LWC:parent", "LWC:child", REL_TYPES.EMBEDS_LWC],
        ["LWCBundle:child", "LWC:child", REL_TYPES.CONTAINS_COMPONENT],
      ],
    );
    const r = findDependencies(store, orgId, q("LWC:parent"), 2);
    expect(rows(r)).toEqual(["LWC:child"]);
    expect(byQ(r).get("LWC:child")?.folded).toEqual(["LWCBundle:child"]);
    expect(r.nodes.map((n) => n.qualifiedName)).toEqual(["LWC:child"]);
  });

  it("is label-generic: Workflow CONTAINS is not member containment", () => {
    add(
      ["Flow:F", "FlowVersion:F.v1", "Workflow:W", "WorkflowAlert:W.a"],
      [
        ["Flow:F", "FlowVersion:F.v1", REL_TYPES.CONTAINS],
        ["FlowVersion:F.v1", "Workflow:W", REL_TYPES.REFERENCES],
        ["Workflow:W", "WorkflowAlert:W.a", REL_TYPES.CONTAINS],
      ],
    );
    const r = findDependencies(store, orgId, q("Flow:F"), 1);
    expect(rows(r)).not.toContain("WorkflowAlert:W.a");
  });
});

describe("upstream: structural leaves", () => {
  function fieldFixture(): void {
    add(
      ["CustomField:T__c.F__c", "CustomObject:T__c", "ApexClass:Reader", "ApexClass:Querier"],
      [
        ["CustomObject:T__c", "CustomField:T__c.F__c", REL_TYPES.DEFINES_FIELD],
        ["ApexClass:Reader", "CustomField:T__c.F__c", REL_TYPES.READS_FIELD],
        ["ApexClass:Querier", "CustomObject:T__c", REL_TYPES.EXECUTES_SOQL],
      ],
    );
  }
  it("lists the defining object as a leaf, not every querier of it", () => {
    fieldFixture();
    const r = findDependents(store, orgId, q("CustomField:T__c.F__c"), 2);
    expect(rows(r).sort()).toEqual(["ApexClass:Reader", "CustomObject:T__c"]);
    expect(r.structural).toBe(1);
  });
  it("leafStructure: false restores the expansion", () => {
    fieldFixture();
    const r = findDependents(store, orgId, q("CustomField:T__c.F__c"), 2, {
      leafStructure: false,
    });
    expect(rows(r)).toContain("ApexClass:Querier");
  });
  it("a formula field reading the target is still expanded", () => {
    add(
      ["CustomField:T__c.F__c", "CustomField:T__c.Formula__c", "ApexClass:R2"],
      [
        ["CustomField:T__c.Formula__c", "CustomField:T__c.F__c", REL_TYPES.READS_FIELD],
        ["ApexClass:R2", "CustomField:T__c.Formula__c", REL_TYPES.READS_FIELD],
      ],
    );
    const r = findDependents(store, orgId, q("CustomField:T__c.F__c"), 2);
    expect(rows(r)).toContain("ApexClass:R2");
  });
});

describe("containment rules are exact (review M6/M4)", () => {
  it("CONTAINS_COMPONENT folds only a bundle into its same-named LWC", () => {
    add(
      ["LWC:parent", "LWC:child", "LWCBundle:other"],
      [
        ["LWC:parent", "LWC:child", REL_TYPES.EMBEDS_LWC],
        ["LWCBundle:other", "LWC:child", REL_TYPES.CONTAINS_COMPONENT],
      ],
    );
    const r = findDependencies(store, orgId, q("LWC:parent"), 1);
    expect(rows(r)).toEqual(["LWC:child"]);
    expect(byQ(r).get("LWC:child")?.folded).toBeUndefined();
  });

  it("lists a class's members once however many of its methods are reached", () => {
    const methods = Array.from({ length: 6 }, (_, i) => `ApexMethod:Big.m${i}(0)`);
    add(
      ["ApexClass:Target", "ApexClass:Big", ...methods],
      [
        ...methods.map((m): [string, string, string] => [
          "ApexClass:Big",
          m,
          REL_TYPES.CONTAINS_METHOD,
        ]),
        ...methods.map((m): [string, string, string] => [
          m,
          "ApexClass:Target",
          REL_TYPES.REFERENCES,
        ]),
      ],
    );
    const orig = store.listEdgesFrom.bind(store);
    let memberScans = 0;
    store.listEdgesFrom = (o, qn, ...rest) => {
      if (qn === "ApexClass:Big") memberScans += 1;
      return orig(o, qn, ...rest);
    };
    const r = findDependents(store, orgId, q("ApexClass:Target"), 2);
    expect(rows(r).filter((x) => x.startsWith("ApexMethod:Big.")).length).toBe(6);
    expect(memberScans).toBe(1);
  });
});

describe("upstream: containers are not dependents", () => {
  it("an LWC's own bundle is not listed (CONTAINS_COMPONENT is containment)", () => {
    add(
      ["LWC:cmp", "LWCBundle:cmp", "FlexiPage:P"],
      [
        ["LWCBundle:cmp", "LWC:cmp", REL_TYPES.CONTAINS_COMPONENT],
        ["FlexiPage:P", "LWC:cmp", REL_TYPES.EMBEDS_LWC],
      ],
    );
    const r = findDependents(store, orgId, q("LWC:cmp"), 2);
    expect(rows(r)).toEqual(["FlexiPage:P"]);
  });

  it("a FlowVersion dependent folds into its Flow; subflow callers are the next hop", () => {
    add(
      ["ApexClass:Inv", "FlowVersion:F.v1", "Flow:F", "FlowVersion:Caller.v1", "Flow:Caller"],
      [
        ["FlowVersion:F.v1", "ApexClass:Inv", REL_TYPES.FLOW_INVOKES_APEX],
        ["Flow:F", "FlowVersion:F.v1", REL_TYPES.CONTAINS],
        ["FlowVersion:Caller.v1", "Flow:F", REL_TYPES.FLOW_INVOKES_SUBFLOW],
        ["Flow:Caller", "FlowVersion:Caller.v1", REL_TYPES.CONTAINS],
      ],
    );
    const r = findDependents(store, orgId, q("ApexClass:Inv"), 2);
    const m = byQ(r);
    expect(rows(r).sort()).toEqual(["Flow:Caller", "Flow:F"]);
    expect(m.get("Flow:F")).toMatchObject({ hop: 1, folded: ["FlowVersion:F.v1"] });
    expect(m.get("Flow:Caller")?.hop).toBe(2);
    expect(r.nodes.map((n) => n.qualifiedName).sort()).toEqual(["Flow:Caller", "Flow:F"]);
  });
});

describe("upstream: component-level Apex hops", () => {
  function fixture(): void {
    add(
      [
        "ApexClass:Target",
        "ApexClass:Mid",
        "ApexMethod:Mid.a(0)",
        "ApexMethod:Mid.b(0)",
        "ApexClass:Top",
        "ApexMethod:Top.run(0)",
      ],
      [
        ["ApexClass:Mid", "ApexMethod:Mid.a(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexClass:Mid", "ApexMethod:Mid.b(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexClass:Top", "ApexMethod:Top.run(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexMethod:Mid.a(0)", "ApexClass:Target", REL_TYPES.REFERENCES],
        // Top calls a sibling of the reached method, not the method itself.
        ["ApexMethod:Top.run(0)", "ApexMethod:Mid.b(0)", REL_TYPES.CALLS],
      ],
    );
  }
  it("componentHops: true (opt-in): a reached ApexMethod's next hop includes dependents of its whole class", () => {
    fixture();
    const r = findDependents(store, orgId, q("ApexClass:Target"), 2, { componentHops: true });
    expect(byQ(r).get("ApexMethod:Top.run(0)")?.hop).toBe(2);
  });
  it("T15 I-3: by default a reached method's dependents are its own callers plus class-level references", () => {
    fixture();
    add(
      ["ApexClass:NewsMid"],
      // A class-level reference to Mid (e.g. `new Mid()`) is a dependent of every method.
      [["ApexClass:NewsMid", "ApexClass:Mid", REL_TYPES.REFERENCES]],
    );
    const r = findDependents(store, orgId, q("ApexClass:Target"), 2);
    expect(rows(r)).not.toContain("ApexMethod:Top.run(0)");
    expect(rows(r)).not.toContain("ApexClass:Top");
    expect(byQ(r).get("ApexClass:NewsMid")?.hop).toBe(2);
  });
  it("a method seed stays method-scoped (rule 3)", () => {
    fixture();
    const r = findDependents(store, orgId, q("ApexMethod:Mid.a(0)"), 2);
    expect(rows(r)).not.toContain("ApexMethod:Top.run(0)");
  });
  it("a sibling that calls the method seed stays method-scoped too (review I1)", () => {
    add(
      [
        "ApexClass:Svc",
        "ApexMethod:Svc.helper(0)",
        "ApexMethod:Svc.publicApi(0)",
        "ApexMethod:Svc.other(0)",
        "ApexClass:ApiCaller",
        "ApexClass:OtherCaller",
      ],
      [
        ["ApexClass:Svc", "ApexMethod:Svc.helper(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexClass:Svc", "ApexMethod:Svc.publicApi(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexClass:Svc", "ApexMethod:Svc.other(0)", REL_TYPES.CONTAINS_METHOD],
        ["ApexMethod:Svc.publicApi(0)", "ApexMethod:Svc.helper(0)", REL_TYPES.CALLS],
        ["ApexClass:ApiCaller", "ApexMethod:Svc.publicApi(0)", REL_TYPES.CALLS],
        // A caller of an unrelated sibling: not upstream of helper.
        ["ApexClass:OtherCaller", "ApexMethod:Svc.other(0)", REL_TYPES.CALLS],
      ],
    );
    const r = findDependents(store, orgId, q("ApexMethod:Svc.helper(0)"), 3);
    const m = byQ(r);
    expect(m.get("ApexMethod:Svc.publicApi(0)")?.hop).toBe(1);
    expect(m.get("ApexClass:ApiCaller")?.hop).toBe(2);
    expect(rows(r)).not.toContain("ApexClass:OtherCaller");
    expect(rows(r)).not.toContain("ApexMethod:Svc.other(0)");
  });

  it("componentHops: false keeps method-scoped hops", () => {
    fixture();
    const r = findDependents(store, orgId, q("ApexClass:Target"), 2, { componentHops: false });
    expect(rows(r)).not.toContain("ApexMethod:Top.run(0)");
  });
});

describe("pseudo endpoints", () => {
  it("one shared Apex platform namespace constant", () => {
    for (const ns of ["System", "Database", "Schema", "String", "Limits", "Math", "JSON"]) {
      expect(APEX_PLATFORM_NAMESPACES.has(ns.toLowerCase())).toBe(true);
    }
    expect(isApexPlatformQname("ApexMethod:Database.query(1)")).toBe(true);
    expect(isApexPlatformQname("ApexClass:System")).toBe(true);
    expect(isApexPlatformQname("ApexMethod:MyService.query(1)")).toBe(false);
    expect(isApexPlatformQname("CustomObject:String")).toBe(false);
  });

  it("classifies stdlib, DML, LWC property/event and duplicate Remote rows", () => {
    const reached = [
      { qualifiedName: "ApexMethod:String.escapeSingleQuotes(1)", hasNode: false },
      { qualifiedName: "ApexMethod:Svc.run(0)", hasNode: true },
      { qualifiedName: "DML:update", hasNode: false },
      { qualifiedName: "LWCProperty:recordId", hasNode: true },
      { qualifiedName: "LWCEvent:click", hasNode: false },
      { qualifiedName: "Remote:Svc", hasNode: false },
      { qualifiedName: "ApexClass:Svc", hasNode: true },
      { qualifiedName: "Remote:External", hasNode: false },
    ];
    const { kept, pseudo } = partitionPseudoEndpoints(reached);
    expect(kept.map((e) => e.qualifiedName)).toEqual([
      "ApexMethod:Svc.run(0)",
      "ApexClass:Svc",
      "Remote:External",
    ]);
    expect(pseudo.map((e) => [e.qualifiedName, e.pseudoKind])).toEqual([
      ["ApexMethod:String.escapeSingleQuotes(1)", "apex-platform"],
      ["DML:update", "dml"],
      ["LWCEvent:click", "lwc-event"],
      ["LWCProperty:recordId", "lwc-property"],
      ["Remote:Svc", "remote-duplicate"],
    ]);
  });

  it("the shared list is the parser's full superset (review I2)", () => {
    for (const t of [
      "RestContext",
      "AuraHandledException",
      "DmlException",
      "OrgLimits",
      "Quiddity",
      "TriggerOperation",
      "Continuation",
      "StubProvider",
      "Datacloud",
      "DataWeave",
      "TxnSecurity",
    ]) {
      expect(APEX_PLATFORM_NAMESPACES.has(t.toLowerCase()), t).toBe(true);
    }
    expect(APEX_PLATFORM_NAMESPACES).toBe(DOMAIN_APEX_PLATFORM_NAMESPACES);
    expect(isApexPlatformQname("ApexMethod:RestContext.request(0)")).toBe(true);
  });

  it("a dangling call on a user class named like a platform class is not pseudo (review M1)", () => {
    const hasClass = (name: string) => name.toLowerCase() === "security";
    expect(
      pseudoEndpointKind("ApexMethod:Security.check(2)", false, new Set(), { hasClass }),
    ).toBeNull();
    expect(pseudoEndpointKind("ApexMethod:System.debug(1)", false, new Set(), { hasClass })).toBe(
      "apex-platform",
    );
    const { pseudo } = partitionPseudoEndpoints(
      [{ qualifiedName: "Remote:Root", hasNode: false }],
      { alsoPresent: ["ApexClass:Root"] },
    );
    expect(pseudo.map((p) => p.pseudoKind)).toEqual(["remote-duplicate"]);
  });

  it("pseudo rows come out sorted by kind then qname (review M7)", () => {
    const { pseudo } = partitionPseudoEndpoints([
      { qualifiedName: "DML:update", hasNode: false },
      { qualifiedName: "ApexMethod:System.debug(1)", hasNode: false },
      { qualifiedName: "DML:insert", hasNode: false },
    ]);
    expect(pseudo.map((p) => p.qualifiedName)).toEqual([
      "ApexMethod:System.debug(1)",
      "DML:insert",
      "DML:update",
    ]);
  });

  it("a platform-named qname that has a node row is not pseudo", () => {
    expect(pseudoEndpointKind("ApexClass:Database", true, new Set())).toBeNull();
  });
});
