import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool, defaultRegistry } from "./_runner.js";

/**
 * Audit sec-02 (mcp-server half): find_nodes' zod schema accepted any glob,
 * so `ApexClass:` + `*?`x8 + `!` reached picomatch and backtracked for tens of
 * seconds. The schema now bounds pattern length and the number of `*` runs.
 */
let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: `ApexClass:${"a".repeat(35)}`, label: "ApexClass" });
  fix.addNode({ qualifiedName: "CustomField:Account.Work_Email__c", label: "CustomField" });
});
afterEach(async () => {
  await fix.cleanup();
});

describe("audit sec-02: find_nodes pattern limits", () => {
  it("rejects a pattern with too many wildcard runs, quickly", async () => {
    const t0 = Date.now();
    await expect(
      callTool("find_nodes", {
        org: fix.orgId,
        label: "ApexClass",
        pattern: `ApexClass:${"*?".repeat(8)}!`,
      }),
    ).rejects.toThrow(/wildcard/);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("rejects an over-long pattern", async () => {
    await expect(
      callTool("find_nodes", { org: fix.orgId, pattern: `ApexClass:${"a".repeat(300)}` }),
    ).rejects.toThrow();
  });

  it("still accepts realistic globs (up to 4 '*' runs, '**' counts once)", async () => {
    const r = await callTool("find_nodes", { org: fix.orgId, pattern: "CustomField:**.*Email*" });
    expect((r.data as { total: number }).total).toBe(1);
  });

  it("documents core's matcher, not picomatch (audit review M8)", async () => {
    const tool = defaultRegistry.get("find_nodes");
    const text = `${tool?.schema.description}\n${JSON.stringify(tool?.schema.inputSchema)}`;
    expect(text).not.toMatch(/picomatch/i);
    expect(tool?.schema.description).toMatch(/case-insensitive/i);
    expect(tool?.schema.description).toMatch(/\{a,b\}/);
    expect(tool?.schema.description).toMatch(/256/);
    const r = await callTool("find_nodes", { org: fix.orgId, pattern: "customfield:*email*" });
    expect((r.data as { total: number }).total).toBe(1);
  });
});
