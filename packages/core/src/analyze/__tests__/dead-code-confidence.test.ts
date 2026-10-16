import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/rel-types.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { findDeadCode, scoreDeadCode } from "../dead-code.js";
import { populateDeadCodeScores } from "../populate.js";

const ORG = asOrgId("orgDc");
let store: SqliteGraphStore;
let db: Database.Database;

function n(qname: string, lastMod: number): NodeFact {
  return {
    orgId: ORG,
    label: qname.slice(0, qname.indexOf(":")),
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

const DAY = 86400000;
const confidenceOf = (q: string) =>
  (
    db.prepare("SELECT confidence FROM _sfgraph_dead_code_scores WHERE qualified_name=?").get(q) as
      | { confidence: string }
      | undefined
  )?.confidence;

describe("dead-code cache holds only zero-inbound nodes", () => {
  it("a stale node with one real inbound edge is not persisted (never high)", () => {
    store.mergeNodes([
      n("ApexClass:StaleUsed", Date.now() - 800 * DAY),
      n("ApexClass:Caller", Date.now()),
    ]);
    store.mergeEdges([e("ApexClass:Caller", "ApexClass:StaleUsed")]);
    populateDeadCodeScores(store, ORG, db);
    expect(confidenceOf("ApexClass:StaleUsed")).toBeUndefined();
  });

  it("a stale node with zero inbound is persisted as high", () => {
    store.mergeNodes([n("ApexClass:StaleOrphan", Date.now() - 800 * DAY)]);
    populateDeadCodeScores(store, ORG, db);
    expect(confidenceOf("ApexClass:StaleOrphan")).toBe("high");
  });

  it("cached rows and findDeadCode are the same set of qnames", () => {
    const old = Date.now() - 800 * DAY;
    store.mergeNodes([
      n("ApexClass:StaleOrphan", old),
      n("ApexClass:StaleUsed", old),
      n("ApexClass:FreshOrphan", Date.now()),
      n("ApexClass:Caller", Date.now()),
      n("Flow:OldFlow", old),
      n("ApexPage:OldPage", old),
      n("ApexComponent:OldCmp", old),
      n("LWC:bundledCard", old),
      n("LWC:embeddedCard", old),
      { ...n("ApexClass:NoTimestamp", 0) },
    ]);
    store.mergeEdges([
      e("ApexClass:Caller", "ApexClass:StaleUsed"),
      { ...e("LWCBundle:bundledCard", "LWC:bundledCard"), relType: REL_TYPES.CONTAINS_COMPONENT },
      { ...e("LWC:parentCard", "LWC:embeddedCard"), relType: REL_TYPES.EMBEDS_LWC },
    ]);
    populateDeadCodeScores(store, ORG, db);
    // Expected set, read off the graph above: every scored node with no real
    // inbound edge (the own-bundle edge is not one; CALLS and EMBEDS_LWC are).
    const expected = [
      "ApexClass:Caller",
      "ApexClass:FreshOrphan",
      "ApexClass:NoTimestamp",
      "ApexClass:StaleOrphan",
      "ApexComponent:OldCmp",
      "ApexPage:OldPage",
      "Flow:OldFlow",
      "LWC:bundledCard",
    ].sort();
    const cached = (
      db
        .prepare("SELECT qualified_name FROM _sfgraph_dead_code_scores WHERE org_id=?")
        .all(ORG) as Array<{
        qualified_name: string;
      }>
    )
      .map((r) => r.qualified_name)
      .sort();
    const live = findDeadCode(store, ORG)
      .map((x) => String(x.qualifiedName))
      .sort();
    expect(cached).toEqual(expected);
    expect(live).toEqual(expected);
  });
});

describe("scoreDeadCode buckets by freshness", () => {
  it.each([
    [10 * DAY, "low"],
    [60 * DAY, "medium"],
    [800 * DAY, "high"],
  ])("age %d ms is %s", (age, bucket) => {
    const r = scoreDeadCode(n("ApexClass:X", Date.now() - age));
    expect(r.confidence).toBe(bucket);
    expect(r.reasons).toContain("no_incoming_edges");
  });

  it("no timestamp is medium", () => {
    expect(scoreDeadCode(n("ApexClass:X", 0)).confidence).toBe("medium");
  });

  it("populate persists exactly the scoreDeadCode result", () => {
    store.mergeNodes([n("ApexClass:Old", Date.now() - 800 * DAY)]);
    populateDeadCodeScores(store, ORG, db);
    const row = db
      .prepare(
        "SELECT score, confidence, reasons FROM _sfgraph_dead_code_scores WHERE qualified_name=?",
      )
      .get("ApexClass:Old") as { score: number; confidence: string; reasons: string };
    const want = scoreDeadCode(n("ApexClass:Old", Date.now() - 800 * DAY));
    expect(row.confidence).toBe(want.confidence);
    expect(row.score).toBeCloseTo(want.score);
    expect(JSON.parse(row.reasons)).toEqual(want.reasons);
  });
});
