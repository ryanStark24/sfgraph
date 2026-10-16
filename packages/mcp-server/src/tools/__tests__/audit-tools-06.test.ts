import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit tools-06: point_in_time_diff returns the full nodeDiff/edgeDiff
 * uncapped (534 MB against an empty baseline on a real org). Correct
 * behaviour: the payload is bounded (counts + first N, truncated flag).
 */
let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("audit tools-06: point_in_time_diff payload bound", () => {
  it("does not return every added node/edge against an empty baseline", async () => {
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true);
    const N = 3000;
    const nodes = Array.from({ length: N }, (_, i) => `ApexClass:C${i}`);
    fix.addNodes(nodes.map((q) => ({ qualifiedName: q, label: "ApexClass" })));
    fix.addEdges(
      nodes.slice(1).map((q, i) => ({
        srcQualifiedName: q,
        dstQualifiedName: nodes[i] as string,
        relType: "CALLS",
      })),
    );
    const r = await callTool("point_in_time_diff", { org: fix.orgId, from: snap.id });
    // The summary still reports the true total.
    expect(r.summary).toContain(`+${N}`);
    // But the structured payload and markdown must stay bounded.
    expect(JSON.stringify(r.data).length).toBeLessThan(250_000);
    expect(r.markdown.length).toBeLessThan(250_000);
  });
});
