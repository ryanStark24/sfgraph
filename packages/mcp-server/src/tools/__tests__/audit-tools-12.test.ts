import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Audit tools-12: cross_layer_flow_map accepts an unknown entry or a
 * label-less entry and answers "1 participants across layers" instead of an
 * error / not-found.
 */
let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "LWC:realCmp", label: "LWC" });
});

afterEach(async () => {
  await fix.cleanup();
});

async function outcome(entry: string): Promise<{ threw: boolean; summary: string }> {
  try {
    const r = await callTool("cross_layer_flow_map", { org: fix.orgId, entry });
    return { threw: false, summary: r.summary };
  } catch {
    return { threw: true, summary: "" };
  }
}

describe("audit tools-12: cross_layer_flow_map entry validation", () => {
  it("rejects an unknown entry instead of a one-box diagram", async () => {
    const o = await outcome("LWC:nope");
    expect(o.threw || !/^1 participants/.test(o.summary)).toBe(true);
  });

  it("rejects a label-less entry (name only)", async () => {
    const o = await outcome("realCmp");
    expect(o.threw || !/^1 participants/.test(o.summary)).toBe(true);
  });

  it("suggests the full qname for a label-less entry and resolves case", async () => {
    const bare = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "realCmp" });
    expect(bare.summary).toBe("entry not found");
    expect(bare.markdown).toContain("LWC:realCmp");
    const ci = await callTool("cross_layer_flow_map", { org: fix.orgId, entry: "lwc:REALCMP" });
    // Batch Q1: the entry is drawn (role "entry") but not counted.
    expect(ci.summary).toMatch(/^0 participants/);
    const d = ci.data as { participants: Array<{ id: string; role?: string }> };
    expect(d.participants[0]?.id).toBe("LWC:realCmp");
    expect(d.participants[0]?.role).toBe("entry");
  });
});
