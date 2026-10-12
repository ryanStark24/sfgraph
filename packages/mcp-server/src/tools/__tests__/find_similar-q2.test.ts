import { REL_TYPES } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// Batch Q2 (task 14, B8): find_similar result shaping. Keyword leg only (no
// vector store on the fixture context), so no embedder is needed.
let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

type Hit = { qname: string; label: string; via: string; demoted?: boolean };

function doc(q: string, body: string, attributes?: Record<string, unknown>, label?: string): void {
  const l = label ?? q.slice(0, q.indexOf(":"));
  fix.addNode({ qualifiedName: q, label: l, ...(attributes ? { attributes } : {}) });
  fix.ctx.graphStore.upsertNodeFts(fix.orgId, asQualifiedName(q), l, body);
}
function e(src: string, dst: string, rel: string): void {
  fix.addEdge({ srcQualifiedName: src, dstQualifiedName: dst, relType: rel });
}
async function hits(input: Record<string, unknown>): Promise<Hit[]> {
  const r = await callTool("find_similar", { org: fix.orgId, ...input });
  return (r.data as { hits: Hit[] }).hits;
}

describe("find_similar: collapse members into their component", () => {
  beforeEach(() => {
    doc("ApexClass:Svc", "refund svc");
    doc("ApexMethod:Svc.run(0)", "refund run");
    doc("ApexMethod:Svc.undo(0)", "refund undo");
    doc("Flow:F", "refund flow");
    doc("FlowVersion:F.v1", "refund flow version");
    e("ApexClass:Svc", "ApexMethod:Svc.run(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexClass:Svc", "ApexMethod:Svc.undo(0)", REL_TYPES.CONTAINS_METHOD);
    e("Flow:F", "FlowVersion:F.v1", REL_TYPES.CONTAINS);
  });

  it("lists one row per component", async () => {
    const h = await hits({ text: "refund" });
    expect(h.map((x) => x.qname).sort()).toEqual(["ApexClass:Svc", "Flow:F"]);
    expect(h.find((x) => x.qname === "ApexClass:Svc")?.label).toBe("ApexClass");
  });

  it("an explicit label keeps member rows", async () => {
    const h = await hits({ text: "refund", label: "ApexMethod" });
    expect(h.map((x) => x.qname).sort()).toEqual([
      "ApexMethod:Svc.run(0)",
      "ApexMethod:Svc.undo(0)",
    ]);
  });

  it("is deterministic", async () => {
    const a = await hits({ text: "refund" });
    const b = await hits({ text: "refund" });
    expect(b).toEqual(a);
  });
});

describe("find_similar: down-rank test code and record-level labels for text", () => {
  beforeEach(() => {
    // Short, term-dense bodies rank first on the keyword leg.
    doc("ApexClass:RefundTest", "refund refund refund", { isTest: true });
    doc("ApexClass:RefundHelperTest", "refund refund");
    e("ApexClass:RefundHelperTest", "ApexClass:RefundService", REL_TYPES.IS_TEST_FOR);
    doc("CustomMetadataRecord:Cfg.Refund", "refund refund refund");
    doc("CustomField:Order.Refund__c", "refund refund refund");
    doc("ApexClass:RefundService", "refund service that processes customer orders today");
  });

  it("production code comes first and fills k", async () => {
    const h = await hits({ text: "refund", k: 1 });
    expect(h.map((x) => x.qname)).toEqual(["ApexClass:RefundService"]);
    const all = await hits({ text: "refund", k: 10 });
    expect(all[0]?.qname).toBe("ApexClass:RefundService");
    expect(all.slice(1).every((x) => x.demoted === true)).toBe(true);
    expect(all).toHaveLength(5);
  });

  it("no down-rank when a label is given", async () => {
    const h = await hits({ text: "refund", label: "ApexClass" });
    expect(h.some((x) => x.demoted)).toBe(false);
  });
});

describe("find_similar: qname mode (fix round 1, I1)", () => {
  beforeEach(() => {
    doc("ApexClass:Bill", "bill run");
    doc("ApexMethod:Bill.run(0)", "bill run");
    doc("ApexMethod:Bill.rerun(0)", "bill run again");
    doc("ApexClass:Other", "other");
    doc("ApexMethod:Other.run(0)", "bill run other");
    e("ApexClass:Bill", "ApexMethod:Bill.run(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexClass:Bill", "ApexMethod:Bill.rerun(0)", REL_TYPES.CONTAINS_METHOD);
    e("ApexClass:Other", "ApexMethod:Other.run(0)", REL_TYPES.CONTAINS_METHOD);
  });

  it("a member focal keeps member rows and never returns its own component", async () => {
    const h = await hits({ qname: "ApexMethod:Bill.run(0)" });
    const q = h.map((x) => x.qname);
    expect(q).not.toContain("ApexClass:Bill");
    expect(q).not.toContain("ApexMethod:Bill.run(0)");
    expect(q).toContain("ApexMethod:Bill.rerun(0)");
    expect(q).toContain("ApexMethod:Other.run(0)");
  });

  it("a component focal collapses others and drops its own members", async () => {
    const h = await hits({ qname: "ApexClass:Bill" });
    expect(h.map((x) => x.qname)).toEqual(["ApexClass:Other"]);
  });
});
