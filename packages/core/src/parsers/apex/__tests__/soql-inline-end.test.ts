import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { maskApex } from "../dynamic-soql.js";
import { findInlineQueries } from "../soql-fields.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Task 14 batch S, S4: an inline `[SELECT …]` query ends at the `]` that
 * brings bracket depth back to 0, counted outside `'…'` string literals
 * (with `\'` escapes). A bind expression may index a list or map
 * (`:ids[0]`, `:m.get(x)[1]`) or hold another inline query; neither ends
 * the outer query. An unterminated query yields nothing (no edges, no throw).
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes?: Record<string, unknown>;
};

const texts = (code: string) => findInlineQueries(code).map((q) => q.text);

describe("findInlineQueries (bracket-depth scan)", () => {
  it("does not end at a nested list index in a bind", () => {
    const code = "x = [SELECT Id FROM Account WHERE Id = :ids[0] AND Name = :n];";
    expect(texts(code)).toEqual(["[SELECT Id FROM Account WHERE Id = :ids[0] AND Name = :n]"]);
  });

  it("does not end at an index after a method call in a bind", () => {
    const code = "x = [select Id from Account where Id = :m.get(x)[1] order by Name];";
    expect(texts(code)).toEqual(["[select Id from Account where Id = :m.get(x)[1] order by Name]"]);
  });

  it("ignores a ] inside a string literal", () => {
    const code = "x = [SELECT Id FROM Account WHERE Name = 'a]b' AND Type = :t];";
    expect(texts(code)).toEqual(["[SELECT Id FROM Account WHERE Name = 'a]b' AND Type = :t]"]);
  });

  it("handles an escaped quote inside a string literal", () => {
    const code = "x = [SELECT Id FROM Account WHERE Name = 'O\\'Brien ]' AND Type = :t];";
    expect(texts(code)).toEqual([
      "[SELECT Id FROM Account WHERE Name = 'O\\'Brien ]' AND Type = :t]",
    ]);
  });

  it("finds an inner inline query held in a bind as a query of its own", () => {
    const code =
      "x = [SELECT Id FROM Contact WHERE AccountId IN :[SELECT Id FROM Account] AND Email = :e];";
    expect(texts(code)).toEqual([
      "[SELECT Id FROM Contact WHERE AccountId IN :[SELECT Id FROM Account] AND Email = :e]",
      "[SELECT Id FROM Account]",
    ]);
  });

  it("yields nothing for an unterminated query and never throws", () => {
    expect(texts("x = [SELECT Id FROM Account WHERE Id = :ids[0];")).toEqual([]);
    expect(texts("x = [SELECT Id FROM Account WHERE Name = 'open")).toEqual([]);
    // A later complete query is still found.
    expect(texts("a = [SELECT Id FROM A WHERE x = :y[0; b = [SELECT Id FROM B];")).toEqual([
      "[SELECT Id FROM B]",
    ]);
  });

  it("expects comment-masked input (documented precondition)", () => {
    const raw = "// don't\nx = [SELECT Id FROM A];";
    expect(texts(raw)).toEqual([]);
    expect(texts(maskApex(raw))).toEqual(["[SELECT Id FROM A]"]);
  });

  it("matches the start keyword case-insensitively and allows whitespace", () => {
    expect(texts("x = [ \n select Id from Account];")).toEqual(["[ \n select Id from Account]"]);
    expect(texts("x = list[0]; y = [SELECTED];")).toEqual([]);
  });
});

async function parseClass(body: string) {
  const r = await new ApexClassParser().parse({ className: "Svc", body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return r.edges as unknown as Edge[];
}

const dsts = (edges: Edge[], rel: string, src: string) =>
  [
    ...new Set(
      edges
        .filter((e) => e.relType === rel && String(e.srcQualifiedName) === src)
        .map((e) => String(e.dstQualifiedName)),
    ),
  ].sort();

describe("ApexClassParser: inline SOQL with nested brackets (S4)", () => {
  it("reads clause fields after a nested index and keeps the full query text", async () => {
    const edges = await parseClass(`public class Svc {
  public static void run(List<Id> ids, Map<String, List<Id>> m) {
    List<Account> a = [SELECT Id FROM Account WHERE Id = :ids[0] AND Name = :m.get('k')[1] ORDER BY Rating__c];
  }
}`);
    const src = "ApexMethod:Svc.run(2)";
    expect(dsts(edges, "READS_FIELD", src)).toEqual([
      "CustomField:Account.Id",
      "CustomField:Account.Name",
      "CustomField:Account.Rating__c",
    ]);
    const soql = edges.find(
      (e) => e.relType === "EXECUTES_SOQL" && String(e.srcQualifiedName) === src,
    );
    expect(String(soql?.attributes?.query)).toMatch(/ORDER BY Rating__c\]$/);
  });

  it("attributes an inner bind query to its own object, not the outer one", async () => {
    const edges = await parseClass(`public class Svc {
  public static void run() {
    List<Contact> c = [SELECT Id FROM Contact WHERE AccountId IN :[SELECT Id FROM Account WHERE Industry = 'x'] AND Email = :e];
  }
}`);
    const src = "ApexMethod:Svc.run(0)";
    expect(dsts(edges, "EXECUTES_SOQL", src)).toEqual([
      "CustomObject:Account",
      "CustomObject:Contact",
    ]);
    expect(dsts(edges, "READS_FIELD", src)).toEqual([
      "CustomField:Account.Id",
      "CustomField:Account.Industry",
      "CustomField:Contact.AccountId",
      "CustomField:Contact.Email",
      "CustomField:Contact.Id",
    ]);
  });

  it("does not read a relationship path after a nested index as class member access", async () => {
    const edges = await parseClass(`public class Svc {
  public static void run(List<Id> ids) {
    List<Case> c = [SELECT Id FROM Case WHERE Id = :ids[0] AND Owner.Name = 'x'];
  }
}`);
    expect(dsts(edges, "REFERENCES", "ApexMethod:Svc.run(1)")).not.toContain("ApexClass:Owner");
  });
});

describe("ApexTriggerParser: inline SOQL with nested brackets (S4)", () => {
  it("keeps the full query text and outer object", async () => {
    const body = `trigger T on Account (before insert) {
  List<Id> ids = new List<Id>();
  List<Contact> c = [SELECT Id FROM Contact WHERE AccountId = :ids[0] AND Email != null];
}`;
    const r = await new ApexTriggerParser().parse({ triggerName: "T", body }, makeTestCtx());
    const soql = (r.edges as unknown as Edge[]).filter((e) => e.relType === "EXECUTES_SOQL");
    expect(soql.map((e) => String(e.dstQualifiedName))).toEqual(["CustomObject:Contact"]);
    expect(String(soql[0]?.attributes?.query)).toMatch(/Email != null\]$/);
  });

  // A class with this text fails the Apex grammar and never reaches the
  // scanner; the trigger body path has no grammar gate, so it is where an
  // unterminated query meets the scanner.
  it("an unterminated query emits no SOQL edge and does not throw", async () => {
    const body = `trigger T on Account (before insert) {
  List<Id> ids = new List<Id>();
  Object o = [SELECT Id FROM Account WHERE Id = :ids[0];
}`;
    const r = await new ApexTriggerParser().parse({ triggerName: "T", body }, makeTestCtx());
    const soql = (r.edges as unknown as Edge[]).filter((e) => e.relType === "EXECUTES_SOQL");
    expect(soql).toEqual([]);
    expect(r.nodes.find((n) => n.label === "ApexTrigger")).toBeDefined();
  });
});
