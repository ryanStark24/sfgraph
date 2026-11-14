import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { beforeEach, describe, expect, it } from "vitest";
import { SqliteGraphStore } from "../../storage/sqlite/graph-store.js";
import { detectNotBulkTrigger, detectUnboundedQueries } from "../governor-source.js";
import { nameLikePattern, scanLabel } from "../scan.js";

describe("shared source detector (S-1.8.2-006)", () => {
  const unbounded = (code: string) => detectUnboundedQueries(code).map((r) => r.evidence);

  it("flags a query with no LIMIT and no WHERE", () => {
    expect(unbounded("return [SELECT Id FROM Account];")).toEqual(["[SELECT Id FROM Account]"]);
  });

  it("does not flag LIMIT, WHERE on Id, a bind, COUNT(), custom metadata, or text in comments/strings", () => {
    for (const code of [
      "return [SELECT Id FROM Account LIMIT 5];",
      "return [SELECT Id FROM Account WHERE Id = :accountId];",
      "return [SELECT Id FROM Account WHERE Id IN :ids];",
      "return [SELECT Id FROM Account WHERE Name = 'x'];",
      "return [SELECT COUNT() FROM Account];",
      "return [SELECT Label FROM Setting__mdt];",
      "// [SELECT Id FROM Account]\nreturn 1;",
      "String s = '[SELECT Id FROM Account]';",
    ]) {
      expect(unbounded(code), code).toEqual([]);
    }
  });

  it("a WHERE inside a subquery does not bound the outer query; a bound query is checked alone", () => {
    expect(
      unbounded("return [SELECT Id, (SELECT Id FROM Contacts WHERE Id != null) FROM Account];"),
    ).toHaveLength(1);
    expect(
      unbounded("return [SELECT Id FROM Contact WHERE AccountId IN :[SELECT Id FROM Account]];"),
    ).toEqual(["[SELECT Id FROM Account]"]);
  });

  it("no_bulk: Trigger.new[0] without a loop is flagged; loops, handler calls and no use are not", () => {
    const t = (body: string) => `trigger T on Account (before insert) { ${body} }`;
    expect(detectNotBulkTrigger(t("Account a = Trigger.new[0]; a.Name = 'x';"))?.risk).toBe(
      "no_bulk",
    );
    expect(detectNotBulkTrigger(t("Account a = Trigger.old.get(0);"))?.risk).toBe("no_bulk");
    expect(detectNotBulkTrigger(t("for (Account a : Trigger.new) { a.Name = 'x'; }"))).toBeNull();
    expect(detectNotBulkTrigger(t("Account a = Trigger.new[0]; H.run(Trigger.new);"))).toBeNull();
    expect(detectNotBulkTrigger(t("H.run();"))).toBeNull();
    expect(
      detectNotBulkTrigger("public class C { void m(){ Account a = Trigger.new[0]; } }"),
    ).toBeNull();
  });
});

describe("keyset scan pages", () => {
  const ORG = asOrgId("orgScan");
  let store: SqliteGraphStore;
  beforeEach(async () => {
    store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    store.upsertOrg({ id: ORG, alias: "a", instanceUrl: "x", apiVersion: "59.0", createdAt: 1 });
    store.transaction(() =>
      store.mergeNodes(
        Array.from({ length: 1205 }, (_, i) => ({
          orgId: ORG,
          label: "ApexClass",
          qualifiedName: asQualifiedName(
            `ApexClass:${i % 2 ? "Acme_" : "Other"}${String(i).padStart(4, "0")}`,
          ),
          attributes: {},
          sourceHash: asSha256("h"),
          firstSeenAt: 1,
          lastSeenAt: 1,
          lastModifiedAt: 1,
        })),
      ),
    );
  });

  it("visits every node once, in bounded pages", () => {
    const scan = scanLabel(store, ORG, "ApexClass", { pageSize: 100 });
    const sizes: number[] = [];
    const seen = new Set<string>();
    for (const page of scan.pages) {
      sizes.push(page.length);
      for (const n of page) seen.add(String(n.qualifiedName));
    }
    expect(Math.max(...sizes)).toBe(100);
    expect(seen.size).toBe(1205);
    expect(scan.coverage()).toEqual({ scanned: 1205, total: 1205, complete: true });
  });

  it("pushes a name pattern into the query before paging (underscore is literal)", () => {
    expect(nameLikePattern("Acme_")).toBe("Acme\\_%");
    expect(nameLikePattern("Acme_*0")).toBe("Acme\\_%0");
    const scan = scanLabel(store, ORG, "ApexClass", {
      nameLike: nameLikePattern("Acme_"),
      pageSize: 50,
    });
    const names = [...scan.pages].flat().map((n) => String(n.qualifiedName));
    expect(names).toHaveLength(602);
    expect(names.every((n) => n.startsWith("ApexClass:Acme_"))).toBe(true);
    expect(scan.coverage()).toEqual({ scanned: 602, total: 602, complete: true });
  });
});
