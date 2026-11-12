import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../../domain/index.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { GENERIC_REL_TYPES, resolveGenericReferences } from "../generic-ref-resolver.js";
import { OpaqueNodeParser } from "../opaque-node-parser.js";

const ORG = asOrgId("org_generic");

async function store() {
  const s = new SqliteGraphStore({ dbPath: ":memory:" });
  await s.init();
  s.upsertOrg({
    id: ORG,
    alias: "t",
    instanceUrl: "https://example.test",
    apiVersion: "60.0",
    createdAt: Date.now(),
  });
  return s;
}

function node(label: string, qname: string, attributes: Record<string, unknown> = {}): NodeFact {
  const ts = Date.now();
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes,
    sourceHash: asSha256(qname),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}

async function opaque(type: string, name: string, raw: string): Promise<NodeFact> {
  const r = await new OpaqueNodeParser().parse(
    { metadataType: type, name, raw },
    { ...makeTestCtx(), orgId: ORG },
  );
  return { ...r.nodes[0]!, orgId: ORG };
}

describe("generic reference resolver", () => {
  it("emits edges only for candidates that match a real node, with via and heuristic confidence", async () => {
    const s = await store();
    const thing = await opaque(
      "AgentThing",
      "T1",
      JSON.stringify({
        objectName: "Case",
        steps: [
          { apexClassName: "TierService", flowName: "Escalate_Case" },
          { objectName: "Ghost__c", apexClassName: "NoSuchClass" },
        ],
        field: "Status",
        invocationTarget: "Escalate_Case",
      }),
    );
    s.mergeNodes([
      thing,
      node("CustomObject", "CustomObject:Case"),
      node("CustomField", "CustomField:Case.Status"),
      node("ApexClass", "ApexClass:TierService"),
      node("Flow", "Flow:Escalate_Case"),
    ]);
    const res = resolveGenericReferences(s, { orgId: ORG, ctx: makeTestCtx() });
    expect(res.scanned).toBe(1);
    expect(res.withEdgesByLabel).toEqual({ AgentThing: 1 });
    expect(res.dropped).toBeGreaterThan(0);

    const out = (rel: string) =>
      s.listEdgesFrom(ORG, asQualifiedName("AgentThing:T1"), rel as never);
    expect(out("GENERIC_REFERENCES_APEX").map((e) => String(e.dstQualifiedName))).toEqual([
      "ApexClass:TierService",
    ]);
    expect(out("GENERIC_REFERENCES_FLOW").map((e) => String(e.dstQualifiedName))).toEqual([
      "Flow:Escalate_Case",
    ]);
    expect(out("GENERIC_REFERENCES_OBJECT").map((e) => String(e.dstQualifiedName))).toEqual([
      "CustomObject:Case",
    ]);
    expect(out("GENERIC_REFERENCES_FIELD").map((e) => String(e.dstQualifiedName))).toEqual([
      "CustomField:Case.Status",
    ]);
    const apexEdge = out("GENERIC_REFERENCES_APEX")[0]!;
    expect(apexEdge.attributes.via).toBe("steps/apexClassName");
    expect(apexEdge.attributes.confidence).toBe("heuristic");

    // nothing dangles: no edge to Ghost__c / NoSuchClass
    expect(s.listDanglingEdges(ORG).length).toBe(0);
    expect(s.countEdges(ORG)).toBe(4);
  });

  it("resolves a `name` candidate to whichever kind of node exists, case-insensitively", async () => {
    const s = await store();
    s.mergeNodes([
      await opaque("X", "a", JSON.stringify({ actionName: "billinghandler" })),
      node("ApexClass", "ApexClass:BillingHandler"),
    ]);
    resolveGenericReferences(s, { orgId: ORG, ctx: makeTestCtx() });
    const e = s.listEdgesFrom(ORG, asQualifiedName("X:a"), "GENERIC_REFERENCES_APEX" as never);
    expect(e.map((x) => String(x.dstQualifiedName))).toEqual(["ApexClass:BillingHandler"]);
  });

  it("reconciles: an edge whose target disappeared is removed on the next run", async () => {
    const s = await store();
    s.mergeNodes([
      await opaque("X", "a", JSON.stringify({ objectName: "Gone__c" })),
      node("CustomObject", "CustomObject:Gone__c"),
    ]);
    expect(resolveGenericReferences(s, { orgId: ORG, ctx: makeTestCtx() }).edgesEmitted).toBe(1);
    s.deleteNode(ORG, asQualifiedName("CustomObject:Gone__c"));
    const again = resolveGenericReferences(s, { orgId: ORG, ctx: makeTestCtx() });
    expect(again.removed).toBe(1);
    expect(again.edgesEmitted).toBe(0);
    for (const rel of GENERIC_REL_TYPES) {
      expect(s.listEdgesFrom(ORG, asQualifiedName("X:a"), rel).length).toBe(0);
    }
  });

  it("does nothing for nodes without candidates, and the parser keeps no body", async () => {
    const s = await store();
    const plain = await opaque("X", "p", "<X><label>nothing here</label></X>");
    expect(plain.attributes.genericRefs).toBeUndefined();
    expect(plain.attributes.rawSize).toBeGreaterThan(0);
    s.mergeNodes([plain]);
    const res = resolveGenericReferences(s, { orgId: ORG, ctx: makeTestCtx() });
    expect(res.scanned).toBe(0);
    expect(JSON.stringify(plain.attributes)).not.toContain("nothing here");
  });

  it("types with a specific parser keep their own output (scanner is only the opaque path)", async () => {
    const { GenericOpaqueParser } = await import("../../rules/_generic-opaque.js");
    const r = await new GenericOpaqueParser().parse(
      { metadataType: "Y", name: "n", raw: JSON.stringify({ objectName: "Case" }) },
      makeTestCtx(),
    );
    expect(r.edges).toEqual([]); // the parser only records candidates; edges come from the resolver
  });

  it("Vlocity DataPack scanning still emits its REFERENCES edges", async () => {
    const r = await new OpaqueNodeParser().parse(
      {
        metadataType: "VlocityAction",
        name: "A",
        scanDataPackRefs: true,
        raw: JSON.stringify({ DRBundleName: "MyBundle" }),
      },
      makeTestCtx(),
    );
    expect(r.edges.some((e) => String(e.dstQualifiedName) === "DataRaptor:MyBundle")).toBe(true);
  });
});
