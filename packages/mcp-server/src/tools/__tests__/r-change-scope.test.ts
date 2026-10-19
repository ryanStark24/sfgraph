import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// Batch R / S1: the change tools scope their answer to components, roll
// members up to their owner, and keep record/config rows in a separate bucket.

let fix: Fixture;
beforeEach(async () => {
  fix = await createFixture();
});
afterEach(async () => {
  await fix.cleanup();
});

type Buckets = { added: string[]; removed: string[]; changed: string[] };

/** Baseline: a class with a method, a flow with a version, a bundle+LWC, a
 *  CMDT record and an opaque DataPack record; returns the snapshot id. */
function baseline(): string {
  fix.addNode({ qualifiedName: "ApexClass:Svc", label: "ApexClass", sourceHash: "c1" });
  fix.addNode({ qualifiedName: "ApexMethod:Svc.run(0)", label: "ApexMethod", sourceHash: "m1" });
  fix.addNode({ qualifiedName: "ApexMethod:Svc.old(1)", label: "ApexMethod", sourceHash: "o1" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Svc",
    dstQualifiedName: "ApexMethod:Svc.run(0)",
    relType: REL_TYPES.CONTAINS_METHOD,
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Svc",
    dstQualifiedName: "ApexMethod:Svc.old(1)",
    relType: REL_TYPES.CONTAINS_METHOD,
  });
  fix.addNode({ qualifiedName: "Flow:F", label: "Flow", sourceHash: "f1" });
  fix.addNode({ qualifiedName: "FlowVersion:F.v1", label: "FlowVersion", sourceHash: "fv1" });
  fix.addEdge({
    srcQualifiedName: "Flow:F",
    dstQualifiedName: "FlowVersion:F.v1",
    relType: REL_TYPES.CONTAINS,
  });
  fix.addNode({ qualifiedName: "CustomMetadataRecord:Cfg.r1", label: "CustomMetadataRecord" });
  fix.addNode({ qualifiedName: "EntityFilter:EF1", label: "EntityFilter", sourceHash: "e1" });
  fix.addNode({ qualifiedName: "ApexClass:Caller", label: "ApexClass" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Caller",
    dstQualifiedName: "ApexMethod:Svc.run(0)",
    relType: REL_TYPES.CALLS,
  });
  fix.addNode({ qualifiedName: "VlocityAction:Act", label: "VlocityAction" });
  fix.addNode({ qualifiedName: "OmniScript:A_B_English", label: "OmniScript", sourceHash: "os1" });
  fix.addEdge({
    srcQualifiedName: "VlocityAction:Act",
    dstQualifiedName: "OmniScript:A_B_English",
    relType: REL_TYPES.REFERENCES,
  });
  return fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true).id;
}

/** Changes: a method body, a FlowVersion only, a removed method, the
 *  OmniScript, the CMDT record and the DataPack record. */
function change(): void {
  fix.addNode({ qualifiedName: "ApexMethod:Svc.run(0)", label: "ApexMethod", sourceHash: "m2" });
  fix.addNode({ qualifiedName: "FlowVersion:F.v1", label: "FlowVersion", sourceHash: "fv2" });
  fix.ctx.graphStore.deleteEdgesFor(fix.orgId, asQualifiedName("ApexMethod:Svc.old(1)"));
  fix.ctx.graphStore.deleteNode(fix.orgId, asQualifiedName("ApexMethod:Svc.old(1)"));
  fix.addNode({ qualifiedName: "OmniScript:A_B_English", label: "OmniScript", sourceHash: "os2" });
  fix.addNode({
    qualifiedName: "CustomMetadataRecord:Cfg.r1",
    label: "CustomMetadataRecord",
    sourceHash: "x2",
  });
  fix.addNode({ qualifiedName: "EntityFilter:EF1", label: "EntityFilter", sourceHash: "e2" });
  fix.addNode({ qualifiedName: "CustomMetadataRecord:Cfg.r2", label: "CustomMetadataRecord" });
}

describe("point_in_time_diff component scoping", () => {
  it("lists component units with members rolled up, records in their own bucket", async () => {
    const sid = baseline();
    change();
    const r = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    const d = r.data as {
      componentDiff: Buckets;
      nonComponentChanges: Buckets & { counts: Record<string, number> };
      nodeDiff: Buckets;
      counts: { components: Record<string, number>; nonComponent: Record<string, number> };
    };
    // Members fold into their owner; the owner row was not in the diff, so
    // the unit is "changed" (it existed before and after).
    expect(d.componentDiff.changed).toEqual(["ApexClass:Svc", "Flow:F", "OmniScript:A_B_English"]);
    expect(d.componentDiff.added).toEqual([]);
    expect(d.componentDiff.removed).toEqual([]);
    expect(d.nonComponentChanges.changed).toEqual([
      "CustomMetadataRecord:Cfg.r1",
      "EntityFilter:EF1",
    ]);
    expect(d.nonComponentChanges.added).toEqual(["CustomMetadataRecord:Cfg.r2"]);
    expect(d.counts.components).toEqual({ added: 0, removed: 0, changed: 3 });
    expect(d.counts.nonComponent).toEqual({ added: 1, removed: 0, changed: 2 });
    // The raw node-level diff is still there, every label included.
    expect(
      d.nodeDiff.removed.map((x) => (x as unknown as { qualifiedName: string }).qualifiedName),
    ).toEqual(["ApexMethod:Svc.old(1)"]);
    expect(r.markdown).toMatch(/Records and configuration/);
    expect(r.markdown).toContain("EntityFilter:EF1");
  });

  it("a unit whose own row was added stays added", async () => {
    const sid = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "s", true).id;
    fix.addNode({ qualifiedName: "ApexClass:New", label: "ApexClass" });
    fix.addNode({ qualifiedName: "ApexMethod:New.go(0)", label: "ApexMethod" });
    fix.addEdge({
      srcQualifiedName: "ApexClass:New",
      dstQualifiedName: "ApexMethod:New.go(0)",
      relType: REL_TYPES.CONTAINS_METHOD,
    });
    const r = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    const d = r.data as { componentDiff: Buckets };
    expect(d.componentDiff.added).toEqual(["ApexClass:New"]);
    expect(d.componentDiff.changed).toEqual([]);
  });
});

describe("what_broke component scoping", () => {
  it("seeds dependents from component changes only and buckets record/config apart", async () => {
    const sid = baseline();
    change();
    const r = await callTool("what_broke", { org: fix.orgId, since: sid });
    const d = r.data as {
      changed: string[];
      removed: string[];
      atRisk: string[];
      covered: string[];
      nonComponentChanges: Buckets;
      nonComponentDependents: string[];
      counts: Record<string, unknown>;
    };
    expect(d.changed).toEqual(["ApexClass:Svc", "Flow:F", "OmniScript:A_B_English"]);
    expect(d.removed).toEqual([]);
    expect(d.atRisk).toEqual(["ApexClass:Caller"]);
    expect(d.covered).toEqual([]);
    // VlocityAction depends on the changed OmniScript: a record/config
    // dependent, kept visible in its own bucket.
    expect(d.nonComponentDependents).toEqual(["VlocityAction:Act"]);
    expect(d.nonComponentChanges.changed).toEqual([
      "CustomMetadataRecord:Cfg.r1",
      "EntityFilter:EF1",
    ]);
    expect(d.nonComponentChanges.added).toEqual(["CustomMetadataRecord:Cfg.r2"]);
    expect(r.markdown).toMatch(/Records and configuration/);
  });

  it("a removed member is reported as its class", async () => {
    const sid = baseline();
    fix.ctx.graphStore.deleteEdgesFor(fix.orgId, asQualifiedName("ApexMethod:Svc.old(1)"));
    fix.ctx.graphStore.deleteNode(fix.orgId, asQualifiedName("ApexMethod:Svc.old(1)"));
    const r = await callTool("what_broke", { org: fix.orgId, since: sid });
    const d = r.data as { changed: string[]; removed: string[] };
    expect(d.changed).toEqual(["ApexClass:Svc"]);
    // The class still exists: it changed, it was not removed.
    expect(d.removed).toEqual([]);
  });
  it("reports the record/config changes it did not trace for dependents (fix M-6)", async () => {
    const sid = baseline();
    change();
    const r = await callTool("what_broke", { org: fix.orgId, since: sid });
    const d = r.data as {
      untracedSeeds: string[];
      untracedSeedsTotal: number;
      seedsTraced: number;
    };
    expect(d.untracedSeeds).toEqual([
      "CustomMetadataRecord:Cfg.r1",
      "CustomMetadataRecord:Cfg.r2",
      "EntityFilter:EF1",
    ]);
    expect(d.untracedSeedsTotal).toBe(3);
    expect(d.seedsTraced).toBe(4);
    expect(r.markdown).toContain("3 record/config changes not traced for dependents");
  });

  it("a dependent LWC bundle rolls up to its LWC, as a seed bundle does (fix M-7)", async () => {
    fix.addNode({ qualifiedName: "ApexClass:Ctl", label: "ApexClass", sourceHash: "k1" });
    // Bundles with no live LWC row: both fold by name grammar (changeUnitOf).
    fix.addNode({ qualifiedName: "LWCBundle:card", label: "LWCBundle" });
    fix.addEdge({
      srcQualifiedName: "LWCBundle:card",
      dstQualifiedName: "ApexClass:Ctl",
      relType: REL_TYPES.REFERENCES,
    });
    fix.addNode({ qualifiedName: "LWCBundle:other", label: "LWCBundle", sourceHash: "b1" });
    const sid = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "pre-sync", true).id;
    fix.addNode({ qualifiedName: "ApexClass:Ctl", label: "ApexClass", sourceHash: "k2" });
    fix.addNode({ qualifiedName: "LWCBundle:other", label: "LWCBundle", sourceHash: "b2" });
    const r = await callTool("what_broke", { org: fix.orgId, since: sid });
    const d = r.data as { changed: string[]; atRisk: string[]; covered: string[] };
    expect(d.changed).toEqual(["ApexClass:Ctl", "LWC:other"]);
    expect([...d.atRisk, ...d.covered]).toEqual(["LWC:card"]);
  });
});
