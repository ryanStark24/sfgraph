import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { dynamicSoqlClauseFields } from "../dynamic-soql.js";
import { resolveApexReferences } from "../ref-resolver.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Task 14 batch S, S5(i): the WHERE / HAVING / GROUP BY / ORDER BY field
 * operands of folded dynamic SOQL become READS_FIELD `dynamic: true` on the
 * FROM object, by the same grammar as inline SOQL (soql-fields). Only when
 * FROM is literal text; with a computed FROM the clause fields are not
 * emitted and are counted as skipped (`dynamicSoqlFieldsSkipped` on the
 * source node, summed by the apex ref resolver).
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

function dynamicReads(edges: Edge[], src: string): string[] {
  return edges
    .filter(
      (e) =>
        e.relType === "READS_FIELD" &&
        String(e.srcQualifiedName) === src &&
        e.attributes.dynamic === true,
    )
    .map((e) => String(e.dstQualifiedName))
    .sort();
}

async function parseClass(body: string) {
  const r = await new ApexClassParser().parse({ className: "Q", body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return { nodes: r.nodes, edges: r.edges as unknown as Edge[] };
}

describe("dynamicSoqlClauseFields", () => {
  it("returns the clause operands of a literal FROM query", () => {
    const r = dynamicSoqlClauseFields(
      "SELECT Id FROM Widget__c WHERE Status__c = :s AND CALENDAR_YEAR(Made__c) = 2020 GROUP BY Region__c HAVING COUNT(Id) > 1 ORDER BY Rank__c DESC LIMIT 5",
    );
    expect(r).toEqual({
      object: "Widget__c",
      fields: ["Status__c", "Made__c", "Id", "Region__c", "Rank__c"],
      skipped: 0,
    });
  });

  it("never takes a field glued to a computed operand or found inside a string value", () => {
    const r = dynamicSoqlClauseFields(
      "SELECT Id FROM Widget__c WHERE \u0001Code__c = :x AND Kind__c\u0001 = 1 AND Note__c = 'a IN b' AND Size__c > \u0001 ORDER BY \u0001",
    );
    expect(r).toEqual({ object: "Widget__c", fields: ["Note__c", "Size__c"], skipped: 0 });
  });

  it("counts clause fields as skipped when FROM is computed", () => {
    expect(
      dynamicSoqlClauseFields("SELECT Id FROM \u0001 WHERE Status__c = :s ORDER BY Rank__c"),
    ).toEqual({ object: null, fields: [], skipped: 2 });
    expect(
      dynamicSoqlClauseFields("SELECT Id FROM Gadget\u0001 WHERE Name = 'from Account'"),
    ).toEqual({ object: null, fields: [], skipped: 1 });
  });

  it("counts clause fields as skipped when a literal FROM query is rejected (fix M-2)", () => {
    // Object neither custom nor whitelisted.
    expect(
      dynamicSoqlClauseFields("SELECT Id FROM Gizmo WHERE Status__c = 1 ORDER BY Rank__c"),
    ).toEqual({ object: null, fields: [], skipped: 2 });
    // A select item that is not a field path.
    expect(dynamicSoqlClauseFields("SELECT Id, a b FROM Widget__c WHERE Status__c = 1")).toEqual({
      object: null,
      fields: [],
      skipped: 1,
    });
  });

  it("counts clause fields as skipped when the grammar's FROM differs from the parsed object (fix M-2)", () => {
    expect(
      dynamicSoqlClauseFields("SELECT Id FROM Widget__c WHERE Status__c = 1", {
        object: "Gadget__c",
      }),
    ).toEqual({ object: "Gadget__c", fields: [], skipped: 1 });
  });

  it("returns nothing for text that is not SOQL", () => {
    expect(dynamicSoqlClauseFields("Select a value from the list where x = 1")).toEqual({
      object: null,
      fields: [],
      skipped: 0,
    });
  });
});

describe("ApexClassParser: dynamic SOQL clause fields (S5(i))", () => {
  it("emits WHERE / GROUP BY / ORDER BY fields for a literal FROM", async () => {
    const { edges } = await parseClass(`public class Q {
  public List<SObject> load(Set<Id> ids, String s) {
    String q = 'SELECT Id, Name FROM Widget__c WHERE Id IN :ids AND Status__c = \\'' + s + '\\'';
    q += ' GROUP BY Region__c ORDER BY Rank__c';
    return Database.query(q);
  }
}`);
    expect(dynamicReads(edges, "ApexMethod:Q.load(2)")).toEqual([
      "CustomField:Widget__c.Id",
      "CustomField:Widget__c.Name",
      "CustomField:Widget__c.Rank__c",
      "CustomField:Widget__c.Region__c",
      "CustomField:Widget__c.Status__c",
    ]);
  });

  it("emits nothing for clause fields of a computed FROM and counts them as skipped", async () => {
    const { nodes, edges } = await parseClass(`public class Q {
  public List<SObject> load(String obj) {
    String q = 'SELECT Id FROM ' + obj + ' WHERE Status__c = :s ORDER BY Rank__c';
    return Database.query(q);
  }
}`);
    expect(dynamicReads(edges, "ApexMethod:Q.load(1)")).toEqual([]);
    const m = nodes.find((n) => String(n.qualifiedName) === "ApexMethod:Q.load(1)");
    expect((m?.attributes as Record<string, unknown>).dynamicSoqlFieldsSkipped).toBe(2);
  });

  it("does not set the skip attribute when nothing is skipped", async () => {
    const { nodes } = await parseClass(`public class Q {
  public List<SObject> load() {
    return Database.query('SELECT Id FROM Widget__c WHERE Status__c = 1');
  }
}`);
    const m = nodes.find((n) => String(n.qualifiedName) === "ApexMethod:Q.load(0)");
    expect((m?.attributes as Record<string, unknown>).dynamicSoqlFieldsSkipped).toBeUndefined();
  });

  it("counts class-level and trigger skips on the class / trigger node", async () => {
    const { nodes } = await parseClass(`public class Q {
  private static final String BASE = 'SELECT Id FROM ' + Q.objName() + ' WHERE Kind__c = 1';
  public static String objName() { return 'Widget__c'; }
}`);
    const c = nodes.find((n) => String(n.qualifiedName) === "ApexClass:Q");
    expect((c?.attributes as Record<string, unknown>).dynamicSoqlFieldsSkipped).toBe(1);

    const t = await new ApexTriggerParser().parse(
      {
        triggerName: "T",
        body: `trigger T on Widget__c (after insert) {
  String o = 'Gadget__c';
  List<SObject> xs = Database.query('SELECT Id FROM ' + o + ' WHERE Region__c = 1');
  List<SObject> ys = Database.query('SELECT Id FROM Gadget__c WHERE Color__c = 1');
}`,
      },
      makeTestCtx(),
    );
    expect(dynamicReads(t.edges as unknown as Edge[], "ApexTrigger:T")).toEqual([
      "CustomField:Gadget__c.Color__c",
      "CustomField:Gadget__c.Id",
    ]);
    const tn = t.nodes.find((n) => n.label === "ApexTrigger");
    expect((tn?.attributes as Record<string, unknown>).dynamicSoqlFieldsSkipped).toBe(1);
  });
});

describe("resolveApexReferences: dynamic SOQL skip stats", () => {
  it("sums dynamicSoqlFieldsSkipped across Apex nodes", async () => {
    const orgId = asOrgId("00Dxx0000000ABCEAA");
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "test",
      instanceUrl: "https://example.test",
      apiVersion: "59.0",
      createdAt: Date.now(),
    });
    const ts = Date.now();
    const node = (qn: string, label: string, attributes: Record<string, unknown>) => ({
      orgId,
      qualifiedName: asQualifiedName(qn),
      label,
      attributes,
      sourceHash: asSha256(qn),
      firstSeenAt: ts,
      lastSeenAt: ts,
      lastModifiedAt: ts,
    });
    store.mergeNodes([
      node("ApexMethod:Q.load(1)", "ApexMethod", { dynamicSoqlFieldsSkipped: 2 }),
      node("ApexClass:Q", "ApexClass", { dynamicSoqlFieldsSkipped: 1 }),
      node("ApexTrigger:T", "ApexTrigger", { dynamicSoqlFieldsSkipped: 3 }),
    ]);
    const res = resolveApexReferences(store, orgId, makeTestCtx());
    expect(res.dynamicSoqlFieldsSkipped).toBe(6);
  });
});
