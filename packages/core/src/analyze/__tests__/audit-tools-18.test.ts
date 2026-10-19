import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { realIncomingRefCount } from "../dead-code.js";

// audit tools-18: the method's own CONTAINS_METHOD edge from its class is
// structure, not usage, so an uncalled method has zero real references.
const ORG = asOrgId("org_tools18");

function node(label: string, qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(qname),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

describe("audit tools-18: CONTAINS_METHOD is not a real reference", () => {
  it("an ApexMethod with only its containment edge has 0 real incoming refs", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      node("ApexClass", "ApexClass:Svc"),
      node("ApexMethod", "ApexMethod:Svc.unused(0)"),
    ]);
    const e: EdgeFact = {
      orgId: ORG,
      srcQualifiedName: asQualifiedName("ApexClass:Svc"),
      dstQualifiedName: asQualifiedName("ApexMethod:Svc.unused(0)"),
      relType: "CONTAINS_METHOD" as EdgeFact["relType"],
      attributes: {},
      firstSeenAt: 1,
      lastSeenAt: 1,
    };
    store.mergeEdges([e]);
    expect(realIncomingRefCount(store, ORG, asQualifiedName("ApexMethod:Svc.unused(0)"))).toBe(0);
    await store.close();
  });
});
