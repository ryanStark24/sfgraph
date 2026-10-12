import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { foldDynamicSoql } from "../dynamic-soql.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Dynamic SOQL: a string literal starting with SELECT, optionally built by
 * `+` concatenation (and `q += …` continuation statements), is folded and
 * its outer SELECT fields become READS_FIELD edges with `dynamic: true`.
 * Only when the FROM object is itself literal text.
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

async function parseClass(className: string, body: string): Promise<Edge[]> {
  const r = await new ApexClassParser().parse({ className, body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return r.edges as unknown as Edge[];
}

describe("foldDynamicSoql", () => {
  it("folds literal concatenation, placeholdering non-literal operands", () => {
    const src = `String q = 'SELECT Id, ' + fields + ' FROM Widget__c' + ' WHERE x = 1';`;
    const out = foldDynamicSoql(src);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("SELECT Id, \u0001 FROM Widget__c WHERE x = 1");
  });

  it("follows `q += …` continuation statements on the same variable", () => {
    const src = `String q = 'SELECT Id, Name ';\n q += 'FROM Widget__c ';\n q += 'WHERE Id = :x';\n other();`;
    expect(foldDynamicSoql(src)).toEqual(["SELECT Id, Name FROM Widget__c WHERE Id = :x"]);
  });

  it("ignores SELECT literals inside comments and non-SELECT literals", () => {
    const src = `// String q = 'SELECT Id FROM A';\n/* 'SELECT Id FROM B' */ String s = 'Hello SELECT';`;
    expect(foldDynamicSoql(src)).toEqual([]);
  });
});

describe("ApexClassParser: dynamic SOQL READS_FIELD", () => {
  it("emits READS_FIELD dynamic=true for a declared query string", async () => {
    const edges = await parseClass(
      "WidgetQuery",
      `public class WidgetQuery {
        public List<SObject> load(Set<Id> ids) {
          String q = 'SELECT Id, Name, Size__c, Owner.Name, COUNT(Id) ' + 'FROM Widget__c WHERE Id IN :ids';
          return Database.query(q);
        }
      }`,
    );
    expect(dynamicReads(edges, "ApexMethod:WidgetQuery.load(1)")).toEqual([
      "CustomField:Widget__c.Id",
      "CustomField:Widget__c.Name",
      "CustomField:Widget__c.Size__c",
    ]);
  });

  it("handles a SELECT literal passed straight to Database.query", async () => {
    const edges = await parseClass(
      "WidgetQuery",
      `public class WidgetQuery {
        public List<SObject> load() {
          return Database.query('SELECT Color__c FROM Gadget__c LIMIT 1');
        }
      }`,
    );
    expect(dynamicReads(edges, "ApexMethod:WidgetQuery.load(0)")).toEqual([
      "CustomField:Gadget__c.Color__c",
    ]);
  });

  it("skips queries whose FROM object is not literal, and placeholder fields", async () => {
    const edges = await parseClass(
      "WidgetQuery",
      `public class WidgetQuery {
        public List<SObject> load(String obj, String ns) {
          String a = 'SELECT Id, Name FROM ' + obj;
          String b = 'SELECT Id, ' + ns + 'Code__c FROM Widget__c';
          String c = 'SELECT Color__c FROM Gadget' + ns;
          return Database.query(a);
        }
      }`,
    );
    expect(dynamicReads(edges, "ApexMethod:WidgetQuery.load(2)")).toEqual([
      "CustomField:Widget__c.Id",
    ]);
  });

  it("does not double-emit a field already read by inline SOQL", async () => {
    const edges = await parseClass(
      "WidgetQuery",
      `public class WidgetQuery {
        public void load() {
          List<Widget__c> ws = [SELECT Size__c FROM Widget__c];
          List<SObject> xs = Database.query('SELECT Size__c, Color__c FROM Widget__c');
        }
      }`,
    );
    const src = "ApexMethod:WidgetQuery.load(0)";
    expect(dynamicReads(edges, src)).toEqual(["CustomField:Widget__c.Color__c"]);
    const size = edges.filter(
      (e) =>
        e.relType === "READS_FIELD" &&
        String(e.srcQualifiedName) === src &&
        String(e.dstQualifiedName) === "CustomField:Widget__c.Size__c",
    );
    expect(size).toHaveLength(1);
  });
});

describe("round-3 fix 1: dynamic SOQL must look like SOQL", () => {
  it("ignores English text that starts with Select", async () => {
    const edges = await parseClass(
      "WidgetQuery",
      `public class WidgetQuery {
        public void hint() {
          String a = 'Select the from the list';
          String b = 'Select one from Account list';
          String c = 'Select a value from Widget__c above';
        }
      }`,
    );
    expect(dynamicReads(edges, "ApexMethod:WidgetQuery.hint(0)")).toEqual([]);
  });

  it("never falls through to a 'from X' inside a WHERE value when FROM is computed", async () => {
    const edges = await parseClass(
      "WidgetQuery",
      `public class WidgetQuery {
        public List<SObject> load(String o) {
          String q = 'SELECT Id FROM ' + o + ' WHERE Name = \\'from Account\\'';
          return Database.query(q);
        }
      }`,
    );
    expect(dynamicReads(edges, "ApexMethod:WidgetQuery.load(1)")).toEqual([]);
  });

  it("still accepts standard and namespaced objects followed by SOQL clauses", async () => {
    const edges = await parseClass(
      "WidgetQuery",
      `public class WidgetQuery {
        public void load(String w) {
          List<SObject> a = Database.query('SELECT Name FROM Account WHERE Id = :w LIMIT 1');
          List<SObject> b = Database.query('SELECT Code__c FROM ns__Gadget__c ' + w);
          List<SObject> c = Database.query('SELECT Id, Product2.Name FROM Asset');
        }
      }`,
    );
    // Account.Id is the WHERE operand (batch S, S5(i)).
    expect(dynamicReads(edges, "ApexMethod:WidgetQuery.load(1)")).toEqual([
      "CustomField:Account.Id",
      "CustomField:Account.Name",
      "CustomField:Asset.Id",
      "CustomField:ns__Gadget__c.Code__c",
    ]);
  });
});

describe("ApexClassParser: dynamic SOQL outside methods", () => {
  it("attributes a class-level query constant to the class", async () => {
    const edges = await parseClass(
      "WidgetQuery",
      `public class WidgetQuery {
        private static final String BASE = 'SELECT Id, Size__c ' +
          'FROM Widget__c';
        public List<SObject> load() {
          return Database.query(BASE + ' LIMIT 1');
        }
      }`,
    );
    expect(dynamicReads(edges, "ApexClass:WidgetQuery")).toEqual([
      "CustomField:Widget__c.Id",
      "CustomField:Widget__c.Size__c",
    ]);
    expect(dynamicReads(edges, "ApexMethod:WidgetQuery.load(0)")).toEqual([]);
  });
});

describe("ApexTriggerParser: dynamic SOQL READS_FIELD", () => {
  it("emits READS_FIELD dynamic=true from the trigger body", async () => {
    const r = await new ApexTriggerParser().parse(
      {
        triggerName: "WidgetTrigger",
        body: `trigger WidgetTrigger on Widget__c (after insert) {
          List<SObject> xs = Database.query('SELECT Region__c FROM Gadget__c');
        }`,
      },
      makeTestCtx(),
    );
    expect(dynamicReads(r.edges as unknown as Edge[], "ApexTrigger:WidgetTrigger")).toEqual([
      "CustomField:Gadget__c.Region__c",
    ]);
  });
});
