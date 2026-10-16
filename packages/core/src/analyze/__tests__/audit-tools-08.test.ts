import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDeadCode } from "../dead-code.js";

// audit tools-08, revised by Batch R / S6 (catalog contract: "test classes do
// count as references"): an unreferenced @isTest class is dead like any other
// node; a class its test references is not dead.
const ORG = asOrgId("org_tools08");

function cls(qname: string, isTest: boolean): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label: "ApexClass",
    attributes: isTest ? { isTest: true } : {},
    sourceHash: asSha256(qname),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

describe("audit tools-08: unreferenced test classes are dead", () => {
  it("lists the unreferenced production class and the unreferenced @isTest class", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([cls("ApexClass:OrphanSvc", false), cls("ApexClass:OrphanSvcTest", true)]);
    const dead = findDeadCode(store, ORG).map((n) => String(n.qualifiedName));
    expect(dead).toContain("ApexClass:OrphanSvc");
    expect(dead).toContain("ApexClass:OrphanSvcTest");
    await store.close();
  });
});

// Batch R / S6: the class a test references is not dead (it is listed apart
// as referenced-only-by-tests); the unreferenced test class is dead.
describe("audit tools-08: a class referenced only by its test is not dead", () => {
  it("lists the test class, not the tested class", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([cls("ApexClass:Svc", false), cls("ApexClass:SvcTest", true)]);
    store.mergeEdges([
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("ApexClass:SvcTest"),
        dstQualifiedName: asQualifiedName("ApexClass:Svc"),
        relType: "REFERENCES",
        attributes: {},
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ]);
    const dead = findDeadCode(store, ORG).map((n) => String(n.qualifiedName));
    expect(dead).not.toContain("ApexClass:Svc");
    expect(dead).toContain("ApexClass:SvcTest");
    await store.close();
  });
});
