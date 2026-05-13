import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("governor_risk_check", () => {
  it("empty when no attributes hint", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Clean", label: "ApexClass" });
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    expect((r.data as { risks: unknown[] }).risks.length).toBe(0);
  });

  it("flags soql_in_loop attribute", async () => {
    fix.addNode({
      qualifiedName: "ApexClass:Risky",
      label: "ApexClass",
      attributes: { hasSoqlInLoop: true },
    });
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const risks = (r.data as { risks: Array<{ qualifiedName: string }> }).risks;
    expect(risks.some((x) => x.qualifiedName === "ApexClass:Risky")).toBe(true);
  });
});
