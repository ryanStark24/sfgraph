import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDependents } from "../dependents.js";

// audit tools-01: findDependents on an ApexClass must include callers that
// reference the class through its methods (LWC imports, method CALLS).
const ORG = asOrgId("org_tools01");

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

describe("audit tools-01: upstream of an ApexClass rolls up method-level callers", () => {
  it("finds the LWC and the Apex caller that reference the class via its methods", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      node("ApexClass", "ApexClass:Svc"),
      node("ApexMethod", "ApexMethod:Svc.search(1)"),
      node("LWC", "LWC:lookup"),
      node("ApexClass", "ApexClass:Caller"),
      node("ApexMethod", "ApexMethod:Caller.go(0)"),
    ]);
    store.mergeEdges([
      edge("CONTAINS_METHOD", "ApexClass:Svc", "ApexMethod:Svc.search(1)"),
      edge("CONTAINS_METHOD", "ApexClass:Caller", "ApexMethod:Caller.go(0)"),
      edge("IMPORTS_APEX", "LWC:lookup", "ApexMethod:Svc.search(1)"),
      edge("CALLS", "ApexMethod:Caller.go(0)", "ApexMethod:Svc.search(1)"),
    ]);
    const r = findDependents(store, ORG, asQualifiedName("ApexClass:Svc"), 3);
    const reached = (r.reached ?? []).map((e) => e.qualifiedName);
    expect(reached).toContain("LWC:lookup");
    expect(reached.some((q) => q === "ApexMethod:Caller.go(0)" || q === "ApexClass:Caller")).toBe(
      true,
    );
    await store.close();
  });
});

// Review I-2: a method seed must not widen to the class. Upstream of
// `Util.a` are its own callers plus references to `ApexClass:Util` itself
// (type usage, `new Util()`, static refs); never the callers of `Util.b`.
describe("audit tools-01: a method seed stays method-scoped", () => {
  it("reports CallerA and class-level refs, not CallerB (calls only Util.b)", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.mergeNodes([
      node("ApexClass", "ApexClass:Util"),
      node("ApexMethod", "ApexMethod:Util.a(0)"),
      node("ApexMethod", "ApexMethod:Util.b(0)"),
      node("ApexClass", "ApexClass:CallerA"),
      node("ApexMethod", "ApexMethod:CallerA.run(0)"),
      node("ApexClass", "ApexClass:CallerB"),
      node("ApexMethod", "ApexMethod:CallerB.run(0)"),
      node("ApexClass", "ApexClass:TypeUser"),
    ]);
    store.mergeEdges([
      edge("CONTAINS_METHOD", "ApexClass:Util", "ApexMethod:Util.a(0)"),
      edge("CONTAINS_METHOD", "ApexClass:Util", "ApexMethod:Util.b(0)"),
      edge("CONTAINS_METHOD", "ApexClass:CallerA", "ApexMethod:CallerA.run(0)"),
      edge("CONTAINS_METHOD", "ApexClass:CallerB", "ApexMethod:CallerB.run(0)"),
      edge("CALLS", "ApexMethod:CallerA.run(0)", "ApexMethod:Util.a(0)"),
      edge("CALLS", "ApexMethod:CallerB.run(0)", "ApexMethod:Util.b(0)"),
      // Internal call of the owner's own sibling: not a class-level ref.
      edge("CALLS", "ApexMethod:Util.b(0)", "ApexClass:Util"),
      edge("REFERENCES", "ApexClass:TypeUser", "ApexClass:Util"),
    ]);
    const r = findDependents(store, ORG, asQualifiedName("ApexMethod:Util.a(0)"), 3);
    const reached = (r.reached ?? []).map((e) => e.qualifiedName);
    expect(reached).toContain("ApexMethod:CallerA.run(0)");
    expect(reached).toContain("ApexClass:TypeUser");
    expect(reached).not.toContain("ApexMethod:CallerB.run(0)");
    expect(reached).not.toContain("ApexClass:CallerB");
    expect(reached).not.toContain("ApexMethod:Util.b(0)");
    // The containment edge is structure, not usage.
    expect(reached).not.toContain("ApexClass:Util");
    // The class seed still rolls up every method's callers (tools-01).
    const cls = findDependents(store, ORG, asQualifiedName("ApexClass:Util"), 1);
    const clsReached = (cls.reached ?? []).map((e) => e.qualifiedName);
    expect(clsReached).toEqual(
      expect.arrayContaining([
        "ApexMethod:CallerA.run(0)",
        "ApexMethod:CallerB.run(0)",
        "ApexClass:TypeUser",
      ]),
    );
    await store.close();
  });
});
