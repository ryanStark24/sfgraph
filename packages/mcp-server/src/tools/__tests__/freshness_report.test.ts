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

describe("freshness_report", () => {
  it("buckets a hot and a dead node", async () => {
    const now = Date.now();
    fix.addNode({
      qualifiedName: "ApexClass:Recent",
      label: "ApexClass",
      lastModifiedAt: now,
    });
    fix.addNode({
      qualifiedName: "ApexClass:Ancient",
      label: "ApexClass",
      lastModifiedAt: now - 1000 * 60 * 60 * 24 * 1000,
    });
    const r = await callTool("freshness_report", { org: fix.orgId });
    const d = r.data as { buckets: Record<string, unknown[]> };
    expect((d.buckets.hot?.length ?? 0) + (d.buckets.current?.length ?? 0)).toBeGreaterThanOrEqual(
      1,
    );
    expect(d.buckets.dead?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("respects bucket filter", async () => {
    fix.addNode({ qualifiedName: "ApexClass:X", label: "ApexClass" });
    const r = await callTool("freshness_report", { org: fix.orgId, bucket: "hot" });
    expect(r.markdown).toContain("hot");
    expect(r.markdown).not.toContain("### dead");
  });
});
