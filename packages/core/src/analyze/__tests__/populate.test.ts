import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/rel-types.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import {
  populateAnalysisTables,
  populateDeadCodeScores,
  populateGovernorRisks,
  populateSecurityFindings,
  populateTestCoverage,
} from "../populate.js";

const ORG = asOrgId("orgA");

function node(
  label: string,
  qname: string,
  attributes: Record<string, unknown> = {},
  lastMod = Date.now(),
): NodeFact {
  return {
    orgId: ORG,
    label,
    qualifiedName: asQualifiedName(qname),
    attributes: { ...attributes, sourceUri: "test://x" },
    sourceHash: asSha256("h"),
    firstSeenAt: lastMod,
    lastSeenAt: lastMod,
    lastModifiedAt: lastMod,
  };
}

function edge(src: string, rel: string, dst: string): EdgeFact {
  return {
    orgId: ORG,
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel as EdgeFact["relType"],
    attributes: {},
    firstSeenAt: 0,
    lastSeenAt: 0,
  };
}

let store: SqliteGraphStore;
let db: Database.Database;

beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({
    id: ORG,
    alias: "a",
    instanceUrl: "https://x",
    apiVersion: "59.0",
    createdAt: Date.now(),
  });
  db = (store as unknown as { db: Database.Database }).db;
});

describe("populateAnalysisTables", () => {
  it("populateGovernorRisks detects SOQL-in-loop", () => {
    const body = `
public class Bad {
  void run() {
    for (Account a : [SELECT Id FROM Account]) {
      Contact c = [SELECT Id FROM Contact WHERE AccountId = :a.Id LIMIT 1];
    }
  }
}`;
    store.mergeNodes([node("ApexClass", "ApexClass:Bad", { source: body })]);
    const n = populateGovernorRisks(store, ORG, db);
    expect(n).toBeGreaterThan(0);
    const rows = db
      .prepare("SELECT risk_type FROM _sfgraph_governor_risks WHERE org_id = ?")
      .all(ORG) as Array<{ risk_type: string }>;
    expect(rows.some((r) => r.risk_type === "soql_in_loop")).toBe(true);
  });

  it("populateGovernorRisks detects DML-in-loop", () => {
    const body = `
public class Bad2 {
  void run() {
    for (Integer i = 0; i < 10; i++) {
      insert new Account(Name='x');
    }
  }
}`;
    store.mergeNodes([node("ApexClass", "ApexClass:Bad2", { source: body })]);
    populateGovernorRisks(store, ORG, db);
    const rows = db
      .prepare("SELECT risk_type FROM _sfgraph_governor_risks WHERE org_id = ?")
      .all(ORG) as Array<{ risk_type: string }>;
    expect(rows.some((r) => r.risk_type === "dml_in_loop")).toBe(true);
  });

  it("populateGovernorRisks honors hasSoqlInLoop attribute hint", () => {
    store.mergeNodes([node("ApexClass", "ApexClass:Hint", { hasSoqlInLoop: true, source: "" })]);
    populateGovernorRisks(store, ORG, db);
    const rows = db
      .prepare("SELECT risk_type FROM _sfgraph_governor_risks WHERE org_id = ?")
      .all(ORG) as Array<{ risk_type: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it("populateDeadCodeScores writes high-confidence buckets for orphans", () => {
    const old = Date.now() - 400 * 86400000;
    store.mergeNodes([node("ApexClass", "ApexClass:Lonely", {}, old)]);
    populateDeadCodeScores(store, ORG, db);
    const rows = db
      .prepare(
        "SELECT confidence, score FROM _sfgraph_dead_code_scores WHERE org_id = ? AND qualified_name = ?",
      )
      .all(ORG, "ApexClass:Lonely") as Array<{ confidence: string; score: number }>;
    expect(rows[0]?.confidence).toBe("high");
  });

  it("populateTestCoverage counts IS_TEST_FOR edges", () => {
    store.mergeNodes([node("ApexClass", "ApexClass:Foo"), node("ApexClass", "ApexClass:FooTest")]);
    store.mergeEdges([edge("ApexClass:FooTest", REL_TYPES.IS_TEST_FOR, "ApexClass:Foo")]);
    populateTestCoverage(store, ORG, db);
    const row = db
      .prepare("SELECT test_count FROM _sfgraph_test_coverage WHERE qualified_name = ?")
      .get("ApexClass:Foo") as { test_count: number } | undefined;
    expect(row?.test_count).toBe(1);
  });

  it("populateSecurityFindings inserts for sharing-rule All-access", () => {
    store.mergeNodes([node("SharingRule", "SharingRule:Account.r1", { accessLevel: "All" })]);
    populateSecurityFindings(store, ORG, db);
    const rows = db
      .prepare("SELECT rule_id FROM _sfgraph_findings WHERE org_id = ?")
      .all(ORG) as Array<{ rule_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.rule_id).toBe("sharing.full_access");
  });

  it("populateAnalysisTables returns counts for all four categories", async () => {
    const old = Date.now() - 400 * 86400000;
    store.mergeNodes([
      node("ApexClass", "ApexClass:X", {
        source: "void f(){ for(Integer i:list){[SELECT Id FROM Account];}}",
      }),
      node("ApexClass", "ApexClass:Y", {}, old),
      node("SharingRule", "SharingRule:Account.r1", { accessLevel: "All" }),
    ]);
    const out = await populateAnalysisTables(store, ORG, db);
    expect(out.findings).toBeGreaterThanOrEqual(1);
    expect(out.deadCode).toBeGreaterThanOrEqual(1);
    expect(out.governor).toBeGreaterThanOrEqual(1);
    expect(out.testCov).toBeGreaterThanOrEqual(2);
  });
});
