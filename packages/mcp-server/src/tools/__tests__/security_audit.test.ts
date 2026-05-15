import type { NodeFact } from "@ryanstark24/sfgraph-core";
import { asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("security_audit", () => {
  it("reports flsGaps for unprotected fields", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Bare", label: "CustomField" });
    const r = await callTool("security_audit", { org: fix.orgId });
    expect((r.data as { flsGaps: string[] }).flsGaps).toContain("CustomField:Account.Bare");
  });

  it("flags full-access sharing rule", async () => {
    fix.addNode({
      qualifiedName: "SharingRule:Open",
      label: "SharingRule",
      attributes: { accessLevel: "All" },
    });
    const r = await callTool("security_audit", { org: fix.orgId });
    expect((r.data as { sharingFullAccess: string[] }).sharingFullAccess).toContain(
      "SharingRule:Open",
    );
  });

  it("surfaces truncated=false on small fixtures (P2)", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Foo", label: "CustomField" });
    const r = await callTool("security_audit", { org: fix.orgId });
    expect((r.data as { truncated: boolean }).truncated).toBe(false);
  });

  it("builds field access matrix from grants", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.X", label: "CustomField" });
    fix.addNode({ qualifiedName: "PermissionSet:P1", label: "PermissionSet" });
    fix.addEdge({
      srcQualifiedName: "PermissionSet:P1",
      dstQualifiedName: "CustomField:Account.X",
      relType: REL_TYPES.GRANTS_FIELD_ACCESS,
    });
    const r = await callTool("security_audit", { org: fix.orgId });
    const m = (r.data as { fieldAccessMatrix: Array<{ field: string; grantedBy: string[] }> })
      .fieldAccessMatrix;
    expect(m.some((x) => x.field === "CustomField:Account.X")).toBe(true);
  });

  it("returns zero gaps for empty graph", async () => {
    const r = await callTool("security_audit", { org: fix.orgId });
    const d = r.data as { flsGaps: string[]; sharingFullAccess: string[] };
    expect(d.flsGaps).toEqual([]);
    expect(d.sharingFullAccess).toEqual([]);
  });

  it("excludes field with permission-set grant from flsGaps", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Protected", label: "CustomField" });
    fix.addNode({ qualifiedName: "PermissionSet:Guard", label: "PermissionSet" });
    fix.addEdge({
      srcQualifiedName: "PermissionSet:Guard",
      dstQualifiedName: "CustomField:Account.Protected",
      relType: REL_TYPES.GRANTS_FIELD_ACCESS,
    });
    const r = await callTool("security_audit", { org: fix.orgId });
    expect((r.data as { flsGaps: string[] }).flsGaps).not.toContain(
      "CustomField:Account.Protected",
    );
  });

  it("honors object filter (narrows flsGaps)", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.A", label: "CustomField" });
    fix.addNode({ qualifiedName: "CustomField:Contact.B", label: "CustomField" });
    const r = await callTool("security_audit", { org: fix.orgId, object: "Account" });
    const gaps = (r.data as { flsGaps: string[] }).flsGaps;
    expect(gaps).toContain("CustomField:Account.A");
    expect(gaps).not.toContain("CustomField:Contact.B");
  });

  it("rejects empty org", async () => {
    await expect(callTool("security_audit", { org: "" })).rejects.toThrow();
  });

  it("summary reports gap count", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Bare1", label: "CustomField" });
    fix.addNode({ qualifiedName: "CustomField:Account.Bare2", label: "CustomField" });
    const r = await callTool("security_audit", { org: fix.orgId });
    expect(r.summary).toMatch(/2 FLS gaps/);
  });

  it("flags truncated=true when a label exceeds the 5000-row cap", async () => {
    const facts: NodeFact[] = [];
    for (let i = 0; i < 5001; i++) {
      facts.push({
        orgId: fix.orgId,
        qualifiedName: asQualifiedName(`CustomField:Account.F${i}`),
        label: "CustomField",
        attributes: {},
        sourceHash: asSha256(`h-${i}`),
        firstSeenAt: 1,
        lastSeenAt: 1,
        lastModifiedAt: 1,
      });
    }
    fix.ctx.graphStore.mergeNodes(facts);
    const r = await callTool("security_audit", { org: fix.orgId });
    expect((r.data as { truncated: boolean }).truncated).toBe(true);
    expect(r.summary).toContain("results capped");
  });
});
