import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool, defaultRegistry } from "./_runner.js";

/**
 * Audit review I3: what the tools say must match current behaviour, because agents choose tools
 * and read results based on it. Cycle 3 T5: caveats about results are in the result text; the
 * not-found behaviour stays in the trace descriptions.
 */
const desc = (name: string) => defaultRegistry.get(name)?.schema.description ?? "";

let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

describe("audit review I3: tools say what they do", () => {
  it("governor_risk_check says it scans live and the cache only adds rows when fresh", async () => {
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    expect(r.markdown).toMatch(/Scans the graph live; a cache adds rows only when it is fresh\./);
  });

  it("export_sarif says test code is excluded by default and names includeTests", async () => {
    const r = await callTool("export_sarif", { org: fix.orgId, audits: ["governor"] });
    expect(r.markdown).toMatch(/test code is excluded by default/i);
    expect(r.markdown).toMatch(/includeTests/);
    const on = await callTool("export_sarif", {
      org: fix.orgId,
      audits: ["governor"],
      includeTests: true,
    });
    expect(on.markdown).not.toMatch(/test code is excluded by default/i);
    expect(desc("export_sarif")).not.toMatch(/^Export every/);
  });

  it("trace tools say an unknown qname returns node not found", () => {
    expect(desc("trace_upstream")).toMatch(/not found/i);
    expect(desc("trace_downstream")).toMatch(/not found/i);
  });
});
