import { describe, expect, it } from "vitest";
import { makeTestCtx } from "../../__tests__/_harness.js";
import { ApexClassParser } from "../class.js";
import { computeLoopRanges, parseSoql } from "../class.js";

async function parse(body: string) {
  return new ApexClassParser().parse({ className: "Svc", body }, makeTestCtx());
}

describe("parseSoql — outer object, not the subquery's", () => {
  it("picks the FROM at paren-depth 0 (child subquery)", () => {
    expect(parseSoql(" Id, (SELECT Id FROM Contacts) FROM Account WHERE x = 1").object).toBe(
      "Account",
    );
  });
  it("ignores a semi-join subquery in WHERE", () => {
    expect(parseSoql(" Id FROM Account WHERE Id IN (SELECT AccountId FROM Contact)").object).toBe(
      "Account",
    );
  });
});

describe("ApexClassParser — SOQL / named-credential / loop body analysis", () => {
  it("emits EXECUTES_SOQL to the OUTER object for a query with a subquery", async () => {
    const body = `public class Svc {
      void run() {
        List<Account> a = [SELECT Id, (SELECT Id FROM Contacts) FROM Account];
      }
    }`;
    const soql = (await parse(body)).edges.filter((e) => e.relType === "EXECUTES_SOQL");
    expect(soql.map((e) => String(e.dstQualifiedName))).toContain("CustomObject:Account");
    expect(soql.some((e) => String(e.dstQualifiedName) === "CustomObject:Contacts")).toBe(false);
  });

  it("captures EVERY named credential, not just the first", async () => {
    const body = `public class Svc {
      void run() {
        HttpRequest r1 = new HttpRequest(); r1.setEndpoint('callout:NC_One/x');
        HttpRequest r2 = new HttpRequest(); r2.setEndpoint('callout:NC_Two/y');
      }
    }`;
    const ncs = (await parse(body)).edges
      .filter((e) => e.relType === "CALLS_NAMED_CREDENTIAL")
      .map((e) => String(e.dstQualifiedName));
    expect(ncs).toContain("NamedCredential:NC_One");
    expect(ncs).toContain("NamedCredential:NC_Two");
  });
});

describe("computeLoopRanges — braceless loops don't bleed", () => {
  it("a braceless do-while does not mark a later unrelated block as a loop", () => {
    // `do x(); while(y);` then a plain `{ }` block. The block must NOT be a loop range.
    const body = "do x(); while (y);\n{ z(); }";
    const blockOpen = body.indexOf("{");
    const ranges = computeLoopRanges(body);
    const blockMarkedLoop = ranges.some((r) => r.start <= blockOpen && blockOpen <= r.end);
    expect(blockMarkedLoop).toBe(false);
  });

  it("a braced for-loop body is still detected as a loop range", () => {
    const body = "for (Integer i = 0; i < n; i++) { q(); }";
    const open = body.indexOf("{");
    const ranges = computeLoopRanges(body);
    expect(ranges.some((r) => r.start <= open && open < r.end)).toBe(true);
  });
});
