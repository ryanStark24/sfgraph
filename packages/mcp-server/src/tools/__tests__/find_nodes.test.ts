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

describe("find_nodes", () => {
  it("caps output by default and says how to narrow", async () => {
    for (let i = 0; i < 250; i++) {
      fix.addNode({ qualifiedName: `ApexClass:Gen${i}`, label: "ApexClass" });
    }
    const r = await callTool("find_nodes", { org: fix.orgId, pattern: "ApexClass:*" });
    const md = r.markdown as string;
    expect(md.split("\n").filter((l) => l.startsWith("- `")).length).toBe(200);
    expect(md).toContain("50 more");
    expect(md).toMatch(/narrow with/);
    expect((r.data as { total: number }).total).toBe(250);
  });

  it("explicit limit is honoured; no hint when nothing is omitted", async () => {
    for (let i = 0; i < 8; i++) {
      fix.addNode({ qualifiedName: `ApexClass:Lim${i}`, label: "ApexClass" });
    }
    const r = await callTool("find_nodes", { org: fix.orgId, pattern: "ApexClass:*", limit: 5 });
    const md = r.markdown as string;
    expect(md.split("\n").filter((l) => l.startsWith("- `")).length).toBe(5);
    expect(md).toContain("3 more");
    const all = await callTool("find_nodes", { org: fix.orgId, pattern: "ApexClass:*", limit: 50 });
    expect(all.markdown).not.toMatch(/more, narrow/);
  });
});
