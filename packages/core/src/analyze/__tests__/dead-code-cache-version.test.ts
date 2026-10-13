import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import {
  DEAD_CODE_ALGORITHM_VERSION,
  loadDeadCodeScores,
  populateAnalysisTables,
  populateDeadCodeScores,
  readDeadCodeScores,
} from "../populate.js";

// Review I-4: rows an older scorer wrote (no stamp, or another version) must
// read as stale, so an upgraded install without a re-ingest does not keep
// serving pre-fix answers (e.g. @isTest classes listed as dead).
const ORG = asOrgId("org_dc_version");

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

let store: SqliteGraphStore;
let db: Database.Database;
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  db = (store as unknown as { db: Database.Database }).db;
  store.mergeNodes([cls("ApexClass:Orphan"), cls("ApexClass:OrphanTest", true)]);
});
afterEach(async () => {
  await store.close();
});

/** What the pre-fix scorer left behind: the @isTest class as a candidate, no stamp. */
function writeLegacyRows(): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO _sfgraph_dead_code_scores
     (org_id, qualified_name, score, confidence, reasons, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const q of ["ApexClass:Orphan", "ApexClass:OrphanTest"]) {
    stmt.run(ORG, q, 0.1, "high", JSON.stringify(["no_incoming_edges"]), Date.now());
  }
}

describe("dead-code score cache is versioned", () => {
  it("populate stamps the current algorithm version and the rows read back", () => {
    populateDeadCodeScores(store, ORG, db);
    const rows = readDeadCodeScores(db, ORG);
    // Batch R / S6: the unreferenced @isTest class is dead too.
    expect(rows?.map((r) => r.qualifiedName)).toEqual(["ApexClass:Orphan", "ApexClass:OrphanTest"]);
    expect(rows?.[0]?.reasons).toContain("no_incoming_edges");
    expect(rows?.[1]?.reasons).toContain("test_class");
    expect(loadDeadCodeScores(store, ORG, db).source).toBe("cache");
  });

  it("rows without a stamp are stale: read returns null, load computes live", () => {
    writeLegacyRows();
    expect(readDeadCodeScores(db, ORG)).toBeNull();
    const r = loadDeadCodeScores(store, ORG, db);
    expect(r.source).toBe("live");
    expect(r.rows.map((x) => x.qualifiedName)).toEqual([
      "ApexClass:Orphan",
      "ApexClass:OrphanTest",
    ]);
  });

  it("a stamp from another algorithm version is stale", () => {
    populateDeadCodeScores(store, ORG, db);
    db.prepare(
      "UPDATE _sfgraph_analysis_versions SET version = ? WHERE org_id = ? AND analysis = 'dead_code'",
    ).run(DEAD_CODE_ALGORITHM_VERSION - 1, ORG);
    writeLegacyRows();
    expect(readDeadCodeScores(db, ORG)).toBeNull();
    expect(loadDeadCodeScores(store, ORG, db).source).toBe("live");
  });

  it("populateAnalysisTables stamps the version too", async () => {
    writeLegacyRows();
    await populateAnalysisTables(store, ORG, db);
    expect(readDeadCodeScores(db, ORG)?.map((r) => r.qualifiedName)).toEqual([
      "ApexClass:Orphan",
      "ApexClass:OrphanTest",
    ]);
  });

  it("an empty current cache is a valid answer (no dead code), not stale", () => {
    store.mergeEdges([
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("FlexiPage:Home"),
        dstQualifiedName: asQualifiedName("ApexClass:Orphan"),
        relType: "REFERENCES",
        attributes: {},
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("FlexiPage:Home"),
        dstQualifiedName: asQualifiedName("ApexClass:OrphanTest"),
        relType: "REFERENCES",
        attributes: {},
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ]);
    populateDeadCodeScores(store, ORG, db);
    expect(readDeadCodeScores(db, ORG)).toEqual([]);
  });
});
