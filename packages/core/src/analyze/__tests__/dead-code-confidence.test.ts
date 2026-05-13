import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/rel-types.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { populateDeadCodeScores } from "../populate.js";

const ORG = asOrgId("orgDc");
let store: SqliteGraphStore;
let db: Database.Database;

function n(qname: string, lastMod: number): NodeFact {
  return {
    orgId: ORG,
    label: "ApexClass",
    qualifiedName: asQualifiedName(qname),
    attributes: { sourceUri: "x" },
    sourceHash: asSha256("h"),
    firstSeenAt: lastMod,
    lastSeenAt: lastMod,
    lastModifiedAt: lastMod,
  };
}

function e(src: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: REL_TYPES.CALLS,
    attributes: {},
    firstSeenAt: 0,
    lastSeenAt: 0,
  };
}

beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({ id: ORG, alias: "a", instanceUrl: "x", apiVersion: "59.0", createdAt: 1 });
  db = (store as unknown as { db: Database.Database }).db;
});

describe("dead-code confidence buckets", () => {
  it("ancient + orphan = high confidence", () => {
    store.mergeNodes([n("ApexClass:Ancient", Date.now() - 800 * 86400000)]);
    populateDeadCodeScores(store, ORG, db);
    const row = db
      .prepare("SELECT confidence FROM _sfgraph_dead_code_scores WHERE qualified_name=?")
      .get("ApexClass:Ancient") as { confidence: string };
    expect(row.confidence).toBe("high");
  });

  it("stale-ish + orphan = medium confidence", () => {
    // ~60 days old, no incoming
    store.mergeNodes([n("ApexClass:Mid", Date.now() - 60 * 86400000)]);
    populateDeadCodeScores(store, ORG, db);
    const row = db
      .prepare("SELECT confidence FROM _sfgraph_dead_code_scores WHERE qualified_name=?")
      .get("ApexClass:Mid") as { confidence: string };
    expect(["medium", "low"]).toContain(row.confidence);
  });

  it("has incoming edges + recent = not persisted (not a candidate)", () => {
    store.mergeNodes([n("ApexClass:Live", Date.now()), n("ApexClass:Caller", Date.now())]);
    store.mergeEdges([e("ApexClass:Caller", "ApexClass:Live")]);
    populateDeadCodeScores(store, ORG, db);
    const row = db
      .prepare("SELECT confidence FROM _sfgraph_dead_code_scores WHERE qualified_name=?")
      .get("ApexClass:Live") as { confidence: string } | undefined;
    expect(row).toBeUndefined();
  });
});
