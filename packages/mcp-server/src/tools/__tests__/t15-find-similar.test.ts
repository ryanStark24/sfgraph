import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// T15 query I-7: the label filter applies before the keyword leg's LIMIT, and
// qname mode demotes test code unless the focal is itself a test. Keyword
// leg only (the fixture has no vector store).
let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

type Hit = { qname: string; label: string; demoted?: boolean };
function doc(q: string, body: string, attributes?: Record<string, unknown>): void {
  const l = q.slice(0, q.indexOf(":"));
  fix.addNode({ qualifiedName: q, label: l, ...(attributes ? { attributes } : {}) });
  fix.ctx.graphStore.upsertNodeFts(fix.orgId, asQualifiedName(q), l, body);
}
async function hits(input: Record<string, unknown>): Promise<Hit[]> {
  const r = await callTool("find_similar", { org: fix.orgId, ...input });
  return (r.data as { hits: Hit[] }).hits;
}

describe("T15 I-7 find_similar", () => {
  it("a label whose rows rank below the keyword pool is still found", async () => {
    // 80 term-dense fields outrank the one class on the keyword leg.
    for (let i = 0; i < 80; i++) doc(`CustomField:Order.Refund${i}__c`, "refund refund refund");
    doc("ApexClass:RefundRouter", "refund router that dispatches many kinds of customer requests");
    const h = await hits({ text: "refund", label: "ApexClass", k: 5 });
    expect(h.map((x) => x.qname)).toEqual(["ApexClass:RefundRouter"]);
  });

  it("qname mode ranks test code after production code", async () => {
    doc("ApexClass:Billing", "billing");
    doc("ApexClass:BillingTest", "billing billing billing", { isTest: true });
    doc("ApexClass:BillingHelper", "billing helper that formats invoices for customers");
    const h = await hits({ qname: "ApexClass:Billing" });
    expect(h.map((x) => [x.qname, x.demoted === true])).toEqual([
      ["ApexClass:BillingHelper", false],
      ["ApexClass:BillingTest", true],
    ]);
  });

  it("qname mode keeps tests in rank order when the focal is a test", async () => {
    doc("ApexClass:BillingTest", "billing test", { isTest: true });
    doc("ApexClass:BillingOtherTest", "billing billing billing", { isTest: true });
    doc("ApexClass:BillingHelper", "billing helper that formats invoices for customers");
    const h = await hits({ qname: "ApexClass:BillingTest" });
    expect(h.some((x) => x.demoted)).toBe(false);
    expect(h[0]?.qname).toBe("ApexClass:BillingOtherTest");
  });
});
