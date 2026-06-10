import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
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

describe("governor risk detection — edge-based (live ingest, no body)", () => {
  function methodNode(qname: string): NodeFact {
    return {
      orgId: ORG,
      label: "ApexMethod",
      qualifiedName: asQualifiedName(qname),
      // Live-ingest reality: NO body/source on the node.
      attributes: { sourceUri: "x" },
      sourceHash: asSha256("h"),
      firstSeenAt: 1,
      lastSeenAt: 1,
      lastModifiedAt: Date.now(),
    };
  }

  it("flags soql_in_loop from an inLoop EXECUTES_SOQL edge", () => {
    store.mergeNodes([methodNode("ApexMethod:Acme.run(0)")]);
    store.mergeEdges([
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("ApexMethod:Acme.run(0)"),
        dstQualifiedName: asQualifiedName("CustomObject:Account"),
        relType: "EXECUTES_SOQL" as never,
        attributes: { inLoop: true, query: "[SELECT Id FROM Account]" },
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ]);
    const count = populateGovernorRisks(store, ORG, db);
    expect(count).toBeGreaterThanOrEqual(1);
    const rows = db
      .prepare("SELECT risk_type FROM _sfgraph_governor_risks WHERE org_id = ?")
      .all(ORG)
      .map((r) => (r as { risk_type: string }).risk_type);
    expect(rows).toContain("soql_in_loop");
    // unbounded_query is intentionally NOT emitted from edges (too noisy on
    // real orgs — every WHERE-less query would flag).
    expect(rows).not.toContain("unbounded_query");
  });

  it("does NOT flag a WHERE-less SOQL edge that is outside any loop", () => {
    store.mergeNodes([methodNode("ApexMethod:Acme.list(0)")]);
    store.mergeEdges([
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("ApexMethod:Acme.list(0)"),
        dstQualifiedName: asQualifiedName("CustomObject:RecordType"),
        relType: "EXECUTES_SOQL" as never,
        attributes: { query: "[SELECT Id FROM RecordType]" },
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ]);
    expect(populateGovernorRisks(store, ORG, db)).toBe(0);
  });

  it("flags dml_in_loop from EXECUTES_DML edge attrs", () => {
    store.mergeNodes([methodNode("ApexMethod:Acme.save(0)")]);
    store.mergeEdges([
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("ApexMethod:Acme.save(0)"),
        dstQualifiedName: asQualifiedName("DML:update"),
        relType: "EXECUTES_DML" as never,
        attributes: { inLoop: true },
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ]);
    populateGovernorRisks(store, ORG, db);
    const rows = db
      .prepare("SELECT risk_type FROM _sfgraph_governor_risks WHERE org_id = ?")
      .all(ORG)
      .map((r) => (r as { risk_type: string }).risk_type);
    expect(rows).toContain("dml_in_loop");
  });

  it("does NOT flag a bounded query outside a loop", () => {
    store.mergeNodes([methodNode("ApexMethod:Acme.safe(0)")]);
    store.mergeEdges([
      {
        orgId: ORG,
        srcQualifiedName: asQualifiedName("ApexMethod:Acme.safe(0)"),
        dstQualifiedName: asQualifiedName("CustomObject:Account"),
        relType: "EXECUTES_SOQL" as never,
        attributes: { query: "[SELECT Id FROM Account WHERE Id = :x LIMIT 1]" },
        firstSeenAt: 1,
        lastSeenAt: 1,
      },
    ]);
    const count = populateGovernorRisks(store, ORG, db);
    expect(count).toBe(0);
  });
});
