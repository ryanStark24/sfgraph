import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { emitTypeRefEdges } from "../class-refs.js";
import { ApexClassParser } from "../class.js";
import { resolveApexReferences } from "../ref-resolver.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Bug-fix wave F: references explain_code missed on the default (regex) path.
 *  1. type-only references (declarations, generic arguments, casts, params,
 *     return types, loop variables, `instanceof`)
 *  2. references found only inside a SOQL string or an inline query
 *  3. a child-relationship subquery (`(SELECT … FROM Contacts)`)
 *  4. a static field assignment on another class (`Config.mode = x`)
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

async function parse(className: string, body: string) {
  const r = await new ApexClassParser().parse({ className, body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return { nodes: r.nodes, edges: r.edges as unknown as Edge[] };
}

const refs = (edges: Edge[], src: string, via?: string) =>
  edges
    .filter(
      (e) =>
        e.relType === "REFERENCES" &&
        String(e.srcQualifiedName) === src &&
        (via === undefined || e.attributes.via === via),
    )
    .map((e) => String(e.dstQualifiedName))
    .sort();

describe("type-only references", () => {
  const body = `public class Orders {
    private static GadgetDto cached;
    public SprocketView render(Team_Assignment__c ta, List<PartRow> rows) {
      WidgetHelper h;
      Map<Id, GadgetDto> byId = new Map<Id, GadgetDto>();
      Object o = rows;
      SprocketView v = (SprocketView) o;
      for (LineDto d : new List<LineDto>()) {}
      if (o instanceof BoltDto) {}
      Account a;
      String s;
      Integer COUNT_X = 1;
      Orders self;
      Inner i;
      Fresh f = new Fresh();
      return v;
    }
    private class Inner {}
  }`;

  it("emits REFERENCES via type for user class and custom object types only", async () => {
    const { edges } = await parse("Orders", body);
    expect(refs(edges, "ApexMethod:Orders.render(2)", "type")).toEqual([
      "ApexClass:BoltDto",
      "ApexClass:GadgetDto",
      "ApexClass:LineDto",
      "ApexClass:PartRow",
      "ApexClass:SprocketView",
      "ApexClass:WidgetHelper",
      "CustomObject:Team_Assignment__c",
    ]);
    // Field types and method signatures (code outside method bodies) also
    // belong to the class, as for the other reference rules.
    expect(refs(edges, "ApexClass:Orders", "type")).toEqual([
      "ApexClass:GadgetDto",
      "ApexClass:PartRow",
      "ApexClass:SprocketView",
      "CustomObject:Team_Assignment__c",
    ]);
  });

  it("does not read a DML statement after an if() as a declaration of a type named Update", async () => {
    const r = await new ApexTriggerParser().parse(
      {
        triggerName: "DmlTrigger",
        body: `trigger DmlTrigger on Order (before insert) {
          List<Order> qliList = new List<Order>();
          if(!test.isRunningTest())
            Update qliList;
        }`,
      },
      makeTestCtx(),
    );
    const dsts = (r.edges as unknown as Edge[]).map((e) => String(e.dstQualifiedName));
    expect(dsts).not.toContain("ApexClass:Update");
  });

  it("does not add a type reference next to a constructor edge for the same class", async () => {
    const { edges } = await parse("Orders", body);
    const fresh = edges.filter((e) => String(e.dstQualifiedName) === "ApexClass:Fresh");
    expect(fresh.map((e) => e.relType)).toEqual(["INSTANCE_OF"]);
  });

  it("keeps a static-member reference as static-member", async () => {
    const { edges } = await parse(
      "Uses",
      `public class Uses {
        public void run() { Config c = null; Integer n = Config.LIMIT_X; }
      }`,
    );
    const r = edges.filter((e) => String(e.dstQualifiedName) === "ApexClass:Config");
    expect(r.map((e) => [e.relType, e.attributes.via])).toEqual([["REFERENCES", "static-member"]]);
  });

  it("covers trigger bodies", async () => {
    const r = await new ApexTriggerParser().parse(
      {
        triggerName: "OrderTrigger",
        body: `trigger OrderTrigger on Order (before insert) {
          OrderHandler h;
        }`,
      },
      makeTestCtx(),
    );
    expect(refs(r.edges as unknown as Edge[], "ApexTrigger:OrderTrigger", "type")).toEqual([
      "ApexClass:OrderHandler",
    ]);
  });

  it("stays linear on long inputs that look like open generics or declarations", () => {
    const edges: never[] = [];
    const scope = { localTypes: new Set<string>(), localVars: new Set<string>() };
    for (const big of ["a<b,".repeat(50000), "Foo ".repeat(50000), "(Foo)".repeat(50000)]) {
      const t = performance.now();
      emitTypeRefEdges(makeTestCtx(), "ApexClass:Big", big, scope, edges);
      expect(performance.now() - t).toBeLessThan(2000);
    }
  });
});

describe("references only inside SOQL", () => {
  it("reads fields named only in an inline query and a SOQL string", async () => {
    const { edges } = await parse(
      "Q",
      `public class Q {
        public void run() {
          List<Account> a = [SELECT Id FROM Account WHERE Product_Name__c = :Config.NAME];
          List<SObject> b = Database.query('SELECT Region__c FROM Site__c');
        }
      }`,
    );
    const m = "ApexMethod:Q.run(0)";
    const reads = edges
      .filter((e) => e.relType === "READS_FIELD" && String(e.srcQualifiedName) === m)
      .map((e) => String(e.dstQualifiedName));
    expect(reads).toContain("CustomField:Account.Product_Name__c");
    expect(reads).toContain("CustomField:Site__c.Region__c");
    expect(refs(edges, m)).toContain("ApexClass:Config");
  });
});

describe("child-relationship subqueries", () => {
  it("records each subquery relationship with its fields on the node", async () => {
    const { nodes } = await parse(
      "Sub",
      `public class Sub {
        public void run() {
          List<Account> a = [SELECT Id, (SELECT Id, Status__c FROM Bulk_Service_Requests__r WHERE Open__c = true),
            (SELECT LastName FROM Contacts) FROM Account WHERE Id IN (SELECT AccountId FROM Case)];
        }
      }`,
    );
    const m = nodes.find((n) => String(n.qualifiedName) === "ApexMethod:Sub.run(0)");
    expect((m?.attributes as Record<string, unknown>).apexChildRelationships).toEqual([
      {
        object: "Account",
        relationship: "Bulk_Service_Requests__r",
        fields: ["Id", "Status__c", "Open__c"],
      },
      { object: "Account", relationship: "Contacts", fields: ["LastName"] },
    ]);
  });
});

describe("static field assignment on another class", () => {
  it("emits REFERENCES static-member for `Config.mode = x`", async () => {
    const { edges } = await parse(
      "Setter",
      `public class Setter {
        public void run() { Config.mode = 'x'; Other.Inner.flag = true; }
      }`,
    );
    expect(refs(edges, "ApexMethod:Setter.run(0)", "static-member")).toEqual([
      "ApexClass:Config",
      "ApexClass:Other",
    ]);
  });
});

describe("child-relationship resolution", () => {
  const orgId = asOrgId("00Dxx0000000GAPSAA");
  const node = (qn: string, label: string, attributes: Record<string, unknown> = {}) => ({
    orgId,
    qualifiedName: asQualifiedName(qn),
    label,
    attributes,
    sourceHash: asSha256(qn),
    firstSeenAt: 1,
    lastSeenAt: 1,
    lastModifiedAt: 1,
  });

  it("resolves a subquery to the child object through the lookup's relationshipName", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({
      id: orgId,
      alias: "t",
      instanceUrl: "https://x.test",
      apiVersion: "60.0",
      createdAt: 1,
    });
    store.mergeNodes([
      node("ApexMethod:Sub.run(0)", "ApexMethod", {
        apexChildRelationships: [
          { object: "Account", relationship: "Bulk_Service_Requests__r", fields: ["Status__c"] },
          { object: "Account", relationship: "Contacts", fields: ["LastName"] },
          { object: "Account", relationship: "Mystery__r", fields: ["X__c"] },
        ],
      }),
      node("CustomField:Bulk_Service_Request__c.Account__c", "CustomField", {
        referenceTo: ["Account"],
        relationshipName: "Bulk_Service_Requests",
      }),
      node("CustomField:Bulk_Service_Request__c.Status__c", "CustomField"),
    ]);
    const res = resolveApexReferences(store, orgId, makeTestCtx());
    expect(res.childRelationshipsResolved).toBe(2);
    expect(res.childRelationshipsUnresolved).toBe(1);
    const out = store
      .listEdgesFrom(orgId, asQualifiedName("ApexMethod:Sub.run(0)"))
      .map((e) => `${e.relType} ${String(e.dstQualifiedName)}`)
      .sort();
    expect(out).toEqual([
      "READS_FIELD CustomField:Bulk_Service_Request__c.Status__c",
      "READS_FIELD CustomField:Contact.LastName",
      "REFERENCES CustomObject:Bulk_Service_Request__c",
      "REFERENCES CustomObject:Contact",
    ]);
    await store.close();
  });
});
