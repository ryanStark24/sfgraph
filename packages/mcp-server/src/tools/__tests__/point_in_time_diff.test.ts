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

describe("point_in_time_diff", () => {
  it("zero diff against current after snapshot", async () => {
    fix.addNode({ qualifiedName: "ApexClass:A", label: "ApexClass" });
    const s = await callTool("snapshot_create", { org: fix.orgId });
    const sid = (s.data as { id: string }).id;
    const r = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    const d = r.data as { nodeDiff: { added: unknown[]; removed: unknown[]; changed: unknown[] } };
    expect(d.nodeDiff.added.length).toBe(0);
    expect(d.nodeDiff.removed.length).toBe(0);
  });

  it("detects added node", async () => {
    const s = await callTool("snapshot_create", { org: fix.orgId });
    const sid = (s.data as { id: string }).id;
    fix.addNode({ qualifiedName: "ApexClass:NewOne", label: "ApexClass" });
    const r = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    const d = r.data as { nodeDiff: { added: unknown[] } };
    expect(d.nodeDiff.added.length).toBe(1);
  });

  it("markdown contains mermaid fence", async () => {
    const s = await callTool("snapshot_create", { org: fix.orgId });
    const sid = (s.data as { id: string }).id;
    const r = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    expect(r.markdown).toMatch(/```mermaid/);
    expect(r.markdown).toMatch(/flowchart/);
  });
});
