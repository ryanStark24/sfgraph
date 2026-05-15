import type { NodeFact } from "@ryanstark24/sfgraph-core";
import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
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

  it("surfaces truncated=false on small fixtures (P2)", async () => {
    fix.addNode({ qualifiedName: "ApexClass:X", label: "ApexClass" });
    const r = await callTool("freshness_report", { org: fix.orgId });
    expect((r.data as { truncated: boolean }).truncated).toBe(false);
  });

  it("respects bucket filter", async () => {
    fix.addNode({ qualifiedName: "ApexClass:X", label: "ApexClass" });
    const r = await callTool("freshness_report", { org: fix.orgId, bucket: "hot" });
    expect(r.markdown).toContain("hot");
    expect(r.markdown).not.toContain("### dead");
  });

  it("returns all-empty buckets for empty graph", async () => {
    const r = await callTool("freshness_report", { org: fix.orgId });
    const d = r.data as { buckets: Record<string, unknown[]> };
    expect(d.buckets.hot?.length ?? 0).toBe(0);
    expect(d.buckets.current?.length ?? 0).toBe(0);
    expect(d.buckets.stale?.length ?? 0).toBe(0);
    expect(d.buckets.dead?.length ?? 0).toBe(0);
  });

  it("rejects invalid bucket value", async () => {
    await expect(
      callTool("freshness_report", { org: fix.orgId, bucket: "lukewarm" }),
    ).rejects.toThrow();
  });

  it("rejects empty org", async () => {
    await expect(callTool("freshness_report", { org: "" })).rejects.toThrow();
  });

  it("accepts each valid bucket without throwing", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Y", label: "ApexClass" });
    for (const b of ["stale", "hot", "dead", "current"] as const) {
      const r = await callTool("freshness_report", { org: fix.orgId, bucket: b });
      expect(r.summary).toContain(b);
    }
  });

  it("flags truncated=true when a label exceeds the 5000-node cap", async () => {
    const facts: NodeFact[] = [];
    for (let i = 0; i < 5001; i++) {
      facts.push({
        orgId: fix.orgId,
        qualifiedName: asQualifiedName(`ApexClass:Bulk${i}`),
        label: "ApexClass",
        attributes: {},
        sourceHash: asSha256(`h-${i}`),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: Date.now(),
      });
    }
    fix.ctx.graphStore.mergeNodes(facts);
    const r = await callTool("freshness_report", { org: fix.orgId });
    expect((r.data as { truncated: boolean }).truncated).toBe(true);
    expect(r.markdown).toContain("incomplete");
  });

  it("each bucket is sorted+capped at 20 rows", async () => {
    const facts: NodeFact[] = [];
    for (let i = 0; i < 100; i++) {
      facts.push({
        orgId: fix.orgId,
        qualifiedName: asQualifiedName(`ApexClass:H${i}`),
        label: "ApexClass",
        attributes: {},
        sourceHash: asSha256(`h-${i}`),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: Date.now(),
      });
    }
    fix.ctx.graphStore.mergeNodes(facts);
    const r = await callTool("freshness_report", { org: fix.orgId });
    const d = r.data as { buckets: Record<string, unknown[]> };
    for (const k of Object.keys(d.buckets)) {
      expect((d.buckets[k] ?? []).length).toBeLessThanOrEqual(20);
    }
  });
});
