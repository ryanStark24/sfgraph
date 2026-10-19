import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestCtx } from "../../parsers/__tests__/_harness.js";
import { ApexClassParser } from "../../parsers/apex/index.js";
import { ApexTriggerParser } from "../../parsers/apex/trigger.js";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { GOVERNOR_RISK_ORDER, compareGovernorRisks, findGovernorRisks } from "../governor.js";

// T15 query I-5: SOSL and dynamic SOQL in loops are governor risks, and the
// risks have a documented severity/priority order.

const BODY = `public class Scan {
  public static void sosl(List<String> terms) {
    for (String t : terms) {
      List<List<SObject>> r = [FIND :t IN ALL FIELDS RETURNING Account(Id)];
    }
  }
  public static void soslOnce(String t) {
    List<List<SObject>> r = [FIND :t IN ALL FIELDS RETURNING Account(Id)];
  }
  public static void dyn(List<String> qs) {
    for (String q : qs) {
      List<SObject> rows = Database.query(q);
      Integer n = Database.countQuery('SELECT count() FROM Account');
    }
  }
  public static void dynOnce(String q) {
    List<SObject> rows = Database.query(q);
  }
  public static void dynDml(List<Account> accts) {
    for (Account a : accts) {
      Database.update(a, false);
    }
  }
}`;

let store: SqliteGraphStore;
const ORG = asOrgId("orgGov");
beforeEach(async () => {
  store = new SqliteGraphStore({ dbPath: ":memory:" });
  await store.init();
});
afterEach(async () => {
  await store.close();
});

async function ingest(): Promise<void> {
  const ctx = makeTestCtx({ orgId: ORG } as never);
  const r = await new ApexClassParser().parse(
    { className: "Scan", metaXml: "<ApexClass/>", body: BODY },
    ctx,
  );
  const t = await new ApexTriggerParser().parse(
    {
      triggerName: "AcctT",
      body: "trigger AcctT on Account (after update) {\n  for (Account a : Trigger.new) {\n    List<SObject> x = Database.query('SELECT Id FROM Contact');\n  }\n}",
      metaXml: "<ApexTrigger/>",
    },
    ctx,
  );
  store.mergeNodes([...r.nodes, ...t.nodes].map((n) => ({ ...n, orgId: ORG })));
  store.mergeEdges([...r.edges, ...t.edges].map((e) => ({ ...e, orgId: ORG })));
}

describe("T15 I-5 governor detection", () => {
  it("SOSL in a loop is sosl_in_loop; outside a loop it is not", async () => {
    await ingest();
    const risks = findGovernorRisks(store, ORG);
    expect(risks.filter((r) => r.risk === "sosl_in_loop").map((r) => r.qualifiedName)).toEqual([
      "ApexMethod:Scan.sosl(1)",
    ]);
  });

  it("dynamic SOQL in a loop is dynamic_soql_in_loop, per call kind, in methods and triggers", async () => {
    await ingest();
    const risks = findGovernorRisks(store, ORG).filter((r) => r.risk === "dynamic_soql_in_loop");
    expect(risks.map((r) => [r.qualifiedName, r.evidence])).toEqual([
      ["ApexMethod:Scan.dyn(1)", "Database.countQuery"],
      ["ApexMethod:Scan.dyn(1)", "Database.query"],
      ["ApexTrigger:AcctT", "Database.query"],
    ]);
  });

  it("Database DML calls in a loop are dml_in_loop", async () => {
    await ingest();
    const risks = findGovernorRisks(store, ORG);
    expect(risks).toContainEqual(
      expect.objectContaining({ qualifiedName: "ApexMethod:Scan.dynDml(1)", risk: "dml_in_loop" }),
    );
  });

  it("the documented order: severity first, then the risk kind, then qname and evidence", () => {
    expect(GOVERNOR_RISK_ORDER).toEqual([
      "soql_in_loop",
      "sosl_in_loop",
      "dynamic_soql_in_loop",
      "dml_in_loop",
      "no_bulk",
      "unbounded_query",
    ]);
    const rows = [
      { qualifiedName: "A", risk: "unbounded_query" as const, evidence: "x" },
      { qualifiedName: "Z", risk: "dml_in_loop" as const, evidence: "x" },
      { qualifiedName: "B", risk: "soql_in_loop" as const, evidence: "y" },
      { qualifiedName: "B", risk: "soql_in_loop" as const, evidence: "a" },
    ];
    expect(
      [...rows].sort(compareGovernorRisks).map((r) => `${r.qualifiedName}/${r.risk}/${r.evidence}`),
    ).toEqual(["B/soql_in_loop/a", "B/soql_in_loop/y", "Z/dml_in_loop/x", "A/unbounded_query/x"]);
  });
});
