import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "ApexClass:Foo", label: "ApexClass" });
});

afterEach(async () => {
  await fix.cleanup();
});

describe("snapshot_create", () => {
  it("creates a snapshot", async () => {
    const r = await callTool("snapshot_create", { org: fix.orgId });
    expect(r.summary).toMatch(/snap_/);
    expect((r.data as { id: string }).id).toMatch(/^snap_/);
  });

  it("uses provided name", async () => {
    const r = await callTool("snapshot_create", { org: fix.orgId, name: "checkpoint-A" });
    expect((r.data as { label: string }).label).toBe("checkpoint-A");
  });

  it("rejects empty org", async () => {
    await expect(callTool("snapshot_create", { org: "" })).rejects.toThrow();
  });

  it("generates unique ids for back-to-back creates", async () => {
    const a = await callTool("snapshot_create", { org: fix.orgId });
    const b = await callTool("snapshot_create", { org: fix.orgId });
    expect((a.data as { id: string }).id).not.toBe((b.data as { id: string }).id);
  });
});

describe("snapshot_list", () => {
  it("returns empty for fresh org", async () => {
    const r = await callTool("snapshot_list", { org: fix.orgId });
    expect((r.data as unknown[]).length).toBe(0);
  });

  it("lists most recent snapshots", async () => {
    await callTool("snapshot_create", { org: fix.orgId, name: "s1" });
    await callTool("snapshot_create", { org: fix.orgId, name: "s2" });
    const r = await callTool("snapshot_list", { org: fix.orgId });
    const arr = r.data as Array<{ label: string }>;
    expect(arr.length).toBe(2);
  });

  it("rejects empty org", async () => {
    await expect(callTool("snapshot_list", { org: "" })).rejects.toThrow();
  });

  it("handles many snapshots without throwing", async () => {
    for (let i = 0; i < 20; i++) {
      await callTool("snapshot_create", { org: fix.orgId, name: `n${i}` });
    }
    const r = await callTool("snapshot_list", { org: fix.orgId });
    expect((r.data as unknown[]).length).toBeGreaterThanOrEqual(20);
  });
});
