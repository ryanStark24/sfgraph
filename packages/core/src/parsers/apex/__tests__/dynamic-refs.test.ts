import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { describe, expect, it } from "vitest";
import { findDeadCode } from "../../../analyze/dead-code.js";
import { SqliteGraphStore } from "../../../storage/sqlite/graph-store.js";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * References Apex makes through names: custom labels (`Label.X`), classes
 * loaded by name (`Type.forName('X')`), fields read or written by name on a
 * typed record (`rec.get('F')` / `rec.put('F', v)`) and field tokens
 * (`Account.Industry`, `SObjectType.Account.fields.Industry`). Only targets
 * the text pins down; anything computed or ambiguous yields nothing.
 */
type Edge = {
  relType: string;
  srcQualifiedName: unknown;
  dstQualifiedName: unknown;
  attributes: Record<string, unknown>;
};

const dsts = (edges: Edge[], rel: string, src: string, prefix = ""): string[] =>
  edges
    .filter(
      (e) =>
        e.relType === rel &&
        String(e.srcQualifiedName) === src &&
        String(e.dstQualifiedName).startsWith(prefix),
    )
    .map((e) => String(e.dstQualifiedName))
    .sort();

async function parse(className: string, body: string, namespace: string | null = null) {
  const ctx = { ...makeTestCtx(), namespace };
  const r = await new ApexClassParser().parse({ className, body }, ctx);
  return r.edges as unknown as Edge[];
}

describe("custom labels", () => {
  it("links Label.X and System.Label.X, in methods and field initialisers", async () => {
    const edges = await parse(
      "Msgs",
      `public class Msgs {
        private static final String GREETING = System.Label.Greeting_Text;
        public String run() {
          String a = Label.Error_Msg;
          String b = system.label.Other_Msg;
          String c = Label.acme.Packaged_Msg;
          // String d = Label.Commented_Out;
          String e = 'Label.In_A_String';
          return a + Label.Error_Msg;
        }
      }`,
    );
    expect(dsts(edges, "REFERENCES_LABEL", "ApexMethod:Msgs.run(0)")).toEqual([
      "CustomLabel:Error_Msg",
      "CustomLabel:Other_Msg",
      "CustomLabel:acme__Packaged_Msg",
    ]);
    expect(dsts(edges, "REFERENCES_LABEL", "ApexClass:Msgs")).toEqual([
      "CustomLabel:Greeting_Text",
    ]);
  });

  it("strips the org's own namespace and skips a variable named Label", async () => {
    const edges = await parse(
      "Msgs",
      `public class Msgs {
        public String run(Wrapper Label) {
          String a = Label.acme.Own_Msg;
          return Label.text;
        }
      }`,
      "acme",
    );
    expect(dsts(edges, "REFERENCES_LABEL", "ApexMethod:Msgs.run(1)")).toEqual([]);
    const edges2 = await parse(
      "Msgs",
      `public class Msgs {
        public String run() { return Label.acme.Own_Msg + Label.get('', 'Dyn'); }
      }`,
      "acme",
    );
    expect(dsts(edges2, "REFERENCES_LABEL", "ApexMethod:Msgs.run(0)")).toEqual([
      "CustomLabel:Own_Msg",
    ]);
  });

  it("links labels in a trigger body", async () => {
    const r = await new ApexTriggerParser().parse(
      {
        triggerName: "T",
        body: "trigger T on Account (before insert) { for (Account a : Trigger.new) a.addError(Label.Blocked); }",
      },
      makeTestCtx(),
    );
    expect(dsts(r.edges as unknown as Edge[], "REFERENCES_LABEL", "ApexTrigger:T")).toEqual([
      "CustomLabel:Blocked",
    ]);
  });
});

describe("Type.forName", () => {
  it("links a literal class name (one- and two-argument forms)", async () => {
    const edges = await parse(
      "Factory",
      `public class Factory {
        public Object make(String computed) {
          Object a = Type.forName('AccountHandler').newInstance();
          Object b = System.Type.forName('', 'ContactHandler').newInstance();
          Object c = Type.forName(null, 'CaseHandler');
          Object d = Type.forName(computed);
          Object e = Type.forName('othernsx', 'Foreign');
          Object f = Type.forName('Outer.Inner');
          return a;
        }
      }`,
    );
    expect(dsts(edges, "REFERENCES", "ApexMethod:Factory.make(1)", "ApexClass:")).toEqual([
      "ApexClass:AccountHandler",
      "ApexClass:CaseHandler",
      "ApexClass:ContactHandler",
    ]);
    const e = edges.find((x) => String(x.dstQualifiedName) === "ApexClass:AccountHandler");
    expect(e?.attributes.via).toBe("type-forname");
  });

  it("the org's own namespace resolves to the local class", async () => {
    const edges = await parse(
      "Factory",
      `public class Factory {
        public Object make() {
          return Type.forName('acme', 'Handler').newInstance() + Type.forName('acme.Other');
        }
      }`,
      "acme",
    );
    expect(dsts(edges, "REFERENCES", "ApexMethod:Factory.make(0)", "ApexClass:")).toEqual([
      "ApexClass:Handler",
      "ApexClass:Other",
    ]);
  });

  it("a class loaded only by Type.forName is not reported as dead code", async () => {
    const store = new SqliteGraphStore({ dbPath: ":memory:" });
    await store.init();
    try {
      const ctx = makeTestCtx();
      const orgId = asOrgId(ctx.orgId);
      for (const [className, body] of [
        [
          "Factory",
          `public class Factory {
            public static Object make() { return Type.forName('PluginImpl').newInstance(); }
          }`,
        ],
        ["PluginImpl", "public class PluginImpl { public void go() { } }"],
        ["Orphan", "public class Orphan { public void go() { } }"],
      ] as const) {
        const r = await new ApexClassParser().parse({ className, body }, ctx);
        store.mergeNodes(r.nodes);
        store.mergeEdges(r.edges);
      }
      const dead = findDeadCode(store, orgId).map((d) => String(d.qualifiedName));
      expect(dead).toContain("ApexClass:Orphan");
      expect(dead).not.toContain("ApexClass:PluginImpl");
      expect(
        store
          .listEdgesTo(orgId, asQualifiedName("ApexClass:PluginImpl"))
          .map((e) => String(e.srcQualifiedName)),
      ).toEqual(["ApexMethod:Factory.make(0)"]);
    } finally {
      await store.close();
    }
  });
});

describe("rec.get / rec.put by field name", () => {
  it("reads and writes the named field on a typed record", async () => {
    const edges = await parse(
      "Rec",
      `public class Rec {
        public void run(Account acc, List<Contact> cs) {
          Object a = acc.get('Industry');
          acc.put('Tier__c', 'Gold');
          Widget__c w = new Widget__c();
          w.put('Size__c', 3);
          Object b = w.get('Name');
          Object c = cs[0].get('Email');
        }
      }`,
    );
    const src = "ApexMethod:Rec.run(2)";
    expect(dsts(edges, "READS_FIELD", src)).toEqual([
      "CustomField:Account.Industry",
      "CustomField:Widget__c.Name",
    ]);
    expect(dsts(edges, "WRITES_FIELD", src)).toEqual([
      "CustomField:Account.Tier__c",
      "CustomField:Widget__c.Size__c",
    ]);
    const e = edges.find((x) => String(x.dstQualifiedName) === "CustomField:Account.Industry");
    expect(e?.attributes.via).toBe("sobject-get");
  });

  it("skips SObject / Map / untyped receivers and computed names", async () => {
    const edges = await parse(
      "Rec",
      `public class Rec {
        public void run(SObject so, Map<String, Object> m, String f, Account acc) {
          so.get('Name');
          so.put('Name', 'x');
          m.get('Name');
          m.put('Name', 1);
          unknown.get('Name');
          Wrapper w = new Wrapper();
          w.get('Amount__c');
          w.put('Amount__c', 1);
          acc.get(f);
          acc.put(f, 1);
        }
      }`,
    );
    const src = "ApexMethod:Rec.run(4)";
    expect(dsts(edges, "READS_FIELD", src)).toEqual([]);
    expect(dsts(edges, "WRITES_FIELD", src)).toEqual([]);
  });
});

describe("field tokens", () => {
  it("links describe-style and token-style field references", async () => {
    const edges = await parse(
      "Tok",
      `public class Tok {
        public void run() {
          Schema.DescribeFieldResult a = Schema.SObjectType.Account.fields.Industry;
          Schema.DescribeFieldResult b = SObjectType.Widget__c.fields.Size__c.getDescribe();
          Schema.DescribeFieldResult c = Account.Rating.getDescribe();
          Schema.SObjectField d = Contact.Email;
          List<Schema.SObjectField> fs = new List<Schema.SObjectField>{ Gadget__c.Color__c };
          Schema.SObjectType t = Account.SObjectType;
          List<Contact> rows = [SELECT Account.Name FROM Contact];
        }
      }`,
    );
    expect(dsts(edges, "REFERENCES", "ApexMethod:Tok.run(0)", "CustomField:")).toEqual([
      "CustomField:Account.Industry",
      "CustomField:Account.Rating",
      "CustomField:Contact.Email",
      "CustomField:Gadget__c.Color__c",
      "CustomField:Widget__c.Size__c",
    ]);
    const e = edges.find((x) => String(x.dstQualifiedName) === "CustomField:Contact.Email");
    expect(e?.attributes.via).toBe("field-token");
  });

  it("a variable named like an object is a record, not a token", async () => {
    const edges = await parse(
      "Tok",
      `public class Tok {
        public void run(Opportunity account) {
          String s = account.Name;
          Schema.SObjectField f = SObjectType.Account.fields.getMap().get('x');
          String g = Account.getSObjectType().getDescribe().getName();
        }
      }`,
    );
    expect(dsts(edges, "REFERENCES", "ApexMethod:Tok.run(1)", "CustomField:")).toEqual([]);
  });
});
