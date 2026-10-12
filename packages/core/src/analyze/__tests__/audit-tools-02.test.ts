import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import {
  deadCodeCandidates,
  findDeadCode,
  realIncomingRefCount,
  scoreDeadCode,
} from "../dead-code.js";

// audit tools-02: a class whose methods are called/imported is not dead code.
const ORG = asOrgId("org_tools02");

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
function edge(rel: string, src: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

describe("audit tools-02: method-level references keep a class alive", () => {
  it("does not report a class as dead when an LWC imports one of its methods", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      node("ApexClass", "ApexClass:UsedCtrl"),
      node("ApexMethod", "ApexMethod:UsedCtrl.load(0)"),
      node("LWC", "LWC:panel"),
    ]);
    store.mergeEdges([
      edge("CONTAINS_METHOD", "ApexClass:UsedCtrl", "ApexMethod:UsedCtrl.load(0)"),
      edge("IMPORTS_APEX", "LWC:panel", "ApexMethod:UsedCtrl.load(0)"),
      // keep the LWC itself alive so only the class is in question
      edge("REFERENCES", "FlexiPage:Home", "LWC:panel"),
    ]);
    const dead = findDeadCode(store, ORG).map((n) => String(n.qualifiedName));
    expect(dead).not.toContain("ApexClass:UsedCtrl");
    await store.close();
  });
});

// Batch R / S6 (replaces the M-8 ruling): references from test code count as
// references, so a class used only by tests is not dead; it is listed apart
// (kind referenced-only-by-tests, reason "referenced_only_by_tests").
describe("audit tools-02: test-only references are listed apart from dead code", () => {
  function testNode(label: string, qname: string): NodeFact {
    return { ...node(label, qname), attributes: { isTest: true } };
  }

  it("reports classes referenced only by test classes or test methods", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      node("ApexClass", "ApexClass:OnlyTested"),
      node("ApexMethod", "ApexMethod:OnlyTested.run(0)"),
      node("ApexClass", "ApexClass:HelperOnlyTested"),
      node("ApexClass", "ApexClass:Used"),
      node("ApexMethod", "ApexMethod:Used.run(0)"),
      testNode("ApexClass", "ApexClass:OnlyTestedTest"),
      testNode("TestMethod", "ApexMethod:OnlyTestedTest.go(0)"),
      // Non-static helper in a test class: not tagged, its class is.
      node("ApexMethod", "ApexMethod:OnlyTestedTest.helper(0)"),
      node("ApexClass", "ApexClass:Prod"),
      node("ApexMethod", "ApexMethod:Prod.go(0)"),
    ]);
    store.mergeEdges([
      edge("CONTAINS_METHOD", "ApexClass:OnlyTested", "ApexMethod:OnlyTested.run(0)"),
      edge("CONTAINS_METHOD", "ApexClass:Used", "ApexMethod:Used.run(0)"),
      edge("CONTAINS_METHOD", "ApexClass:OnlyTestedTest", "ApexMethod:OnlyTestedTest.go(0)"),
      edge("CONTAINS_METHOD", "ApexClass:OnlyTestedTest", "ApexMethod:OnlyTestedTest.helper(0)"),
      edge("CONTAINS_METHOD", "ApexClass:Prod", "ApexMethod:Prod.go(0)"),
      edge("IS_TEST_FOR", "ApexClass:OnlyTestedTest", "ApexClass:OnlyTested"),
      edge("CALLS", "ApexMethod:OnlyTestedTest.go(0)", "ApexMethod:OnlyTested.run(0)"),
      edge("REFERENCES", "ApexMethod:OnlyTestedTest.helper(0)", "ApexClass:HelperOnlyTested"),
      // Used by a test AND by production code: live.
      edge("CALLS", "ApexMethod:OnlyTestedTest.go(0)", "ApexMethod:Used.run(0)"),
      edge("CALLS", "ApexMethod:Prod.go(0)", "ApexMethod:Used.run(0)"),
      edge("REFERENCES", "FlexiPage:Home", "ApexClass:Prod"),
    ]);
    const candidates = deadCodeCandidates(store, ORG);
    const byName = new Map(candidates.map((c) => [String(c.node.qualifiedName), c]));
    expect(byName.get("ApexClass:OnlyTested")?.kind).toBe("referenced-only-by-tests");
    expect(byName.get("ApexClass:HelperOnlyTested")?.kind).toBe("referenced-only-by-tests");
    expect(byName.has("ApexClass:Used")).toBe(false);
    expect(byName.has("ApexClass:Prod")).toBe(false);
    // The unreferenced @isTest class is dead, flagged isTest.
    expect(byName.get("ApexClass:OnlyTestedTest")).toMatchObject({ kind: "dead", isTest: true });
    const dead = findDeadCode(store, ORG).map((n) => String(n.qualifiedName));
    expect(dead).not.toContain("ApexClass:OnlyTested");
    expect(dead).toContain("ApexClass:OnlyTestedTest");
    const only = byName.get("ApexClass:OnlyTested");
    expect(only?.testOnlyRefs).toBeGreaterThan(0);
    expect(scoreDeadCode(only!.node, Date.now(), only!.testOnlyRefs).reasons).toContain(
      "referenced_only_by_tests",
    );
    // review r1 m-4: it has incoming edges (from tests), so not `no_incoming_edges`.
    expect(scoreDeadCode(only!.node, Date.now(), only!.testOnlyRefs).reasons).not.toContain(
      "no_incoming_edges",
    );
    expect(scoreDeadCode(only!.node, Date.now(), 0).reasons).toContain("no_incoming_edges");
    expect(realIncomingRefCount(store, ORG, asQualifiedName("ApexClass:OnlyTested"))).toBe(0);
    expect(realIncomingRefCount(store, ORG, asQualifiedName("ApexClass:Used"))).toBe(1);
    await store.close();
  });
});
