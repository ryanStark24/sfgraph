import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { deadCodeCandidates, findDeadCode, scoreDeadCode } from "../dead-code.js";
import { loadDeadCodeScores, populateDeadCodeScores, readDeadCodeScores } from "../populate.js";

// Batch R / S6 (catalog contract: "test classes do count as references"):
// dead = no inbound reference of any kind, test classes included (isTest);
// production code used only by tests is listed apart (referenced-only-by-tests).
const ORG = asOrgId("org_s6");
function cls(qname: string, isTest = false): NodeFact {
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

let store: SqliteGraphStore;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.mergeNodes([
    cls("ApexClass:Orphan"),
    cls("ApexClass:OnlyTested"),
    cls("ApexClass:OnlyTestedTest", true),
    cls("ApexClass:TestUtil", true),
    cls("ApexClass:Used"),
    cls("ApexClass:Prod"),
  ]);
  store.mergeEdges([
    edge("IS_TEST_FOR", "ApexClass:OnlyTestedTest", "ApexClass:OnlyTested"),
    edge("REFERENCES", "ApexClass:OnlyTestedTest", "ApexClass:TestUtil"),
    edge("CALLS", "ApexClass:Prod", "ApexClass:Used"),
    edge("REFERENCES", "FlexiPage:Home", "ApexClass:Prod"),
  ]);
});
afterEach(async () => {
  await store.close();
});

describe("dead code counts test references as references", () => {
  it("dead = zero inbound of any kind, test classes included and flagged", () => {
    const c = deadCodeCandidates(store, ORG);
    const by = new Map(c.map((x) => [String(x.node.qualifiedName), x]));
    expect(by.get("ApexClass:Orphan")).toMatchObject({ kind: "dead", isTest: false });
    // An unreferenced test class is dead (nothing references it).
    expect(by.get("ApexClass:OnlyTestedTest")).toMatchObject({ kind: "dead", isTest: true });
    // Referenced by a test: not dead, listed apart.
    expect(by.get("ApexClass:OnlyTested")).toMatchObject({ kind: "referenced-only-by-tests" });
    // A test helper referenced by tests is in use; it is test code, not apart.
    expect(by.has("ApexClass:TestUtil")).toBe(false);
    expect(by.has("ApexClass:Used")).toBe(false);
    expect(by.has("ApexClass:Prod")).toBe(false);
    expect(
      findDeadCode(store, ORG)
        .map((n) => String(n.qualifiedName))
        .sort(),
    ).toEqual(["ApexClass:OnlyTestedTest", "ApexClass:Orphan"]);
    expect(scoreDeadCode(cls("ApexClass:X", true), Date.now(), 0, true).reasons).toContain(
      "test_class",
    );
  });

  it("the cache keeps both lists apart and restores them on read", () => {
    const db = (store as unknown as { db: Database.Database }).db;
    populateDeadCodeScores(store, ORG, db);
    const rows = readDeadCodeScores(db, ORG) ?? [];
    const reasons = (q: string) => rows.find((r) => r.qualifiedName === q)?.reasons ?? [];
    expect(reasons("ApexClass:Orphan")).toContain("no_incoming_edges");
    expect(reasons("ApexClass:OnlyTestedTest")).toEqual(
      expect.arrayContaining(["no_incoming_edges", "test_class"]),
    );
    expect(reasons("ApexClass:OnlyTested")).toContain("referenced_only_by_tests");
    expect(reasons("ApexClass:OnlyTested")).not.toContain("no_incoming_edges");
    const live = loadDeadCodeScores(store, ORG, null)
      .rows.map((r) => r.qualifiedName)
      .sort();
    expect(live).toEqual(rows.map((r) => r.qualifiedName).sort());
  });
});
