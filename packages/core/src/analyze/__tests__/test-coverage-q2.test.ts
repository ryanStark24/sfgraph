import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REL_TYPES } from "../../domain/index.js";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/index.js";
import { componentOf } from "../containment.js";
import { hasTestCoverage, makeCoverageClassifier } from "../test-coverage.js";

// Batch Q2 (task 14, B7): coverage and test-ness are decided on the owning
// class; only ApexClass / ApexTrigger can carry IS_TEST_FOR.
const orgId = asOrgId("orgQ2");
let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

function node(qn: string, label?: string, attributes: Record<string, unknown> = {}): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qn),
    label: label ?? qn.slice(0, qn.indexOf(":")),
    attributes,
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
const q = asQualifiedName;

beforeEach(() => {
  store.mergeNodes([
    node("ApexClass:Svc"),
    node("ApexMethod:Svc.run(0)"),
    node("ApexClass:SvcTest", undefined, { isTest: true }),
    // Test methods are stored under an ApexMethod qname.
    node("ApexMethod:SvcTest.t1(0)", "TestMethod", { isTest: true }),
    node("ApexMethod:SvcTest.helper(0)"),
    node("ApexClass:Bare"),
    node("ApexMethod:Bare.go(0)"),
    node("ApexTrigger:T"),
    node("LWC:cmp"),
    node("Flow:F"),
    node("FlowVersion:F.v1"),
  ]);
  store.mergeEdges([
    edge("ApexClass:Svc", "ApexMethod:Svc.run(0)", REL_TYPES.CONTAINS_METHOD),
    edge("ApexClass:SvcTest", "ApexMethod:SvcTest.t1(0)", REL_TYPES.CONTAINS_METHOD),
    edge("ApexClass:SvcTest", "ApexMethod:SvcTest.helper(0)", REL_TYPES.CONTAINS_METHOD),
    edge("ApexClass:Bare", "ApexMethod:Bare.go(0)", REL_TYPES.CONTAINS_METHOD),
    edge("ApexClass:SvcTest", "ApexClass:Svc", REL_TYPES.IS_TEST_FOR),
    edge("Flow:F", "FlowVersion:F.v1", REL_TYPES.CONTAINS),
  ]);
});

describe("coverage rolls a method up to its class", () => {
  it("a method of a covered class is covered", () => {
    expect(hasTestCoverage(store, orgId, q("ApexMethod:Svc.run(0)"))).toBe(true);
    expect(hasTestCoverage(store, orgId, q("ApexMethod:Bare.go(0)"))).toBe(false);
  });

  it("componentOf folds members into their owner", () => {
    expect(componentOf(store, orgId, q("ApexMethod:Svc.run(0)"))).toBe("ApexClass:Svc");
    expect(componentOf(store, orgId, q("FlowVersion:F.v1"))).toBe("Flow:F");
    expect(componentOf(store, orgId, q("ApexClass:Svc"))).toBe("ApexClass:Svc");
    expect(componentOf(store, orgId, q("LWC:cmp"))).toBe("LWC:cmp");
  });
});

describe("makeCoverageClassifier", () => {
  it("decides test-ness on the owning class", () => {
    const c = makeCoverageClassifier(store, orgId);
    expect(c("ApexMethod:SvcTest.t1(0)")).toMatchObject({
      unit: "ApexClass:SvcTest",
      isTest: true,
    });
    // An untagged helper in a test class is test code too.
    expect(c("ApexMethod:SvcTest.helper(0)")).toMatchObject({ isTest: true });
    expect(c("ApexMethod:Svc.run(0)")).toMatchObject({
      unit: "ApexClass:Svc",
      label: "ApexClass",
      isTest: false,
      covered: true,
      applicable: true,
    });
  });

  it("a class with IS_TEST_FOR out-edges is test code even without the isTest flag", () => {
    store.mergeNodes([node("ApexClass:OtherTest")]);
    store.mergeEdges([edge("ApexClass:OtherTest", "ApexClass:Bare", REL_TYPES.IS_TEST_FOR)]);
    const c = makeCoverageClassifier(store, orgId);
    expect(c("ApexClass:OtherTest").isTest).toBe(true);
    expect(c("ApexMethod:Bare.go(0)").covered).toBe(true);
  });

  it("only ApexClass / ApexTrigger are coverage candidates", () => {
    const c = makeCoverageClassifier(store, orgId);
    expect(c("ApexTrigger:T")).toMatchObject({ applicable: true, covered: false });
    expect(c("LWC:cmp").applicable).toBe(false);
    expect(c("FlowVersion:F.v1")).toMatchObject({ unit: "Flow:F", applicable: false });
  });

  it("uses local facts for nodes the graph does not have yet", () => {
    const c = makeCoverageClassifier(store, orgId, {
      nodes: new Map([
        ["ApexClass:New", node("ApexClass:New")],
        ["ApexMethod:New.m(0)", node("ApexMethod:New.m(0)")],
        ["ApexClass:NewTest", node("ApexClass:NewTest", undefined, { isTest: true })],
      ]),
      owners: new Map([["ApexMethod:New.m(0)", "ApexClass:New"]]),
      testTargets: new Set(["apexclass:new"]),
    });
    expect(c("ApexMethod:New.m(0)")).toMatchObject({
      unit: "ApexClass:New",
      applicable: true,
      covered: true,
      isTest: false,
    });
    expect(c("ApexClass:NewTest").isTest).toBe(true);
  });
});

describe("makeCoverageClassifier: one verdict per unit (fix round 1, M6)", () => {
  beforeEach(() => {
    // A test class known only from its method's flag (no class attribute,
    // no IS_TEST_FOR edge).
    store.mergeNodes([node("ApexClass:Plain"), node("ApexMethod:Plain.t(0)", "TestMethod")]);
    store.mergeEdges([edge("ApexClass:Plain", "ApexMethod:Plain.t(0)", REL_TYPES.CONTAINS_METHOD)]);
  });

  it("the class and its test method agree, in either query order", () => {
    const a = makeCoverageClassifier(store, orgId);
    expect(a("ApexClass:Plain")).toEqual(a("ApexMethod:Plain.t(0)"));
    expect(a("ApexClass:Plain").isTest).toBe(true);
    const b = makeCoverageClassifier(store, orgId);
    expect(b("ApexMethod:Plain.t(0)")).toEqual(b("ApexClass:Plain"));
    expect(b("ApexClass:Plain").isTest).toBe(true);
  });
});
