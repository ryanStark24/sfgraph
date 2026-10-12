import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// T15 query I-5: `limit` is applied after the documented severity/priority
// sort, and the total and the truncation are reported.

let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
  const loop = (m: string, rel: string, dst: string) => {
    fix.addNode({ qualifiedName: m, label: "ApexMethod" });
    fix.addEdge({
      srcQualifiedName: m,
      dstQualifiedName: dst,
      relType: rel,
      attributes: { inLoop: true },
    });
  };
  loop("ApexMethod:A.run(0)", "EXECUTES_DML", "DML:update");
  loop("ApexMethod:M.run(0)", "EXECUTES_SOSL", "SOSL:*");
  loop("ApexMethod:Z.run(0)", "EXECUTES_SOQL", "CustomObject:Account");
});
afterEach(async () => {
  await fix.cleanup();
});

type Data = {
  risks: Array<{ qualifiedName: string; risk: string }>;
  total: number;
  truncated: boolean;
  order: string;
};

describe("T15 I-5 governor_risk_check", () => {
  it("limit keeps the highest-priority risks, not the first qnames", async () => {
    const r = await callTool("governor_risk_check", { org: fix.orgId, limit: 2 });
    const d = r.data as Data;
    expect(d.risks.map((x) => [x.qualifiedName, x.risk])).toEqual([
      ["ApexMethod:Z.run(0)", "soql_in_loop"],
      ["ApexMethod:M.run(0)", "sosl_in_loop"],
    ]);
    expect(d.total).toBe(3);
    expect(d.truncated).toBe(true);
    expect(d.order).toMatch(/severity/);
    expect(r.summary).toMatch(/3 governor risks \(showing 2\)/);
  });

  it("dynamic SOQL in a loop (a node attribute) is reported", async () => {
    fix.addNode({
      qualifiedName: "ApexMethod:D.run(0)",
      label: "ApexMethod",
      attributes: { dynamicQueryInLoop: ["Database.query"] },
    });
    const d = (await callTool("governor_risk_check", { org: fix.orgId })).data as Data;
    expect(d.risks).toContainEqual(
      expect.objectContaining({
        qualifiedName: "ApexMethod:D.run(0)",
        risk: "dynamic_soql_in_loop",
      }),
    );
  });
});
