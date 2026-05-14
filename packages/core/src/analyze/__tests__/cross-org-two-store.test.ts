import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { diffOrgs } from "../cross-org.js";

const A = asOrgId("orgA");
const B = asOrgId("orgB");

function node(orgId: ReturnType<typeof asOrgId>, qname: string, hash: string): NodeFact {
  return {
    orgId,
    qualifiedName: asQualifiedName(qname),
    label: "ApexClass",
    attributes: {},
    sourceHash: asSha256(hash),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

let storeA: SqliteGraphStore;
let storeB: SqliteGraphStore;

beforeEach(async () => {
  storeA = new SqliteGraphStore({ dbPath: ":memory:" });
  await storeA.init();
  storeB = new SqliteGraphStore({ dbPath: ":memory:" });
  await storeB.init();
});

describe("diffOrgs two-store form", () => {
  it("computes onlyInA / onlyInB / changed across independent stores", () => {
    storeA.mergeNodes([node(A, "ApexClass:Only_A", "h1"), node(A, "ApexClass:Both", "v1")]);
    storeB.mergeNodes([node(B, "ApexClass:Both", "v2"), node(B, "ApexClass:Only_B", "h2")]);
    const diff = diffOrgs({ storeA, orgA: A, storeB, orgB: B });
    const onlyInA = diff.onlyInA.map((n) => n.qualifiedName);
    const onlyInB = diff.onlyInB.map((n) => n.qualifiedName);
    const changed = diff.changed.map((c) => c.a.qualifiedName);
    expect(onlyInA).toEqual(["ApexClass:Only_A"]);
    expect(onlyInB).toEqual(["ApexClass:Only_B"]);
    expect(changed).toEqual(["ApexClass:Both"]);
  });

  it("does not silently degrade when stores are independent (regression)", () => {
    // Reproduce the original bug: when both orgs are read from the same
    // single-store, the second org's rows simply aren't there. The new
    // two-store API must NOT show that pathology.
    storeA.mergeNodes([node(A, "ApexClass:X", "h")]);
    storeB.mergeNodes([node(B, "ApexClass:Y", "h")]);
    const diff = diffOrgs({ storeA, orgA: A, storeB, orgB: B });
    expect(diff.onlyInA.map((n) => n.qualifiedName)).toEqual(["ApexClass:X"]);
    expect(diff.onlyInB.map((n) => n.qualifiedName)).toEqual(["ApexClass:Y"]);
  });
});
