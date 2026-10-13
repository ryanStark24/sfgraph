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

  it("supports snapshot-to-snapshot diff via `to` param", async () => {
    fix.addNode({ qualifiedName: "ApexClass:A", label: "ApexClass" });
    const s1 = await callTool("snapshot_create", { org: fix.orgId, name: "s1" });
    fix.addNode({ qualifiedName: "ApexClass:B", label: "ApexClass" });
    const s2 = await callTool("snapshot_create", { org: fix.orgId, name: "s2" });
    const r = await callTool("point_in_time_diff", {
      org: fix.orgId,
      from: (s1.data as { id: string }).id,
      to: (s2.data as { id: string }).id,
    });
    const d = r.data as { nodeDiff: { added: unknown[] } };
    expect(d.nodeDiff.added.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects empty `from`", async () => {
    await expect(callTool("point_in_time_diff", { org: fix.orgId, from: "" })).rejects.toThrow();
  });

  it("rejects missing `from`", async () => {
    await expect(callTool("point_in_time_diff", { org: fix.orgId })).rejects.toThrow();
  });

  it("summary embeds add/change/remove counts", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Z", label: "ApexClass" });
    const s = await callTool("snapshot_create", { org: fix.orgId });
    const sid = (s.data as { id: string }).id;
    fix.addNode({ qualifiedName: "ApexClass:Added", label: "ApexClass" });
    const r = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    expect(r.summary).toMatch(/\+1/);
  });
});

// T14 batch L pin: edge rows and counts must equal the full in-store edge diff
// (diffEdges) cut to `limit`, in the same order, for snapshot->current,
// current->snapshot and snapshot->snapshot.
describe("point_in_time_diff edge output pin", () => {
  it("edgeDiff / counts / truncated equal the full diff sliced to limit", async () => {
    const s0 = await callTool("snapshot_create", { org: fix.orgId, name: "s0" });
    const srcs = ["ApexClass:B", "ApexClass:a", "ApexClass:é", "Flow:\u{1f600}", "Flow:z"];
    const rels = ["CALLS", "REFERENCES", "READS_FIELD", "WRITES_FIELD"];
    for (const [i, src] of srcs.entries()) {
      fix.addNode({ qualifiedName: src, label: src.split(":")[0] as string });
      for (const [j, rt] of rels.entries()) {
        if ((i + j) % 3 === 0) continue;
        fix.addEdge({ srcQualifiedName: src, dstQualifiedName: `F:${(i + j) % 4}`, relType: rt });
        fix.addEdge({ srcQualifiedName: src, dstQualifiedName: `f:${j}`, relType: rt });
      }
    }
    const s1 = await callTool("snapshot_create", { org: fix.orgId, name: "s1" });
    const g = fix.ctx.graphStore;
    g.deleteEdgesFor(fix.orgId, "Flow:z" as never);
    g.deleteEdge(fix.orgId, "ApexClass:a" as never, "f:0" as never, "CALLS" as never);
    fix.addEdge({ srcQualifiedName: "ApexClass:New", dstQualifiedName: "F:1", relType: "CALLS" });
    fix.addEdge({ srcQualifiedName: "ApexClass:B", dstQualifiedName: "F:9", relType: "CALLS" });
    const ids = [(s0.data as { id: string }).id, (s1.data as { id: string }).id, "current"];
    let checked = 0;
    for (const from of ids) {
      for (const to of ids) {
        if (from === to) continue;
        const full = fix.ctx.snapshotStore.diffEdges(fix.orgId, from, to);
        for (const limit of [1, 2, 7, 100]) {
          const r = await callTool("point_in_time_diff", { org: fix.orgId, from, to, limit });
          const d = r.data as {
            edgeDiff: { added: unknown[]; removed: unknown[] };
            counts: { edges: { added: number; removed: number } };
            truncated: boolean;
          };
          expect(JSON.stringify(d.edgeDiff)).toBe(
            JSON.stringify({
              added: full.added.slice(0, limit),
              removed: full.removed.slice(0, limit),
            }),
          );
          expect(d.counts.edges).toEqual({
            added: full.added.length,
            removed: full.removed.length,
          });
          const nd = fix.ctx.snapshotStore.diffNodes(fix.orgId, from, to);
          expect(d.truncated).toBe(
            [
              nd.added.length,
              nd.removed.length,
              nd.changed.length,
              full.added.length,
              full.removed.length,
            ].some((c) => c > limit),
          );
          expect(r.markdown).toContain(
            `**Edges** — +${full.added.length} / -${full.removed.length}`,
          );
          checked++;
        }
      }
    }
    expect(checked).toBe(24);
  });
});

describe("point_in_time_diff cache", () => {
  it("serves a repeated diff from the cache and drops it when the graph changes", async () => {
    const { diffLoadCount, clearDiffCache } = await import("../_snapshot-util.js");
    clearDiffCache();
    const s = await callTool("snapshot_create", { org: fix.orgId });
    const sid = (s.data as { id: string }).id;
    const base = diffLoadCount();
    const first = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    expect(diffLoadCount()).toBe(base + 1);
    const second = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    expect(diffLoadCount()).toBe(base + 1);
    expect(second.markdown).toBe(first.markdown);
    expect(second.data).toEqual(first.data);
    // A new write is never served stale.
    fix.addNode({ qualifiedName: "ApexClass:LateArrival", label: "ApexClass" });
    const third = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    expect(diffLoadCount()).toBe(base + 2);
    expect((third.data as { nodeDiff: { added: unknown[] } }).nodeDiff.added.length).toBe(1);
  });

  it("keeps at most two diffs", async () => {
    const { diffLoadCount, clearDiffCache } = await import("../_snapshot-util.js");
    clearDiffCache();
    const ids: string[] = [];
    for (const name of ["a", "b", "c"]) {
      ids.push(
        ((await callTool("snapshot_create", { org: fix.orgId, name })).data as { id: string }).id,
      );
    }
    const ask = (from: string) => callTool("point_in_time_diff", { org: fix.orgId, from });
    const base = diffLoadCount();
    await ask(ids[0] as string);
    await ask(ids[1] as string);
    await ask(ids[2] as string); // evicts the first
    expect(diffLoadCount()).toBe(base + 3);
    await ask(ids[2] as string);
    await ask(ids[1] as string);
    expect(diffLoadCount()).toBe(base + 3);
    await ask(ids[0] as string);
    expect(diffLoadCount()).toBe(base + 4);
  });
});
