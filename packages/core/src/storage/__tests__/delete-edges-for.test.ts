import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

const ORG = asOrgId("org1");
const OTHER = asOrgId("org2");
let store: SqliteGraphStore;

const node = (orgId: typeof ORG, q: string): NodeFact => ({
  orgId,
  label: "ApexClass",
  qualifiedName: asQualifiedName(q),
  attributes: {},
  sourceHash: asSha256("h"),
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastModifiedAt: 1,
});
const edge = (orgId: typeof ORG, src: string, dst: string, rel: string): EdgeFact => ({
  orgId,
  srcQualifiedName: asQualifiedName(src),
  dstQualifiedName: asQualifiedName(dst),
  relType: rel as EdgeFact["relType"],
  attributes: {},
  firstSeenAt: 1,
  lastSeenAt: 1,
});

beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

describe("deleteEdgesFor", () => {
  it("removes every edge into and out of the node, in every table, case-insensitively, in that org only", () => {
    for (const org of [ORG, OTHER]) {
      store.mergeNodes(["ApexClass:Gone", "ApexClass:A", "ApexClass:B"].map((q) => node(org, q)));
      store.mergeEdges([
        edge(org, "ApexClass:Gone", "ApexClass:A", "CALLS"),
        edge(org, "ApexClass:B", "ApexClass:Gone", "CALLS"),
        edge(org, "ApexClass:B", "ApexClass:Gone", "REFERENCES"),
        edge(org, "ApexClass:Gone", "ApexClass:Gone", "REFERENCES"),
        edge(org, "ApexClass:A", "ApexClass:B", "CALLS"),
      ]);
    }
    store.deleteEdgesFor(ORG, asQualifiedName("apexclass:GONE"));

    const left = (org: typeof ORG) =>
      ["ApexClass:Gone", "ApexClass:A", "ApexClass:B"]
        .flatMap((q) => store.listEdgesFrom(org, asQualifiedName(q)))
        .map((e) => `${e.relType} ${e.srcQualifiedName}->${e.dstQualifiedName}`)
        .sort();
    expect(left(ORG)).toEqual(["CALLS ApexClass:A->ApexClass:B"]);
    expect(left(OTHER)).toHaveLength(5);
  });
});
