import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { listMembers, ownerOf } from "../containment.js";
import { realIncomingRefCount } from "../dead-code.js";
import { findDependents } from "../dependents.js";
import { generateManifest } from "../deployment-manifest/generate.js";

// Review I-3: containment lookups must hit the CONTAINS_METHOD table only,
// never one query per rel table.
const A = asOrgId("org_cont_a");
const B = asOrgId("org_cont_b");

function node(org: typeof A, label: string, qname: string, hash = qname): NodeFact {
  return {
    orgId: org,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}
function edge(org: typeof A, rel: string, src: string, dst: string): EdgeFact {
  return {
    orgId: org,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: 1,
    lastSeenAt: 1,
  };
}

type Call = { fn: string; relType: unknown };
function spy(store: SqliteGraphStore): Call[] {
  const calls: Call[] = [];
  for (const fn of ["listEdgesFrom", "listEdgesTo"] as const) {
    const orig = store[fn].bind(store);
    store[fn] = ((
      org: typeof A,
      q: ReturnType<typeof asQualifiedName>,
      rel?: EdgeFact["relType"],
    ) => {
      calls.push({ fn, relType: rel });
      return orig(org, q, rel);
    }) as never;
  }
  return calls;
}

let a: SqliteGraphStore;
let b: SqliteGraphStore;
beforeEach(async () => {
  a = new SqliteGraphStore({ dbPath: ":memory:" });
  b = new SqliteGraphStore({ dbPath: ":memory:" });
  await a.init();
  await b.init();
  for (const [s, org, hash] of [
    [a, A, "v2"],
    [b, B, "v1"],
  ] as const) {
    s.mergeNodes([
      node(org, "ApexClass", "ApexClass:Svc", hash),
      node(org, "ApexMethod", "ApexMethod:Svc.run(0)", hash),
    ]);
    s.mergeEdges([edge(org, "CONTAINS_METHOD", "ApexClass:Svc", "ApexMethod:Svc.run(0)")]);
  }
});
afterEach(async () => {
  await a.close();
  await b.close();
});

describe("containment lookups are scoped to CONTAINS_METHOD", () => {
  it("listMembers and ownerOf pass the rel type", () => {
    const calls = spy(a);
    expect(listMembers(a, A, asQualifiedName("ApexClass:Svc"))).toEqual(["ApexMethod:Svc.run(0)"]);
    expect(ownerOf(a, A, asQualifiedName("ApexMethod:Svc.run(0)"))).toBe("ApexClass:Svc");
    expect(ownerOf(a, A, asQualifiedName("ApexClass:Svc"))).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.relType === "CONTAINS_METHOD")).toBe(true);
  });

  it("findDependents and dead-code issue no unscoped listEdgesFrom", () => {
    const calls = spy(a);
    findDependents(a, A, asQualifiedName("ApexClass:Svc"), 2);
    findDependents(a, A, asQualifiedName("ApexMethod:Svc.run(0)"), 2);
    realIncomingRefCount(a, A, asQualifiedName("ApexClass:Svc"));
    const from = calls.filter((c) => c.fn === "listEdgesFrom");
    expect(from.length).toBeGreaterThan(0);
    expect(from.every((c) => c.relType === "CONTAINS_METHOD")).toBe(true);
  });

  it("generateManifest checks membership with scoped queries only", () => {
    const ca = spy(a);
    const cb = spy(b);
    const r = generateManifest({ storeA: a, orgA: A, storeB: b, orgB: B, category: "all" });
    expect(r.packageXml).toContain("<members>Svc</members>");
    const all = [...ca, ...cb];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((c) => c.relType === "CONTAINS_METHOD")).toBe(true);
  });
});
