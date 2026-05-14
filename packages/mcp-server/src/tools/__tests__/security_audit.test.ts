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
});
