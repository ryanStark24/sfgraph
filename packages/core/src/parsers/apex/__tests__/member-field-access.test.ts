import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { ApexTriggerParser } from "../trigger.js";

/**
 * Field reads/writes through member access on SObject-typed variables
 * (`w.Color__c = x`, `if (w.Size__c > 0)`), SObject constructors
 * (`new Widget__c(Color__c = 'red')`) and trigger context
 * (`for (Widget__c w : Trigger.new)`, `Trigger.oldMap.get(id).Size__c`).
 */
type Edge = { relType: string; srcQualifiedName: unknown; dstQualifiedName: unknown };

function fieldEdges(edges: Edge[], src: string) {
  const pick = (rel: string) =>
    edges
      .filter((e) => e.relType === rel && String(e.srcQualifiedName).startsWith(src))
      .map((e) => String(e.dstQualifiedName))
      .filter((d) => d.startsWith("CustomField:"))
      .sort();
  return { reads: pick("READS_FIELD"), writes: pick("WRITES_FIELD") };
}

async function parseClass(className: string, body: string) {
  const r = await new ApexClassParser().parse({ className, body }, makeTestCtx());
  expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  return r.edges as unknown as Edge[];
}

describe("ApexClassParser: member-access field refs", () => {
  it("locals, params, enhanced-for vars, map.get(), list index", async () => {
    const body = `public class WidgetService {
      public void run(Widget__c param, Map<Id, Widget__c> oldMap, List<Widget__c> items) {
        Widget__c local = new Widget__c();
        local.Color__c = 'red';
        if (param.Size__c > 0) { local.Size__c = param.Size__c; }
        for (Widget__c w : items) {
          if (oldMap.get(w.Id).Status__c != w.Status__c) { w.Flag__c = true; }
        }
        String first = items[0].Label__c;
        local.Count__c += 1;
      }
    }`;
    const { reads, writes } = fieldEdges(
      await parseClass("WidgetService", body),
      "ApexMethod:WidgetService.run(",
    );
    expect(writes).toEqual([
      "CustomField:Widget__c.Color__c",
      "CustomField:Widget__c.Count__c",
      "CustomField:Widget__c.Flag__c",
      "CustomField:Widget__c.Size__c",
    ]);
    expect(reads).toEqual([
      "CustomField:Widget__c.Count__c",
      "CustomField:Widget__c.Label__c",
      "CustomField:Widget__c.Size__c",
      "CustomField:Widget__c.Status__c",
    ]);
  });

  it("SObject constructor name=value pairs are writes", async () => {
    const body = `public class WidgetFactory {
      public static void make(Id parentId) {
        insert new Widget__c(
          Id = parentId,
          Parent__c = parentId,
          Color__c  = 'blue'
        );
        Account a = new Account(Name = 'x', Tier__c = 'Gold');
        Wrapper wr = new Wrapper(parentId);
      }
    }`;
    const { writes } = fieldEdges(
      await parseClass("WidgetFactory", body),
      "ApexMethod:WidgetFactory.make(1)",
    );
    expect(writes).toEqual([
      "CustomField:Account.Name",
      "CustomField:Account.Tier__c",
      "CustomField:Widget__c.Color__c",
      "CustomField:Widget__c.Parent__c",
    ]);
  });

  it("class-level SObject fields resolve inside methods", async () => {
    const body = `public class WidgetHolder {
      private Widget__c current;
      public void touch() { current.Touched__c = true; }
    }`;
    const { writes } = fieldEdges(
      await parseClass("WidgetHolder", body),
      "ApexMethod:WidgetHolder.touch(0)",
    );
    expect(writes).toEqual(["CustomField:Widget__c.Touched__c"]);
  });

  it("ignores comments, strings, method calls, untyped/SObject/Apex-class receivers", async () => {
    const body = `public class Noise {
      public void run(SObject so, Helper h, Widget__c w) {
        // w.Commented__c = 1;
        /* w.Blocked__c = 2; */
        String s = 'w.InString__c';
        so.put('Color__c', 1);
        Object o = so.get('Size__c');
        h.config = 3;
        String t = h.label;
        w.doThing();
        String n = w.Parent__r.Name;
        String v = unknownVar.Other__c;
      }
    }`;
    const { reads, writes } = fieldEdges(
      await parseClass("Noise", body),
      "ApexMethod:Noise.run(3)",
    );
    expect(writes).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("standard fields on a standard object are recorded", async () => {
    const body = `public class AcctTouch {
      public void run(Account acc) { acc.Name = acc.Name + '!'; }
    }`;
    const { reads, writes } = fieldEdges(
      await parseClass("AcctTouch", body),
      "ApexMethod:AcctTouch.run(1)",
    );
    expect(reads).toEqual(["CustomField:Account.Name"]);
    expect(writes).toEqual(["CustomField:Account.Name"]);
  });

  it("does not duplicate a READS_FIELD already emitted from SOQL", async () => {
    const body = `public class Dedup {
      public void run() {
        Widget__c w = [SELECT Id, Color__c FROM Widget__c LIMIT 1];
        String c = w.Color__c;
      }
    }`;
    const edges = await parseClass("Dedup", body);
    const color = edges.filter(
      (e) =>
        e.relType === "READS_FIELD" &&
        String(e.dstQualifiedName) === "CustomField:Widget__c.Color__c",
    );
    expect(color).toHaveLength(1);
  });
});

describe("ApexClassParser: receiver scoping", () => {
  it("a later local declaration does not retype an earlier use of a class field", async () => {
    const body = `public class LaterLocal {
      Account acc;
      public void m() {
        acc.Name = 'y';
        Contact acc = new Contact();
      }
    }`;
    const { writes } = fieldEdges(
      await parseClass("LaterLocal", body),
      "ApexMethod:LaterLocal.m(0)",
    );
    expect(writes).toEqual(["CustomField:Account.Name"]);
  });

  it("constructor locals do not leak into class scope; properties are fields", async () => {
    const body = `public class PropHolder {
      public Account acc { get; set; }
      public PropHolder() {
        Contact acc = new Contact();
      }
      public void m() { acc.Name = 'z'; }
    }`;
    const { writes } = fieldEdges(
      await parseClass("PropHolder", body),
      "ApexMethod:PropHolder.m(0)",
    );
    expect(writes).toEqual(["CustomField:Account.Name"]);
  });

  it("inner classes resolve fields from their own class body", async () => {
    const body = `public class Outer {
      public class In1 { Account rec; }
      public class In2 {
        Contact rec;
        void m() { rec.Email = 'q'; }
      }
    }`;
    const { writes } = fieldEdges(await parseClass("Outer", body), "ApexMethod:Outer.m(0)");
    expect(writes).toEqual(["CustomField:Contact.Email"]);
  });
});

describe("ApexTriggerParser: member-access field refs", () => {
  it("Trigger.new loop vars, Trigger.oldMap.get(), Trigger.new[i] resolve to the trigger object", async () => {
    const body = `trigger WidgetTrigger on Widget__c (before update) {
      for (Widget__c w : Trigger.new) {
        if (Trigger.oldMap.get(w.Id).Size__c != w.Size__c) { w.Changed__c = true; }
      }
      // w.Ghost__c = 1;
      Trigger.new[0].Note__c = 'first';
      Widget__c prev = Trigger.old[0];
      String c = prev.Color__c;
    }`;
    const r = await new ApexTriggerParser().parse(
      { triggerName: "WidgetTrigger", body },
      makeTestCtx(),
    );
    const { reads, writes } = fieldEdges(r.edges as unknown as Edge[], "ApexTrigger:WidgetTrigger");
    expect(writes).toEqual(["CustomField:Widget__c.Changed__c", "CustomField:Widget__c.Note__c"]);
    expect(reads).toEqual(["CustomField:Widget__c.Color__c", "CustomField:Widget__c.Size__c"]);
  });
});

describe("AST extractor dotted field refs keep the __c suffix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("emits CustomField:<Obj>.<Field__c>", async () => {
    vi.stubEnv("SFGRAPH_APEX_PARSER", "ast");
    const body = `public class AstWidget {
      public String read(Widget__c w) { return w.Color__c; }
    }`;
    const { reads } = fieldEdges(
      await parseClass("AstWidget", body),
      "ApexMethod:AstWidget.read(1)",
    );
    expect(reads.filter((d) => d === "CustomField:Widget__c.Color__c")).toHaveLength(1);
    expect(reads).not.toContain("CustomField:Widget__c.Color");
  });
});
