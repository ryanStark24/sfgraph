import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { extractFromAst } from "../ast-extractor.js";
import { ApexClassParser } from "../class.js";

/**
 * Task 14 batch P, rules 1-2 (AST path): WHERE / ORDER BY / GROUP BY fields
 * are READS_FIELD on the FROM object; dotted relationship fields are never
 * emitted as `CustomField:<relationshipName>.<field>` but returned as paths
 * (the post-merge resolver maps them through lookup metadata).
 */
async function parse(source: string): Promise<unknown> {
  const apex = (await import("apex-parser")) as any;
  const input = new apex.CaseInsensitiveInputStream("t.cls", source);
  const lexer = new apex.ApexLexer(input);
  const parser = new apex.ApexParser(new apex.CommonTokenStream(lexer));
  return parser.compilationUnit();
}

const src = `
  public class Q {
    public void run(Set<Id> ids) {
      List<OrderItem> xs = [SELECT Id, Product2.Name FROM OrderItem
        WHERE Quantity > 1 AND Order.Status = 'Draft' AND OrderId IN (SELECT Id FROM Order WHERE Type = 'X')
        ORDER BY UnitPrice DESC];
      List<AggregateResult> ag = [SELECT COUNT(Id) FROM Case GROUP BY Origin];
    }
  }`;

describe("extractFromAst: SOQL clause fields and relationship paths", () => {
  it("reads clause fields on the FROM object and returns dotted paths", async () => {
    const out = extractFromAst(await parse(src), {
      ctx: makeTestCtx(),
      classQname: "ApexClass:Q",
      effectiveName: "Q",
      namespace: null,
    });
    const reads = [
      ...new Set(
        out.edges
          .filter(
            (e: any) =>
              e.relType === "READS_FIELD" && String(e.srcQualifiedName) === "ApexMethod:Q.run(1)",
          )
          .map((e: any) => String(e.dstQualifiedName)),
      ),
    ].sort();
    expect(reads).toEqual([
      "CustomField:Case.Origin",
      "CustomField:Order.Id",
      "CustomField:Order.Type",
      "CustomField:OrderItem.Id",
      "CustomField:OrderItem.OrderId",
      "CustomField:OrderItem.Quantity",
      "CustomField:OrderItem.UnitPrice",
    ]);
    expect(out.relationshipPaths.get("ApexMethod:Q.run(1)")).toEqual([
      { object: "OrderItem", path: "Product2.Name", rel: "READS_FIELD" },
      { object: "OrderItem", path: "Order.Status", rel: "READS_FIELD" },
    ]);
  });

  it("AST mode stores the AST paths on the method node", async () => {
    const prev = process.env.SFGRAPH_APEX_PARSER;
    process.env.SFGRAPH_APEX_PARSER = "ast";
    try {
      const r = await new ApexClassParser().parse({ className: "Q", body: src }, makeTestCtx());
      const m = r.nodes.find((n) => String(n.qualifiedName) === "ApexMethod:Q.run(1)");
      expect((m?.attributes as Record<string, unknown>).apexRelationshipPaths).toEqual([
        { object: "OrderItem", path: "Product2.Name", rel: "READS_FIELD" },
        { object: "OrderItem", path: "Order.Status", rel: "READS_FIELD" },
      ]);
      expect(r.edges.some((e) => String(e.dstQualifiedName) === "CustomField:Product2.Name")).toBe(
        false,
      );
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "SFGRAPH_APEX_PARSER");
      else process.env.SFGRAPH_APEX_PARSER = prev;
    }
  });
});
