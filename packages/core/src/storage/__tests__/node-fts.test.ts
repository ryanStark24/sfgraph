import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../sqlite/graph-store.js";

const ORG = asOrgId("org1");
let workDir: string;
let store: SqliteGraphStore;

beforeEach(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sfg-fts-"));
  store = new SqliteGraphStore({
    dbPath: path.join(workDir, "g.sqlite"),
    backupDir: path.join(workDir, "b"),
  });
  await store.init();
});
afterEach(async () => {
  await store.close();
  rmSync(workDir, { recursive: true, force: true });
});

function node(label: string, qname: string): NodeFact {
  return {
    orgId: ORG,
    qualifiedName: asQualifiedName(qname),
    label,
    attributes: {},
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  };
}

describe("node FTS keyword index", () => {
  it("matches a camelCase identifier by a single word (word-split body)", () => {
    store.upsertNodeFts(
      ORG,
      asQualifiedName("ApexClass:AccountController"),
      "ApexClass",
      "ApexClass: ApexClass:AccountController\naccount controller",
    );
    store.upsertNodeFts(
      ORG,
      asQualifiedName("ApexClass:OrderService"),
      "ApexClass",
      "ApexClass: ApexClass:OrderService\norder service",
    );
    // A bare "account" query (camelCase-split internally) hits the controller.
    const hits = store.searchNodesFts(ORG, "AccountController", 10);
    expect(hits.map((h) => h.qname)).toContain("ApexClass:AccountController");
    expect(hits.map((h) => h.qname)).not.toContain("ApexClass:OrderService");
  });

  it("upsert replaces the prior body (no duplicate rows)", () => {
    const q = asQualifiedName("ApexClass:Foo");
    store.upsertNodeFts(ORG, q, "ApexClass", "alpha");
    store.upsertNodeFts(ORG, q, "ApexClass", "bravo");
    expect(store.searchNodesFts(ORG, "alpha", 10)).toHaveLength(0);
    expect(store.searchNodesFts(ORG, "bravo", 10).map((h) => h.qname)).toEqual(["ApexClass:Foo"]);
  });

  it("deleteNode purges the FTS row", () => {
    const q = asQualifiedName("ApexClass:Gone");
    store.mergeNodes([node("ApexClass", "ApexClass:Gone")]);
    store.upsertNodeFts(ORG, q, "ApexClass", "gone widget handler");
    expect(store.searchNodesFts(ORG, "widget", 10)).toHaveLength(1);
    store.deleteNode(ORG, q);
    expect(store.searchNodesFts(ORG, "widget", 10)).toHaveLength(0);
  });

  it("empty/whitespace query returns nothing", () => {
    store.upsertNodeFts(ORG, asQualifiedName("ApexClass:X"), "ApexClass", "x");
    expect(store.searchNodesFts(ORG, "   ", 10)).toEqual([]);
  });
});
