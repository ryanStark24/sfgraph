import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { EdgeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { auditDanglingEdges, isPlatformBuiltinRef, namespacesIn } from "../audit-graph.js";

// audit dangling-01: out-of-repo targets (managed-namespace metadata, standard
// fields on custom objects, platform static calls) are expected, not
// "unexpected" dangling edges.
const ORG = asOrgId("org_dangling01");

function edge(rel: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName("ApexMethod:Foo.bar(0)"),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

describe("audit dangling-01: expected out-of-repo refs are platform refs", () => {
  it("classifies managed-namespace, std-field-on-custom-object and System calls as expected", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      {
        orgId: ORG,
        qualifiedName: asQualifiedName("ApexMethod:Foo.bar(0)"),
        label: "ApexMethod",
        attributes: {},
        sourceHash: asSha256("h"),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
    ]);
    store.mergeEdges([
      edge("GRANTS_APEX_ACCESS", "ApexClass:vlocity_cmt__DRGlobal"),
      edge("EXECUTES_SOQL", "CustomObject:vlocity_cmt__DataStore__c"),
      edge("GRANTS_FIELD_ACCESS", "CustomField:vlocity_cmt__Party__c.vlocity_cmt__Status__c"),
      edge("READS_FIELD", "CustomField:Service_Request__c.Id"),
      edge("READS_FIELD", "CustomField:Service_Request__c.Name"),
      edge("CALLS", "ApexMethod:System.assertEquals(3)"),
    ]);
    const r = auditDanglingEdges(store, ORG);
    expect(r.danglingCount).toBe(6);
    expect(r.unexpectedCount).toBe(0);
    await store.close();
  });
});

describe("audit dangling-01: classifier boundaries", () => {
  it("keeps real gaps unexpected and managed/platform targets expected", () => {
    for (const dst of [
      "CustomField:Account.My_Field__c",
      "CustomField:My_Obj__c.Score__c",
      "CustomObject:Missing__c",
      "ApexClass:AccountTriggerHandler",
      "ApexMethod:AccountTriggerHandler.run(0)",
      "ApexPage:MyPage",
      "CustomField:.vlocity_cmt__IsActive__c",
      "CustomField:Account.",
      "CustomObject:",
    ]) {
      expect(isPlatformBuiltinRef(dst), dst).toBe(false);
    }
    for (const dst of [
      "CustomTab:standard-Account",
      "CustomField:Account.Industry",
      "CustomObject:Account",
      "ApexPage:pi__Engage",
      "CustomTab:trailheadapp__Badge__c",
      "ApexMethod:vlocity_cmt__DRGlobal.process(2)",
      "ApexMethod:Database.insert(2)",
      "ApexClass:System",
      "Remote:%vlocity_namespace%__Svc.run",
    ]) {
      expect(isPlatformBuiltinRef(dst), dst).toBe(true);
    }
  });
});

// Review M-3: remaining expected classes, and the custom-object field rule
// tightened to the real standard field names.
describe("audit dangling-01: review M-3 classifier gaps", () => {
  it("only real standard field names are expected on custom objects", () => {
    for (const f of [
      "Id",
      "Name",
      "OwnerId",
      "CreatedDate",
      "CreatedById",
      "LastModifiedDate",
      "LastModifiedById",
      "SystemModstamp",
      "IsDeleted",
      "RecordTypeId",
      "CurrencyIsoCode",
      "ownerid",
    ]) {
      expect(isPlatformBuiltinRef(`CustomField:My_Obj__c.${f}`), f).toBe(true);
    }
    // A parser that dropped `__c` must not be hidden.
    expect(isPlatformBuiltinRef("CustomField:My_Obj__c.Score")).toBe(false);
    expect(isPlatformBuiltinRef("CustomField:My_Obj__c.Status")).toBe(false);
    // Custom metadata types carry their own standard fields.
    expect(isPlatformBuiltinRef("CustomField:Setting__mdt.DeveloperName")).toBe(true);
    expect(isPlatformBuiltinRef("CustomField:Setting__mdt.Threshold")).toBe(false);
    // Standard objects keep every unsuffixed field.
    expect(isPlatformBuiltinRef("CustomField:Account.Industry")).toBe(true);
  });

  it("System.Assert, the namespace placeholder in dotted form and DOM events are expected", () => {
    expect(isPlatformBuiltinRef("ApexMethod:Assert.areNotEqual(3)")).toBe(true);
    expect(isPlatformBuiltinRef("ApexClass:Assert")).toBe(true);
    expect(isPlatformBuiltinRef("Remote:%vlocity_namespace%.CPQAppHandler")).toBe(true);
    for (const evt of ["click", "mousedown", "change", "keyup", "focus", "blur", "submit"]) {
      expect(isPlatformBuiltinRef(`LWCEvent:${evt}`), evt).toBe(true);
    }
    expect(isPlatformBuiltinRef("LWCEvent:recordselected")).toBe(false);
    expect(isPlatformBuiltinRef("LWC:myPanel")).toBe(false);
  });

  it("dotted `ns.X` is expected for a namespace the org's refs use, not for any dotted name", () => {
    const ns = new Set(["vlocity_cmt"]);
    expect(isPlatformBuiltinRef("ApexInterface:vlocity_cmt.VlocityOpenInterface", ns)).toBe(true);
    expect(isPlatformBuiltinRef("ApexClass:vlocity_cmt.DocTemplateMappingAbstractClass", ns)).toBe(
      true,
    );
    expect(isPlatformBuiltinRef("ApexMethod:vlocity_cmt.DRGlobal.process(2)", ns)).toBe(true);
    // Unknown head: an inner class `Outer.Inner` is a real gap.
    expect(isPlatformBuiltinRef("ApexClass:Outer.Inner", ns)).toBe(false);
    expect(isPlatformBuiltinRef("ApexInterface:vlocity_cmt.VlocityOpenInterface")).toBe(false);
  });

  it("the audit learns namespaces, uses the lightning- tag, and keeps IS_TEST_FOR gaps", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    const tagged = (dst: string, tag: string): EdgeFact => ({
      ...edge("EMBEDS_LWC", dst),
      attributes: { tag },
    });
    store.mergeEdges([
      // Teaches the audit that `vlocity_cmt` is a namespace.
      edge("READS_FIELD", "CustomField:vlocity_cmt__Party__c.vlocity_cmt__Status__c"),
      edge("IMPLEMENTS", "ApexInterface:vlocity_cmt.VlocityOpenInterface"),
      tagged("LWC:button", "lightning-button"),
      tagged("LWC:datatable", "lightning-datatable"),
      // Expected
      edge("LISTENS_TO_EVENT", "LWCEvent:click"),
      // Unexpected: a custom child that is missing, and a bogus test target.
      tagged("LWC:panel", "c-panel"),
      edge("IS_TEST_FOR", "ApexClass:Test"),
    ]);
    const r = auditDanglingEdges(store, ORG);
    expect(r.danglingCount).toBe(7);
    expect(r.unexpectedCount).toBe(2);
    expect(
      r.sample
        .slice(0, 2)
        .map((s) => s.dst)
        .sort(),
    ).toEqual(["ApexClass:Test", "LWC:panel"]);
    await store.close();
  });
});

describe("audit dangling-01: review round 2 (m-2, m-3)", () => {
  it("namespaces are learned only from `ns__Name__<suffix>`, never from field or relationship suffixes", () => {
    expect([
      ...namespacesIn([
        "CustomField:Quote.CaseId__r",
        "CustomField:Order.Case__r",
        "CustomField:Account.Region_Name__cy",
        "CustomObject:Foo__History",
        "CustomObject:Foo__Share",
        "CustomField:Account.__cy",
        "CustomObject:Order_Case__ChangeEvent",
        "CustomField:My_Obj__c.Line_Item__r",
      ]),
    ]).toEqual([]);
    expect(
      [
        ...namespacesIn([
          "CustomField:vlocity_cmt__Party__c.vlocity_cmt__Status__c",
          "CustomField:Account.acme__Parent__r",
          "CustomObject:ext__Order__x",
          "CustomObject:cfg__Setting__mdt",
        ]),
      ].sort(),
    ).toEqual(["acme", "cfg", "ext", "vlocity_cmt"]);
  });

  it("`CaseId__r` does not suppress `ApexMethod:CaseId.add(1)`", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeEdges([
      edge("READS_FIELD", "CustomField:Quote.CaseId__r"),
      edge("CALLS", "ApexMethod:CaseId.add(1)"),
    ]);
    const r = auditDanglingEdges(store, ORG);
    expect(r.sample.map((s) => s.dst)).toContain("ApexMethod:CaseId.add(1)");
    expect(r.unexpectedCount).toBe(2);
    await store.close();
  });

  it("a single-segment relationship or derived name is not a managed name", () => {
    expect(isPlatformBuiltinRef("CustomField:Quote.CaseId__r")).toBe(false);
    expect(isPlatformBuiltinRef("CustomObject:Foo__History")).toBe(false);
    expect(isPlatformBuiltinRef("CustomField:Account.Region_Name__cy")).toBe(false);
    // Real managed names stay expected.
    expect(isPlatformBuiltinRef("CustomField:Account.acme__Parent__r")).toBe(true);
    expect(isPlatformBuiltinRef("CustomObject:vlocity_cmt__Party__c")).toBe(true);
    expect(isPlatformBuiltinRef("DataRaptor:vlocity_cmt__Extract")).toBe(true);
  });

  it("__mdt accepts only its own standard fields", () => {
    for (const f of [
      "DeveloperName",
      "MasterLabel",
      "Label",
      "NamespacePrefix",
      "QualifiedApiName",
      "Language",
      "Id",
    ]) {
      expect(isPlatformBuiltinRef(`CustomField:Setting__mdt.${f}`), f).toBe(true);
    }
    // Amended ruling: custom metadata records carry the system audit fields.
    for (const f of [
      "CreatedById",
      "CreatedDate",
      "LastModifiedById",
      "LastModifiedDate",
      "SystemModstamp",
    ]) {
      expect(isPlatformBuiltinRef(`CustomField:Setting__mdt.${f}`), f).toBe(true);
    }
    expect(isPlatformBuiltinRef("CustomField:Plan_Setting__mdt.LastModifiedById")).toBe(true);
    for (const f of ["OwnerId", "RecordTypeId", "Name"]) {
      expect(isPlatformBuiltinRef(`CustomField:Setting__mdt.${f}`), f).toBe(false);
    }
  });

  it("SetupOwnerId is expected only on an object known to be a custom setting", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      {
        orgId: ORG,
        qualifiedName: asQualifiedName("CustomObject:Hier_Setting__c"),
        label: "CustomObject",
        attributes: { apiName: "Hier_Setting__c", customSettingsType: "Hierarchy" },
        sourceHash: asSha256("s"),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
      {
        orgId: ORG,
        qualifiedName: asQualifiedName("CustomObject:Plain__c"),
        label: "CustomObject",
        attributes: { apiName: "Plain__c" },
        sourceHash: asSha256("p"),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      },
    ]);
    store.mergeEdges([
      edge("READS_FIELD", "CustomField:Hier_Setting__c.SetupOwnerId"),
      edge("READS_FIELD", "CustomField:Plain__c.SetupOwnerId"),
      edge("READS_FIELD", "CustomField:Unknown__c.SetupOwnerId"),
    ]);
    const r = auditDanglingEdges(store, ORG);
    expect(r.unexpectedCount).toBe(2);
    expect(
      r.sample
        .slice(0, 2)
        .map((s) => s.dst)
        .sort(),
    ).toEqual(["CustomField:Plain__c.SetupOwnerId", "CustomField:Unknown__c.SetupOwnerId"]);
    expect(isPlatformBuiltinRef("CustomField:Hier_Setting__c.SetupOwnerId")).toBe(false);
    await store.close();
  });
});

describe("audit dangling-01: review round 2, derived objects", () => {
  it("a derived object `Foo__History` is not a standard object", () => {
    expect(isPlatformBuiltinRef("CustomField:Foo__History.Industry")).toBe(false);
    expect(isPlatformBuiltinRef("CustomField:Foo__History.CreatedDate")).toBe(true);
  });
});
