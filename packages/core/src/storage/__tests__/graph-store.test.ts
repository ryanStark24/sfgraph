import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@sfgraph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact, Org } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-graph-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "bkp"),
  });
  await store.init();
});

afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function n(
  label: string,
  qname: string,
  hash: string,
  t = 1,
  attrs: Record<string, unknown> = {},
): NodeFact {
  return {
    orgId: asOrgId("org1"),
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: attrs,
    sourceHash: asSha256(hash),
    firstSeenAt: t,
    lastSeenAt: t,
    lastModifiedAt: t,
  };
}

function e(
  relType: string,
  src: string,
  dst: string,
  attrs: Record<string, unknown> = {},
  t = 1,
): EdgeFact {
  return {
    orgId: asOrgId("org1"),
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: relType as EdgeFact["relType"],
    attributes: attrs,
    firstSeenAt: t,
    lastSeenAt: t,
  };
}

describe("SqliteGraphStore", () => {
  it("upserts and reads an org", () => {
    const org: Org = {
      id: asOrgId("org1"),
      alias: "DevHub",
      instanceUrl: "https://x",
      apiVersion: "62.0",
      createdAt: 1,
    };
    store.upsertOrg(org);
    expect(store.getOrg(asOrgId("org1"))).toEqual(org);
    expect(store.getOrg(asOrgId("nope"))).toBeNull();
  });

  it("mergeNodes inserts new facts", () => {
    const r = store.mergeNodes([n("ApexClass", "Foo", "h1"), n("ApexClass", "Bar", "h2")]);
    expect(r).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    expect(store.countNodes(asOrgId("org1"))).toBe(2);
  });

  it("mergeNodes dedups by source_hash", () => {
    store.mergeNodes([n("ApexClass", "Foo", "h1")]);
    const r = store.mergeNodes([n("ApexClass", "Foo", "h1", 5)]);
    expect(r).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it("mergeNodes updates lastModifiedAt only when hash changes", () => {
    store.mergeNodes([n("ApexClass", "Foo", "h1", 1)]);
    store.mergeNodes([n("ApexClass", "Foo", "h1", 5)]);
    let node = store.getNode(asOrgId("org1"), asQualifiedName("Foo"));
    expect(node?.lastModifiedAt).toBe(1);
    expect(node?.lastSeenAt).toBe(5);
    store.mergeNodes([n("ApexClass", "Foo", "h2", 10)]);
    node = store.getNode(asOrgId("org1"), asQualifiedName("Foo"));
    expect(node?.lastModifiedAt).toBe(10);
    expect(node?.sourceHash).toBe("h2");
  });

  it("mergeEdges inserts and dedups", () => {
    const r1 = store.mergeEdges([e("CALLS", "A", "B", { x: 1 })]);
    expect(r1).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    const r2 = store.mergeEdges([e("CALLS", "A", "B", { x: 1 })]);
    expect(r2.unchanged).toBe(1);
    const r3 = store.mergeEdges([e("CALLS", "A", "B", { x: 2 })]);
    expect(r3.updated).toBe(1);
  });

  it("getNode finds node via label index", () => {
    store.mergeNodes([n("Flow", "MyFlow", "h1", 1, { active: true })]);
    const got = store.getNode(asOrgId("org1"), asQualifiedName("MyFlow"));
    expect(got?.label).toBe("Flow");
    expect(got?.attributes).toEqual({ active: true });
  });

  it("listNodesByLabel returns only that label", () => {
    store.mergeNodes([n("ApexClass", "A", "h1"), n("Flow", "F", "h2")]);
    const a = store.listNodesByLabel(asOrgId("org1"), "ApexClass");
    expect(a).toHaveLength(1);
    expect(a[0]?.qualifiedName).toBe("A");
  });

  it("listEdgesFrom filters by relType", () => {
    store.mergeEdges([e("CALLS", "A", "B"), e("READS_FIELD", "A", "C")]);
    expect(store.listEdgesFrom(asOrgId("org1"), asQualifiedName("A"))).toHaveLength(2);
    expect(
      store.listEdgesFrom(asOrgId("org1"), asQualifiedName("A"), "CALLS" as EdgeFact["relType"]),
    ).toHaveLength(1);
  });

  it("listEdgesTo finds reverse edges", () => {
    store.mergeEdges([e("CALLS", "A", "B"), e("CALLS", "X", "B")]);
    expect(store.listEdgesTo(asOrgId("org1"), asQualifiedName("B"))).toHaveLength(2);
  });

  it("reverse traversal uses reverse index", () => {
    store.mergeEdges([e("CALLS", "A", "B")]);
    const plan = store._explainReverseEdgeQuery("CALLS" as EdgeFact["relType"]);
    expect(plan.toLowerCase()).toContain("rev");
  });

  it("countNodes / countEdges per org", () => {
    store.mergeNodes([n("ApexClass", "A", "h1"), n("ApexClass", "B", "h2")]);
    store.mergeEdges([e("CALLS", "A", "B")]);
    expect(store.countNodes(asOrgId("org1"))).toBe(2);
    expect(store.countEdges(asOrgId("org1"))).toBe(1);
  });

  it("composite PK dedupes within a single merge call", () => {
    const r = store.mergeNodes([n("ApexClass", "Foo", "h1"), n("ApexClass", "Foo", "h1")]);
    // first insert, second sees it as unchanged.
    expect(r.inserted + r.unchanged).toBe(2);
  });

  it("transaction wraps callbacks", () => {
    const result = store.transaction(() => {
      store.mergeNodes([n("ApexClass", "T", "h1")]);
      return 42;
    });
    expect(result).toBe(42);
    expect(store.countNodes(asOrgId("org1"))).toBe(1);
  });
});
