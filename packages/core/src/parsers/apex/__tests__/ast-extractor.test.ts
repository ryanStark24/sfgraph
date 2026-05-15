import { describe, expect, it } from "vitest";
import { extractFromAst } from "../ast-extractor.js";
import { makeTestCtx } from "../../__tests__/_harness.js";

async function parse(source: string): Promise<unknown> {
  const apex = await import("apex-parser");
  const {
    ApexLexer,
    ApexParser,
    CommonTokenStream,
    CaseInsensitiveInputStream,
    ThrowingErrorListener,
  } = apex as any;
  const input = new CaseInsensitiveInputStream("test.cls", source);
  const lexer = new ApexLexer(input);
  lexer.removeErrorListeners();
  lexer.addErrorListener(new ThrowingErrorListener());
  const tokens = new CommonTokenStream(lexer);
  const parser = new ApexParser(tokens);
  parser.removeErrorListeners();
  parser.addErrorListener(new ThrowingErrorListener());
  return parser.compilationUnit();
}

function dstSet(edges: { dstQualifiedName: string }[], rel?: string, all?: any[]): string[] {
  const filtered = rel ? (all ?? edges).filter((e: any) => e.relType === rel) : edges;
  return filtered.map((e: any) => String(e.dstQualifiedName)).sort();
}

describe("extractFromAst", () => {
  it("captures SOQL FROM and SELECT-list field reads", async () => {
    const src = `
      public class Foo {
        public void run() {
          List<Account> accs = [SELECT Id, Name, Phone FROM Account];
        }
      }
    `;
    const tree = await parse(src);
    const out = extractFromAst(tree, {
      ctx: makeTestCtx(),
      classQname: "ApexClass:Foo",
      effectiveName: "Foo",
      namespace: null,
    });

    expect(out.edges.some((e: any) => e.relType === "EXECUTES_SOQL" && e.dstQualifiedName === "CustomObject:Account")).toBe(true);
    const reads = out.edges.filter((e: any) => e.relType === "READS_FIELD").map((e: any) => String(e.dstQualifiedName)).sort();
    expect(reads).toEqual([
      "CustomField:Account.Id",
      "CustomField:Account.Name",
      "CustomField:Account.Phone",
    ]);
  });

  it("captures dotted field access via local-variable type inference", async () => {
    const src = `
      public class Bar {
        public void run() {
          Account a = new Account();
          String n = a.Name;
        }
      }
    `;
    const tree = await parse(src);
    const out = extractFromAst(tree, {
      ctx: makeTestCtx(),
      classQname: "ApexClass:Bar",
      effectiveName: "Bar",
      namespace: null,
    });

    expect(out.edges.some((e: any) =>
      e.relType === "READS_FIELD" && e.dstQualifiedName === "CustomField:Account.Name")).toBe(true);
    // INSTANCE_OF for new Account()
    expect(out.edges.some((e: any) =>
      e.relType === "INSTANCE_OF" && e.dstQualifiedName === "ApexClass:Account")).toBe(true);
  });

  it("captures method calls with real arity", async () => {
    const src = `
      public class Caller {
        public void run() {
          MyService.doIt(1, 'two', null);
          MyService.doIt();
        }
      }
    `;
    const tree = await parse(src);
    const out = extractFromAst(tree, {
      ctx: makeTestCtx(),
      classQname: "ApexClass:Caller",
      effectiveName: "Caller",
      namespace: null,
    });

    const calls = out.edges.filter((e: any) => e.relType === "CALLS").map((e: any) => String(e.dstQualifiedName)).sort();
    expect(calls).toContain("ApexMethod:MyService.doIt(0)");
    expect(calls).toContain("ApexMethod:MyService.doIt(3)");
    // None should still have the (?) arity placeholder.
    for (const c of calls) expect(c).not.toMatch(/\(\?\)$/);
  });

  it("infers sObject type for for-each loop variables", async () => {
    const src = `
      public class Loop {
        public void run() {
          for (Account a : [SELECT Id, Name FROM Account]) {
            String s = a.Name;
          }
        }
      }
    `;
    const tree = await parse(src);
    const out = extractFromAst(tree, {
      ctx: makeTestCtx(),
      classQname: "ApexClass:Loop",
      effectiveName: "Loop",
      namespace: null,
    });

    // Both SOQL select-list AND dotted access produce Account.Name reads.
    const accNameReads = out.edges.filter(
      (e: any) => e.relType === "READS_FIELD" && e.dstQualifiedName === "CustomField:Account.Name",
    );
    expect(accNameReads.length).toBeGreaterThanOrEqual(1);
  });

  it("emits EXECUTES_DML and resolves target sObject when known", async () => {
    const src = `
      public class Writer {
        public void run() {
          Account a = new Account(Name = 'X');
          insert a;
        }
      }
    `;
    const tree = await parse(src);
    const out = extractFromAst(tree, {
      ctx: makeTestCtx(),
      classQname: "ApexClass:Writer",
      effectiveName: "Writer",
      namespace: null,
    });

    const dml = out.edges.filter((e: any) => e.relType === "EXECUTES_DML");
    expect(dml.length).toBe(1);
    expect((dml[0] as any).attributes.targetSObject).toBe("Account");
    expect(out.edges.some((e: any) =>
      e.relType === "WRITES_FIELD" && e.dstQualifiedName === "CustomObject:Account")).toBe(true);
  });

  it("captures extends and implements declarations", async () => {
    const src = `
      public class Child extends Parent implements MyIface, Other {}
    `;
    const tree = await parse(src);
    const out = extractFromAst(tree, {
      ctx: makeTestCtx(),
      classQname: "ApexClass:Child",
      effectiveName: "Child",
      namespace: null,
    });

    expect(out.edges.some((e: any) => e.relType === "EXTENDS" && e.dstQualifiedName === "ApexClass:Parent")).toBe(true);
    const impls = out.edges.filter((e: any) => e.relType === "IMPLEMENTS").map((e: any) => String(e.dstQualifiedName)).sort();
    expect(impls).toEqual(["ApexInterface:MyIface", "ApexInterface:Other"]);
  });
});
