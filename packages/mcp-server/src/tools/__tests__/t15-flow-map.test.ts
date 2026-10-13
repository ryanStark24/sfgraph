import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENTRY_LABELS, FLOW_RELS, NOT_FOLLOWED } from "../cross_layer_flow_map.js";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// T15 query I-1 / I-2: the flow map follows the cross-layer rel types its
// description promises, one hop at least from every entry label it accepts,
// and a reached method does not drag in its siblings' callees.

let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

type Data = {
  participants: Array<{ id: string; role?: string }>;
  messages: Array<{ fromId: string; toId: string; label: string }>;
  pseudo: Array<{ id: string; pseudoKind: string }>;
};
const labelOf = (q: string) => q.slice(0, q.indexOf(":"));
function node(q: string): void {
  fix.addNode({ qualifiedName: q, label: labelOf(q) });
}
function edge(src: string, rel: string, dst: string): void {
  for (const q of [src, dst]) node(q);
  fix.addEdge({ srcQualifiedName: src, dstQualifiedName: dst, relType: rel as never });
}
async function map(entry: string): Promise<Data> {
  const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry });
  return r.data as Data;
}
const ids = (d: Data) => d.participants.filter((p) => !p.role).map((p) => p.id);

describe("T15 I-1: the followed rel set is derived from the taxonomy", () => {
  it("every rel type is either followed or excluded with a reason, never both", () => {
    for (const rt of Object.values(REL_TYPES)) {
      const followed = FLOW_RELS.includes(rt);
      const excluded = Object.hasOwn(NOT_FOLLOWED, rt);
      expect(followed !== excluded, rt).toBe(true);
    }
  });

  // One fixture per entry label: the entry's first cross-layer hop (and its
  // container when the label is a container).
  const ENTRY_CASES: Record<string, { entry: string; build: () => void; reach: string }> = {
    LWC: {
      entry: "LWC:e",
      build: () => edge("LWC:e", REL_TYPES.LWC_CALLS_IP, "IntegrationProcedure:Ip_A"),
      reach: "IntegrationProcedure:Ip_A",
    },
    LWCBundle: {
      entry: "LWCBundle:e",
      build: () => {
        edge("LWCBundle:e", REL_TYPES.CONTAINS_COMPONENT, "LWC:e");
        edge("LWC:e", REL_TYPES.EMBEDS_LWC, "LWC:child");
      },
      reach: "LWC:child",
    },
    AuraComponent: {
      entry: "AuraComponent:e",
      build: () => edge("AuraComponent:e", REL_TYPES.EMBEDS_LWC, "LWC:child"),
      reach: "LWC:child",
    },
    ApexPage: {
      entry: "ApexPage:e",
      build: () => edge("ApexPage:e", REL_TYPES.EXTENDS_CONTROLLER, "ApexClass:Ext"),
      reach: "ApexClass:Ext",
    },
    Flow: {
      entry: "Flow:e",
      build: () => {
        edge("Flow:e", REL_TYPES.CONTAINS, "FlowVersion:e-1");
        edge("FlowVersion:e-1", REL_TYPES.FLOW_INVOKES_SUBFLOW, "Flow:sub");
      },
      reach: "Flow:sub",
    },
    ApexClass: {
      entry: "ApexClass:E",
      build: () => {
        edge("ApexClass:E", REL_TYPES.CONTAINS_METHOD, "ApexMethod:E.run(0)");
        edge("ApexMethod:E.run(0)", REL_TYPES.APEX_CALLS_IP, "IntegrationProcedure:Ip_A");
      },
      reach: "IntegrationProcedure:Ip_A",
    },
    ApexTrigger: {
      entry: "ApexTrigger:E",
      build: () => edge("ApexTrigger:E", REL_TYPES.CALLS, "ApexClass:Svc"),
      reach: "ApexClass:Svc",
    },
    OmniScript: {
      entry: "OmniScript:e",
      build: () => edge("OmniScript:e", REL_TYPES.OS_CALLS_IP, "IntegrationProcedure:Ip_A"),
      reach: "IntegrationProcedure:Ip_A",
    },
    OmniProcess: {
      entry: "OmniProcess:e",
      build: () =>
        edge(
          "OmniProcess:e",
          REL_TYPES.OMNI_CALLS_INTEGRATION_PROCEDURE,
          "OmniIntegrationProcedure:Ip_A",
        ),
      reach: "OmniIntegrationProcedure:Ip_A",
    },
    VlocityCard: {
      entry: "VlocityCard:e",
      build: () => edge("VlocityCard:e", REL_TYPES.VC_USES_DR, "DataRaptor:Dr"),
      reach: "DataRaptor:Dr",
    },
    OmniUiCard: {
      entry: "OmniUiCard:e",
      build: () => edge("OmniUiCard:e", REL_TYPES.OMNI_USES_DATA_TRANSFORM, "OmniDataTransform:Dt"),
      reach: "OmniDataTransform:Dt",
    },
    IntegrationProcedure: {
      entry: "IntegrationProcedure:e",
      build: () => {
        edge("IntegrationProcedure:e", REL_TYPES.IP_CALLS_DR, "DataRaptor:Dr");
        edge("DataRaptor:Dr", REL_TYPES.DR_READS_FIELD, "CustomField:Account.X__c");
      },
      reach: "CustomField:Account.X__c",
    },
    OmniIntegrationProcedure: {
      entry: "OmniIntegrationProcedure:e",
      build: () =>
        edge(
          "OmniIntegrationProcedure:e",
          REL_TYPES.OMNI_CALLS_DATA_TRANSFORM,
          "OmniDataTransform:Dt",
        ),
      reach: "OmniDataTransform:Dt",
    },
  };

  it("there is a case for every entry label", () => {
    expect(Object.keys(ENTRY_CASES).sort()).toEqual([...ENTRY_LABELS].sort());
  });

  for (const [label, c] of Object.entries(ENTRY_CASES)) {
    it(`${label}: the entry follows at least one cross-layer hop`, async () => {
      c.build();
      const d = await map(c.entry);
      expect(d.messages.length).toBeGreaterThan(0);
      expect(ids(d)).toContain(c.reach);
    });
  }

  it("a bare name of an OmniStudio entry suggests its qname", async () => {
    node("OmniScript:Order_Flow");
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "Order_Flow" });
    expect((r.data as { candidates: string[] }).candidates).toEqual(["OmniScript:Order_Flow"]);
  });

  it("Apex writes, Flow record operations and remote actions are followed", async () => {
    edge("LWC:e", REL_TYPES.IMPORTS_APEX, "ApexMethod:Ctrl.save(1)");
    edge("ApexClass:Ctrl", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Ctrl.save(1)");
    edge("ApexMethod:Ctrl.save(1)", REL_TYPES.EXECUTES_DML, "DML:update");
    edge("ApexMethod:Ctrl.save(1)", REL_TYPES.FLOW_INVOKES_SUBFLOW, "Flow:never");
    edge("ApexMethod:Ctrl.save(1)", REL_TYPES.CALLS, "ApexMethod:Svc.go(0)");
    edge("ApexClass:Svc", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Svc.go(0)");
    edge("ApexMethod:Svc.go(0)", REL_TYPES.APEX_CALLS_IP, "IntegrationProcedure:Ip_A");
    edge("IntegrationProcedure:Ip_A", REL_TYPES.IP_INVOKES_REMOTE, "Remote:RemoteSvc");
    edge("Remote:RemoteSvc", REL_TYPES.VLOCITY_INVOKES_APEX, "ApexClass:RemoteSvc");
    edge("Flow:f", REL_TYPES.REFERENCES_OBJECT, "CustomObject:Account");
    const d = await map("LWC:e");
    expect(d.pseudo).toContainEqual({ id: "DML:update", pseudoKind: "dml" });
    expect(ids(d)).toEqual(
      expect.arrayContaining(["ApexClass:Ctrl", "ApexClass:Svc", "IntegrationProcedure:Ip_A"]),
    );
    const f = await map("Flow:f");
    expect(ids(f)).toContain("CustomObject:Account");
  });

  it("security grants and type hierarchy are not followed", async () => {
    edge("ApexClass:E", REL_TYPES.EXTENDS, "ApexClass:Base");
    edge("ApexClass:E", REL_TYPES.GRANTS_APEX_ACCESS, "ApexClass:Other");
    edge("ApexClass:E", REL_TYPES.CALLS, "ApexClass:Real");
    expect(ids(await map("ApexClass:E"))).toEqual(["ApexClass:Real"]);
  });
});

describe("T15 I-2: a reached method does not expand its class's other methods", () => {
  beforeEach(() => {
    edge("ApexClass:Ctrl", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Ctrl.a(0)");
    edge("ApexClass:Ctrl", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Ctrl.b(0)");
    edge("ApexMethod:Ctrl.a(0)", REL_TYPES.CALLS, "ApexClass:OnPath");
    edge("ApexMethod:Ctrl.b(0)", REL_TYPES.CALLS, "ApexClass:Sibling");
    // A class-level edge (a field initializer) still belongs to every method.
    edge("ApexClass:Ctrl", REL_TYPES.READS_FIELD, "CustomField:Account.Init__c");
    edge("LWC:e", REL_TYPES.IMPORTS_APEX, "ApexMethod:Ctrl.a(0)");
  });

  it("from an LWC importing one method: that method's callees and class-level edges only", async () => {
    const got = ids(await map("LWC:e"));
    expect(got).toEqual(
      expect.arrayContaining(["ApexClass:Ctrl", "ApexClass:OnPath", "CustomField:Account.Init__c"]),
    );
    expect(got).not.toContain("ApexClass:Sibling");
  });

  it("lists the data a sibling method reads or writes, without following its calls (cycle 3 T7)", async () => {
    node("CustomObject:Acme_Order__c");
    edge("ApexMethod:Ctrl.b(0)", REL_TYPES.READS_FIELD, "CustomField:Acme_Order__c.Status__c");
    edge("ApexMethod:Ctrl.b(0)", REL_TYPES.EXECUTES_DML, "CustomObject:Acme_Invoice__c");
    edge("ApexMethod:Ctrl.b(0)", REL_TYPES.CALLS, "ApexMethod:Sibling.run(0)");
    edge("ApexMethod:Sibling.run(0)", REL_TYPES.READS_FIELD, "CustomField:Acme_Order__c.Total__c");
    const got = ids(await map("LWC:e"));
    expect(got).toEqual(
      expect.arrayContaining([
        "CustomField:Acme_Order__c.Status__c",
        "CustomObject:Acme_Order__c",
        "CustomObject:Acme_Invoice__c",
      ]),
    );
    expect(got).not.toContain("ApexClass:Sibling");
    expect(got).not.toContain("CustomField:Acme_Order__c.Total__c");
  });

  it("a constant or enum read does not list the other methods' data (T7 review I-1)", async () => {
    node("CustomObject:Acme_X__c");
    edge("ApexClass:AcmeConsts", REL_TYPES.CONTAINS_METHOD, "ApexMethod:AcmeConsts.load(0)");
    edge("ApexMethod:AcmeConsts.load(0)", REL_TYPES.READS_FIELD, "CustomField:Acme_X__c.F__c");
    fix.addEdge({
      srcQualifiedName: "ApexMethod:Ctrl.a(0)",
      dstQualifiedName: "ApexClass:AcmeConsts",
      relType: REL_TYPES.REFERENCES as never,
      attributes: { via: "static-member" },
    } as never);
    const got = ids(await map("LWC:e"));
    expect(got).toContain("ApexClass:AcmeConsts");
    expect(got).not.toContain("CustomField:Acme_X__c.F__c");
    expect(got).not.toContain("CustomObject:Acme_X__c");
  });

  it("a constant read first, a method reached later: the other methods' data is listed", async () => {
    edge("ApexClass:AcmeConsts", REL_TYPES.CONTAINS_METHOD, "ApexMethod:AcmeConsts.load(0)");
    edge("ApexClass:AcmeConsts", REL_TYPES.CONTAINS_METHOD, "ApexMethod:AcmeConsts.run(0)");
    edge("ApexMethod:AcmeConsts.load(0)", REL_TYPES.READS_FIELD, "CustomField:Acme_X__c.F__c");
    fix.addEdge({
      srcQualifiedName: "ApexClass:Ctrl",
      dstQualifiedName: "ApexClass:AcmeConsts",
      relType: REL_TYPES.REFERENCES as never,
      attributes: { via: "static-member" },
    } as never);
    edge("ApexClass:OnPath", REL_TYPES.CALLS, "ApexMethod:AcmeConsts.run(0)");
    expect(ids(await map("LWC:e"))).toContain("CustomField:Acme_X__c.F__c");
  });

  it("an ApexMethod entry does not list its own class's other methods' data", async () => {
    edge("ApexClass:Ctrl", REL_TYPES.CONTAINS_METHOD, "ApexMethod:Ctrl.c(0)");
    edge("ApexMethod:Ctrl.a(0)", REL_TYPES.CALLS, "ApexMethod:Ctrl.c(0)");
    edge("ApexMethod:Ctrl.c(0)", REL_TYPES.READS_FIELD, "CustomField:Acme_Order__c.Total__c");
    edge("ApexMethod:Ctrl.b(0)", REL_TYPES.READS_FIELD, "CustomField:Acme_Order__c.Status__c");
    const got = ids(await map("ApexMethod:Ctrl.a(0)"));
    // The called method is on the path; the uncalled one is not.
    expect(got).toContain("CustomField:Acme_Order__c.Total__c");
    expect(got).not.toContain("CustomField:Acme_Order__c.Status__c");
  });

  it("caps the other methods' data list and says so", async () => {
    for (let i = 0; i < 130; i++)
      edge("ApexMethod:Ctrl.b(0)", REL_TYPES.READS_FIELD, `CustomField:Acme_Order__c.F${i}__c`);
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "LWC:e" });
    const d = r.data as Data & { otherMethodsDataTruncated?: boolean };
    const listed = ids(d).filter((q) => q.startsWith("CustomField:Acme_Order__c.F"));
    expect(listed.length).toBe(100);
    expect(d.otherMethodsDataTruncated).toBe(true);
    expect(r.markdown).toContain("_truncated_ — the data used by other methods");
    expect(r.markdown).toContain("not all the data used by their other methods is shown");
  });

  it("the class as the entry still expands every method", async () => {
    const got = ids(await map("ApexClass:Ctrl"));
    expect(got).toEqual(expect.arrayContaining(["ApexClass:OnPath", "ApexClass:Sibling"]));
  });

  it("a class reached directly (a VF controller) expands every method", async () => {
    edge("ApexPage:p", REL_TYPES.CONTROLLED_BY, "ApexClass:Ctrl");
    const got = ids(await map("ApexPage:p"));
    expect(got).toEqual(expect.arrayContaining(["ApexClass:OnPath", "ApexClass:Sibling"]));
  });
});
