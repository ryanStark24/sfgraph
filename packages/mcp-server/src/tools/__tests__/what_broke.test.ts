import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordsNote } from "../what_broke.js";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("what_broke", () => {
  it("returns no-baseline message when no snapshot exists", async () => {
    const r = await callTool("what_broke", { org: fix.orgId });
    expect(r.summary).toBe("no baseline snapshot");
  });

  it("reports zero changes when nothing changed", async () => {
    fix.addNode({ qualifiedName: "ApexClass:A", label: "ApexClass", sourceHash: "h1" });
    // Create an "auto" snapshot via direct API
    const auto = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync-x", true);
    const r = await callTool("what_broke", { org: fix.orgId, since: auto.id });
    expect(r.summary).toBe("no changes");
  });

  it("buckets covered vs at-risk dependents", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Target", label: "ApexClass", sourceHash: "v1" });
    fix.addNode({ qualifiedName: "ApexClass:Caller", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexClass:CallerTest", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:Caller",
      dstQualifiedName: "ApexClass:Target",
      relType: REL_TYPES.CALLS,
    });
    fix.addEdge({
      srcQualifiedName: "ApexClass:CallerTest",
      dstQualifiedName: "ApexClass:Caller",
      relType: REL_TYPES.IS_TEST_FOR,
    });
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true);
    // Change Target
    fix.addNode({ qualifiedName: "ApexClass:Target", label: "ApexClass", sourceHash: "v2" });
    const r = await callTool("what_broke", { org: fix.orgId, since: snap.id });
    const d = r.data as { atRisk: string[]; covered: string[] };
    expect(d.covered).toContain("ApexClass:Caller");
    expect(d.atRisk.length).toBe(0);
  });

  it("at-risk when no test edge", async () => {
    fix.addNode({ qualifiedName: "ApexClass:T2", label: "ApexClass", sourceHash: "v1" });
    fix.addNode({ qualifiedName: "ApexClass:C2", label: "ApexClass" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:C2",
      dstQualifiedName: "ApexClass:T2",
      relType: REL_TYPES.CALLS,
    });
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true);
    fix.addNode({ qualifiedName: "ApexClass:T2", label: "ApexClass", sourceHash: "v2" });
    const r = await callTool("what_broke", { org: fix.orgId, since: snap.id });
    const d = r.data as { atRisk: string[] };
    expect(d.atRisk).toContain("ApexClass:C2");
  });
});

// Cycle 3 T9 fix round 1: the In short tells records apart from components, and no empty list
// heading is printed.
describe("what_broke wording", () => {
  it("counts changed records and records that rely on a change apart", () => {
    expect(recordsNote(0, 1)).toBe(
      "1 record or setting (not a component) relies on a change and was not traced further",
    );
    expect(recordsNote(2, 0)).toBe(
      "2 records or settings (not components) changed and were not traced further",
    );
    expect(recordsNote(1, 3)).toBe(
      "1 record or setting (not a component) changed and 3 rely on a change; they were not traced further",
    );
    expect(recordsNote(0, 0)).toBeUndefined();
  });

  it("says no other components rely on a change when only a record does, and prints no empty heading", async () => {
    fix.addNode({ qualifiedName: "OmniScript:Os_English", label: "OmniScript", sourceHash: "v1" });
    fix.addNode({ qualifiedName: "VlocityAction:Check", label: "VlocityAction" });
    fix.addEdge({
      srcQualifiedName: "VlocityAction:Check",
      dstQualifiedName: "OmniScript:Os_English",
      relType: REL_TYPES.REFERENCES,
    });
    const snap = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true);
    fix.addNode({ qualifiedName: "OmniScript:Os_English", label: "OmniScript", sourceHash: "v2" });
    const r = await callTool("what_broke", { org: fix.orgId, since: snap.id });
    const md = r.markdown as string;
    expect(md).toContain("No other components rely on the changes within 1 step.");
    expect(md).toContain(
      "1 record or setting (not a component) relies on a change and was not traced further.",
    );
    expect(md).not.toContain("**At risk (no tests)**");
  });
});
