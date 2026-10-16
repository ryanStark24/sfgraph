import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { resolveApexReferences } from "../../parsers/apex/ref-resolver.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { apexRefNoWorkResult } from "../resolver-gates.js";

/**
 * The apex-ref gate may only answer for the resolver when the resolver would
 * change nothing; its answer must be the resolver's own result object.
 */

const ORG = asOrgId("org_gate");
const ctx = {
  orgId: String(ORG),
  parseTimestamp: new Date(1000).toISOString(),
  namespace: null,
  sourceUri: "test://gate",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
} as never;

function node(label: string, q: string, attributes: Record<string, unknown> = {}): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(q),
    label,
    attributes,
    sourceHash: asSha256(q),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(rel: string, src: string, dst: string, attributes = {}): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes,
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

function edgeRows(store: SqliteGraphStore): unknown[] {
  const out: unknown[] = [];
  for (const [rel, tbl] of [...store.getEdgeRelTables()].sort()) {
    out.push(rel, store.db.prepare(`SELECT * FROM ${tbl} ORDER BY src_qname, dst_qname`).all());
  }
  return out;
}

let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.mergeNodes([
    node("CustomObject", "CustomObject:Account"),
    node("CustomObject", "CustomObject:Contact"),
    node("CustomField", "CustomField:Contact.AccountId", {
      referenceTo: ["Account"],
      type: "Lookup",
    }),
    node("CustomField", "CustomField:Account.Name"),
    node("ApexClass", "ApexClass:Svc", { dynamicSoqlFieldsSkipped: 2 }),
    node("ApexMethod", "ApexMethod:Svc.run(0)", { dynamicSoqlFieldsSkipped: 3, note: "x" }),
    node("ApexTrigger", "ApexTrigger:T", { dynamicSoqlFieldsSkipped: "4" }),
  ]);
  store.mergeEdges([
    edge("DEFINES_FIELD", "CustomObject:Contact", "CustomField:Contact.AccountId"),
    edge("DEFINES_FIELD", "CustomObject:Account", "CustomField:Account.Name"),
    edge("READS_FIELD", "ApexMethod:Svc.run(0)", "CustomField:Account.Name"),
  ]);
});
afterEach(async () => {
  await store.close();
});

describe("apexRefNoWorkResult", () => {
  it("answers exactly what the resolver returns when it has nothing to do", () => {
    const gate = apexRefNoWorkResult(store, ORG);
    expect(gate).not.toBeNull();
    const before = edgeRows(store);
    const real = resolveApexReferences(store, ORG, ctx);
    expect(gate).toEqual(real);
    expect(real.dynamicSoqlFieldsSkipped).toBe(5);
    expect(edgeRows(store)).toEqual(before);
  });

  it("lets the resolver run when a node carries an input", () => {
    store.mergeNodes([
      node("ApexMethod", "ApexMethod:Svc.load(0)", {
        apexRelationshipPaths: [{ object: "Contact", path: "Account.Name", rel: "READS_FIELD" }],
      }),
    ]);
    expect(apexRefNoWorkResult(store, ORG)).toBeNull();
    expect(resolveApexReferences(store, ORG, ctx).edgesEmitted).toBeGreaterThan(0);
  });

  it("lets the resolver run when it has earlier output to prune", () => {
    store.mergeNodes([
      node("ApexMethod", "ApexMethod:Svc.load(0)", {
        apexRelationshipPaths: [{ object: "Contact", path: "Account.Name", rel: "READS_FIELD" }],
      }),
    ]);
    resolveApexReferences(store, ORG, ctx);
    // The input goes away; its resolver edges stay until the resolver prunes them.
    store.mergeNodes([
      { ...node("ApexMethod", "ApexMethod:Svc.load(0)"), sourceHash: asSha256("v2") },
    ]);
    expect(apexRefNoWorkResult(store, ORG)).toBeNull();
    const before = edgeRows(store);
    resolveApexReferences(store, ORG, ctx);
    expect(edgeRows(store)).not.toEqual(before);
    // Now nothing is left: the gate answers again, and matches.
    const gate = apexRefNoWorkResult(store, ORG);
    expect(gate).toEqual(resolveApexReferences(store, ORG, ctx));
  });

  it("lets the resolver run for each input attribute", () => {
    for (const [label, attr] of [
      ["ApexClass", "apexChildRelationships"],
      ["TestMethod", "apexFieldNameLiterals"],
      ["ApexClass", "testTargetCandidates"],
      ["ApexTrigger", "apexRelationshipPaths"],
    ] as const) {
      const q = `${label}:Probe_${attr}`;
      store.mergeNodes([node(label, q, { [attr]: [] })]);
      expect(apexRefNoWorkResult(store, ORG)).toBeNull();
      store.deleteNode(ORG, asQualifiedName(q));
      expect(apexRefNoWorkResult(store, ORG)).not.toBeNull();
    }
  });
});
