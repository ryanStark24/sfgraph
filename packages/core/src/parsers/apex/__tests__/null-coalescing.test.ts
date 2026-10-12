import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";

/**
 * The bundled apex-parser grammar predates Apex's null-coalescing operator
 * (`a ?? b`), so any class using it used to become a ParseError node and drop
 * out of the graph. Its message was also stored as "[object Object]" because
 * the grammar's error listener throws a plain object, not an Error.
 */
async function parse(className: string, body: string) {
  return new ApexClassParser().parse({ className, body }, makeTestCtx());
}

describe("ApexClassParser: null-coalescing and safe navigation", () => {
  it("parses a class that uses `??`", async () => {
    const body = `public class Coalesce {
      public String pick(Widget__c w, String fallback) {
        String v = w.Label__c ?? fallback ?? '';
        Integer n = (Integer) (w.Count__c ?? 0);
        return v + n;
      }
    }`;
    const r = await parse("Coalesce", body);
    expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
    expect(r.nodes.find((n) => String(n.qualifiedName) === "ApexClass:Coalesce")).toBeDefined();
    expect(
      r.nodes.find((n) => String(n.qualifiedName) === "ApexMethod:Coalesce.pick(2)"),
    ).toBeDefined();
  });

  it("parses `?.` combined with `??`", async () => {
    const body = `public class SafeNav {
      public String name(Widget__c w) {
        return w?.Parent__r?.Name ?? 'none';
      }
    }`;
    const r = await parse("SafeNav", body);
    expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
  });

  it("leaves `??` inside strings and comments untouched in stored source", async () => {
    const body = `public class Literal {
      // what ?? means
      public String q() { return 'really??'; }
    }`;
    const r = await parse("Literal", body);
    expect(r.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
    const snip = r.snippets?.find((s) => String(s.qualifiedName) === "ApexMethod:Literal.q(0)");
    expect(snip?.sourceText).toContain("'really??'");
  });

  it("serialises a genuine syntax error as line:column message", async () => {
    const r = await parse("Broken", "public class Broken { public void x() { Integer i = ; } }");
    const pe = r.nodes.find((n) => n.label === "ParseError");
    expect(pe).toBeDefined();
    const msg = String((pe?.attributes as Record<string, unknown>).message);
    expect(msg).not.toContain("[object Object]");
    expect(msg).toMatch(/^1:\d+ /);
  });
});
