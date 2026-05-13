import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteVectorStore } from "../sqlite/vector-store.js";

const DIM = 384;

function vec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i += 1) {
    v[i] = Math.sin(seed * 0.01 + i * 0.001);
  }
  return v;
}

let workDir: string;
let store: SqliteVectorStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-vec-"));
  store = new SqliteVectorStore({
    dbPath: path.join(workDir, "v.sqlite"),
    backupDir: path.join(workDir, "bkp"),
  });
  await store.init();
});

afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe("SqliteVectorStore", () => {
  it("loads sqlite-vec extension and initializes vec0 tables", () => {
    // If init worked, querying vec0 metadata succeeds.
    const row = store.db
      .prepare("SELECT name FROM sqlite_master WHERE name = '_sfgraph_node_vectors'")
      .get();
    expect(row).toBeTruthy();
  });

  it("upsertNodeVector inserts a new vector", () => {
    const r = store.upsertNodeVector(
      asOrgId("orgA"),
      asQualifiedName("Foo"),
      "ApexClass",
      vec(1),
      asSha256("h1"),
    );
    expect(r).toEqual({ inserted: true, deduped: false });
    expect(store.countNodeVectors(asOrgId("orgA"))).toBe(1);
  });

  it("dedups when content_hash matches", () => {
    store.upsertNodeVector(
      asOrgId("orgA"),
      asQualifiedName("Foo"),
      "ApexClass",
      vec(1),
      asSha256("h1"),
    );
    const r = store.upsertNodeVector(
      asOrgId("orgA"),
      asQualifiedName("Foo"),
      "ApexClass",
      vec(2),
      asSha256("h1"),
    );
    expect(r).toEqual({ inserted: false, deduped: true });
  });

  it("KNN returns results ordered by distance", () => {
    for (let i = 0; i < 5; i += 1) {
      store.upsertNodeVector(
        asOrgId("orgA"),
        asQualifiedName(`Q${i}`),
        "ApexClass",
        vec(i),
        asSha256(`h${i}`),
      );
    }
    const hits = store.searchNodes(asOrgId("orgA"), vec(0), 3);
    expect(hits).toHaveLength(3);
    for (let i = 1; i < hits.length; i += 1) {
      const prev = hits[i - 1];
      const cur = hits[i];
      if (prev && cur) expect(prev.distance).toBeLessThanOrEqual(cur.distance);
    }
    expect(hits[0]?.qname).toBe("Q0");
  });

  it("label filter narrows results", () => {
    store.upsertNodeVector(
      asOrgId("orgA"),
      asQualifiedName("A"),
      "ApexClass",
      vec(1),
      asSha256("h1"),
    );
    store.upsertNodeVector(asOrgId("orgA"), asQualifiedName("F"), "Flow", vec(1), asSha256("h2"));
    const apex = store.searchNodes(asOrgId("orgA"), vec(1), 10, { label: "ApexClass" });
    expect(apex.every((h) => h.label === "ApexClass")).toBe(true);
    expect(apex.find((h) => h.qname === "F")).toBeUndefined();
  });

  it("partition prune: query for orgA returns no orgB results", () => {
    const sameVec = vec(42);
    store.upsertNodeVector(
      asOrgId("orgA"),
      asQualifiedName("AOnly"),
      "ApexClass",
      sameVec,
      asSha256("hA"),
    );
    store.upsertNodeVector(
      asOrgId("orgB"),
      asQualifiedName("BOnly"),
      "ApexClass",
      sameVec,
      asSha256("hB"),
    );
    const hitsA = store.searchNodes(asOrgId("orgA"), sameVec, 10);
    expect(hitsA.some((h) => h.qname === "BOnly")).toBe(false);
    expect(hitsA.some((h) => h.qname === "AOnly")).toBe(true);
    const hitsB = store.searchNodes(asOrgId("orgB"), sameVec, 10);
    expect(hitsB.some((h) => h.qname === "AOnly")).toBe(false);
    expect(hitsB.some((h) => h.qname === "BOnly")).toBe(true);
  });

  it("countNodeVectors per org", () => {
    store.upsertNodeVector(
      asOrgId("orgA"),
      asQualifiedName("A1"),
      "ApexClass",
      vec(1),
      asSha256("h1"),
    );
    store.upsertNodeVector(
      asOrgId("orgA"),
      asQualifiedName("A2"),
      "ApexClass",
      vec(2),
      asSha256("h2"),
    );
    store.upsertNodeVector(
      asOrgId("orgB"),
      asQualifiedName("B1"),
      "ApexClass",
      vec(3),
      asSha256("h3"),
    );
    expect(store.countNodeVectors(asOrgId("orgA"))).toBe(2);
    expect(store.countNodeVectors(asOrgId("orgB"))).toBe(1);
  });
});
