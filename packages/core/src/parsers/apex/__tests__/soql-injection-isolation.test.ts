import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";

/** The injection check must never cost the class: a long alias chain still parses. */
describe("soqlInjection on a class with a 2000-alias method", () => {
  it("parses the class and still reports the finding", async () => {
    const lines = ["String v0 = term;"];
    for (let i = 1; i < 2000; i++) lines.push(`    String v${i} = v${i - 1};`);
    const body = `public class Aliases {
  public static List<Account> find(String term) {
    ${lines.join("\n")}
    return Database.query('SELECT Id FROM Account WHERE Name = \\'' + v1999 + '\\'');
  }
}`;
    const result = await new ApexClassParser().parse({ className: "Aliases", body }, makeTestCtx());
    expect(result.nodes.find((n) => n.label === "ParseError")).toBeUndefined();
    const method = result.nodes.find((n) => n.label === "ApexMethod");
    expect(method).toBeDefined();
    const spots = (method?.attributes as Record<string, unknown>).soqlInjection as
      | Array<{ variable?: string }>
      | undefined;
    expect(spots?.[0]?.variable).toBe("term");
  });
});
