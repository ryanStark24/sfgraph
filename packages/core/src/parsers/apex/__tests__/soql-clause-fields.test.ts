import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { soqlFieldRefs } from "../soql-fields.js";

/**
 * Task 14 batch P, B4: SOQL field reads beyond the SELECT list (WHERE /
 * ORDER BY / GROUP BY), dotted relationship paths recorded for the post-merge
 * resolver, static SOQL outside method bodies, and `Case` typed locals.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes?: Record<string, unknown>;
};

async function parse(className: string, body: string) {
  const r = await new ApexClassParser().parse({ className, body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return { nodes: r.nodes, edges: r.edges as unknown as Edge[] };
}

const dsts = (edges: Edge[], rel: string, src: string) =>
  [
    ...new Set(
      edges
        .filter((e) => e.relType === rel && String(e.srcQualifiedName) === src)
        .map((e) => String(e.dstQualifiedName)),
    ),
  ].sort();

describe("soqlFieldRefs (SOQL grammar)", () => {
  it("reads WHERE, ORDER BY and GROUP BY fields; skips binds, values and subqueries", () => {
    const r = soqlFieldRefs(
      " Id, Name FROM Account WHERE Status__c = ' ' AND Type IN :types AND (Rating != null OR NOT Industry LIKE ' ') AND Id IN (SELECT AccountId FROM Contact WHERE Email = ' ') AND CALENDAR_YEAR(CreatedDate) = 2020 GROUP BY Region__c, ROLLUP(Tier__c) ORDER BY Score__c DESC NULLS LAST, Name LIMIT 10",
    );
    expect(r.object).toBe("Account");
    expect(r.fields.sort()).toEqual(
      [
        "CreatedDate",
        "Id",
        "Industry",
        "Name",
        "Rating",
        "Region__c",
        "Score__c",
        "Status__c",
        "Tier__c",
        "Type",
      ].sort(),
    );
    expect(r.fields).not.toContain("Email");
    expect(r.fields).not.toContain("AccountId");
  });

  it("returns dotted paths separately and strips the FROM alias", () => {
    const r = soqlFieldRefs(
      " Id, Account.Name, a.Owner.Email FROM Contact a WHERE a.Account.Industry = ' ' AND a.LastName = ' ' ORDER BY Account.Rating",
    );
    expect(r.object).toBe("Contact");
    expect(r.fields.sort()).toEqual(["Id", "LastName"]);
    expect(r.paths.sort()).toEqual([
      "Account.Industry",
      "Account.Name",
      "Account.Rating",
      "Owner.Email",
    ]);
  });
});

describe("ApexClassParser: SOQL clause fields (regex path)", () => {
  it("emits READS_FIELD for WHERE / ORDER BY / GROUP BY fields", async () => {
    const body = `public class Svc {
      public void run(Set<Id> ids) {
        List<Order> os = [SELECT Id FROM Order WHERE Status = 'Draft' AND AccountId IN :ids ORDER BY EffectiveDate];
        List<AggregateResult> ag = [SELECT COUNT(Id) FROM Case GROUP BY Origin];
      }
    }`;
    const { edges } = await parse("Svc", body);
    expect(dsts(edges, "READS_FIELD", "ApexMethod:Svc.run(1)")).toEqual([
      "CustomField:Case.Origin",
      "CustomField:Order.AccountId",
      "CustomField:Order.EffectiveDate",
      "CustomField:Order.Id",
      "CustomField:Order.Status",
    ]);
  });

  it("records dotted relationship paths on the method node, never a relName-as-object field", async () => {
    const body = `public class Svc {
      public void run() {
        List<OrderItem> xs = [SELECT Id, Product2.ObjectTypeName__c, Order.Status FROM OrderItem WHERE Order.Account.Industry = 'X'];
      }
    }`;
    const { nodes, edges } = await parse("Svc", body);
    const reads = dsts(edges, "READS_FIELD", "ApexMethod:Svc.run(0)");
    expect(reads).toEqual(["CustomField:OrderItem.Id"]);
    const m = nodes.find((n) => String(n.qualifiedName) === "ApexMethod:Svc.run(0)");
    expect((m?.attributes as Record<string, unknown>).apexRelationshipPaths).toEqual([
      { object: "OrderItem", path: "Product2.ObjectTypeName__c", rel: "READS_FIELD" },
      { object: "OrderItem", path: "Order.Status", rel: "READS_FIELD" },
      { object: "OrderItem", path: "Order.Account.Industry", rel: "READS_FIELD" },
    ]);
  });

  it("records chained member access (`acr.Account.X`) as a relationship path", async () => {
    const body = `public class Svc {
      public void run(List<AccountContactRelation> rels) {
        for (AccountContactRelation acr : rels) {
          String s = acr.Account.Segment__c;
          acr.Contact.Owner.Title = 'x';
        }
      }
    }`;
    const { nodes, edges } = await parse("Svc", body);
    const m = nodes.find((n) => String(n.qualifiedName) === "ApexMethod:Svc.run(1)");
    expect((m?.attributes as Record<string, unknown>).apexRelationshipPaths).toEqual([
      { object: "AccountContactRelation", path: "Account.Segment__c", rel: "READS_FIELD" },
      { object: "AccountContactRelation", path: "Contact.Owner.Title", rel: "WRITES_FIELD" },
    ]);
    // The relationship name itself is never a field of the receiver.
    expect(dsts(edges, "READS_FIELD", "ApexMethod:Svc.run(1)")).toEqual([]);
  });

  it("attributes static SOQL in constructors and field initialisers to the class", async () => {
    const body = `public class LeadCheck {
      private static final List<Group> QUEUES = [SELECT Id FROM Group WHERE Type = 'Queue'];
      public Lead l;
      public LeadCheck() {
        l = [SELECT Id, Company FROM Lead WHERE Email = 'a' LIMIT 1];
      }
      public void other() { }
    }`;
    const { edges } = await parse("LeadCheck", body);
    expect(dsts(edges, "EXECUTES_SOQL", "ApexClass:LeadCheck")).toEqual([
      "CustomObject:Group",
      "CustomObject:Lead",
    ]);
    expect(dsts(edges, "READS_FIELD", "ApexClass:LeadCheck")).toEqual([
      "CustomField:Group.Id",
      "CustomField:Group.Type",
      "CustomField:Lead.Company",
      "CustomField:Lead.Email",
      "CustomField:Lead.Id",
    ]);
    // Method SOQL is not double-attributed to the class.
    expect(dsts(edges, "EXECUTES_SOQL", "ApexMethod:LeadCheck.other(0)")).toEqual([]);
  });

  it("treats `Case` as a type (Apex has no `case` keyword)", async () => {
    const body = `public class Svc {
      public void run(Id cid) {
        Case existingCase = new Case();
        existingCase.Is_Obsolete__c = true;
      }
    }`;
    const { edges } = await parse("Svc", body);
    expect(dsts(edges, "WRITES_FIELD", "ApexMethod:Svc.run(1)")).toEqual([
      "CustomField:Case.Is_Obsolete__c",
    ]);
  });
});
