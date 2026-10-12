import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../index.js";

/**
 * Audit dangling-08: when apex-parser rejects a class body, only a ParseError
 * node is emitted, so every inbound edge to ApexClass:<name> dangles.
 */
describe("audit dangling-08: parse failure keeps a stub class node", () => {
  it("emits a stub ApexClass node (plus the ParseError) on syntax error", async () => {
    const result = await new ApexClassParser().parse(
      {
        className: "BrokenHelperTest",
        metaXml: "<ApexClass/>",
        body: "public class BrokenHelperTest { public void m( { }",
      },
      makeTestCtx(),
    );
    const qnames = result.nodes.map((n) => String(n.qualifiedName));
    expect(qnames).toContain("ParseError:ApexClass:BrokenHelperTest");
    const stub = result.nodes.find((n) => String(n.qualifiedName) === "ApexClass:BrokenHelperTest");
    expect(stub?.label).toBe("ApexClass");
  });

  it("review M-2: the stub of an @isTest class keeps isTest", async () => {
    const parse = (body: string) =>
      new ApexClassParser().parse({ className: "T", metaXml: "<ApexClass/>", body }, makeTestCtx());
    const stub = async (body: string) =>
      (await parse(body)).nodes.find((n) => String(n.qualifiedName) === "ApexClass:T");
    const t = await stub("@isTest\nprivate class T { static void m( { }");
    expect(t?.attributes).toMatchObject({ parseFailed: true, isTest: true });
    const t2 = await stub("@IsTest(SeeAllData=false) private class T { static void m( { }");
    expect(t2?.attributes.isTest).toBe(true);
    // A comment mentioning @isTest is not the annotation.
    const p = await stub("// not @isTest\npublic class T { void m( { }");
    expect(p?.attributes.isTest).toBe(false);
  });
});
