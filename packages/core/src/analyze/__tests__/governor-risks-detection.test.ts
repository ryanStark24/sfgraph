import { asOrgId, asQualifiedName, asSha256 } from "@sfgraph/shared";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { NodeFact } from "../../domain/index.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { populateGovernorRisks } from "../populate.js";

const ORG = asOrgId("orgDetect");

let store: SqliteGraphStore;
let db: Database.Database;

function n(qname: string, source: string): NodeFact {
  return {
    orgId: ORG,
    label: "ApexClass",
    qualifiedName: asQualifiedName(qname),
    attributes: { source, sourceUri: "x" },
    sourceHash: asSha256("h"),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: Date.now(),
  };
}

beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
  store.upsertOrg({ id: ORG, alias: "a", instanceUrl: "x", apiVersion: "59.0", createdAt: 1 });
  db = (store as unknown as { db: Database.Database }).db;
});

describe("governor risk detection heuristics", () => {
  it("detects SOQL inside for-loop", () => {
    store.mergeNodes([
      n(
        "ApexClass:SoqlLoop",
        "public class A { void r(){ for(Integer i=0;i<10;i++){ List<Account> l = [SELECT Id FROM Account LIMIT 1]; } } }",
      ),
    ]);
    populateGovernorRisks(store, ORG, db);
    const r = db
      .prepare("SELECT count(*) AS c FROM _sfgraph_governor_risks WHERE risk_type='soql_in_loop'")
      .get() as { c: number };
    expect(r.c).toBeGreaterThan(0);
  });

  it("detects DML inside while-loop", () => {
    store.mergeNodes([
      n(
        "ApexClass:DmlLoop",
        "public class B { void r(){ Integer i=0; while(i<5){ insert new Account(Name='x'); i++; } } }",
      ),
    ]);
    populateGovernorRisks(store, ORG, db);
    const r = db
      .prepare("SELECT count(*) AS c FROM _sfgraph_governor_risks WHERE risk_type='dml_in_loop'")
      .get() as { c: number };
    expect(r.c).toBeGreaterThan(0);
  });

  it("flags unbounded SOQL (no LIMIT, no WHERE)", () => {
    store.mergeNodes([
      n(
        "ApexClass:Unbounded",
        "public class C { void r(){ List<Account> l = [SELECT Id FROM Account]; } }",
      ),
    ]);
    populateGovernorRisks(store, ORG, db);
    const r = db
      .prepare(
        "SELECT count(*) AS c FROM _sfgraph_governor_risks WHERE risk_type='unbounded_query'",
      )
      .get() as { c: number };
    expect(r.c).toBeGreaterThan(0);
  });

  it("flags trigger without Trigger.new (no bulkify)", () => {
    const t: NodeFact = {
      ...n(
        "ApexTrigger:T1",
        "trigger T1 on Account (before insert) { Account a = [SELECT Id FROM Account LIMIT 1]; }",
      ),
      label: "ApexTrigger",
    };
    store.mergeNodes([t]);
    populateGovernorRisks(store, ORG, db);
    const r = db
      .prepare("SELECT count(*) AS c FROM _sfgraph_governor_risks WHERE risk_type='no_bulk'")
      .get() as { c: number };
    expect(r.c).toBeGreaterThan(0);
  });
});
