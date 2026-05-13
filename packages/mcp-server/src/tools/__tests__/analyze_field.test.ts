import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
  fix.addNode({ qualifiedName: "CustomField:Account.Name", label: "CustomField" });
  fix.addNode({ qualifiedName: "ApexClass:Reader", label: "ApexClass" });
  fix.addNode({ qualifiedName: "ApexClass:Writer", label: "ApexClass" });
  fix.addNode({ qualifiedName: "PermissionSet:Sales", label: "PermissionSet" });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Reader",
    dstQualifiedName: "CustomField:Account.Name",
    relType: REL_TYPES.READS_FIELD,
  });
  fix.addEdge({
    srcQualifiedName: "ApexClass:Writer",
    dstQualifiedName: "CustomField:Account.Name",
    relType: REL_TYPES.WRITES_FIELD,
  });
  fix.addEdge({
    srcQualifiedName: "PermissionSet:Sales",
    dstQualifiedName: "CustomField:Account.Name",
    relType: REL_TYPES.GRANTS_FIELD_ACCESS,
  });
});

afterEach(async () => {
  await fix.cleanup();
});

describe("analyze_field", () => {
  it("returns readers", async () => {
    const r = await callTool("analyze_field", { org: fix.orgId, object: "Account", field: "Name" });
    expect((r.data as { readers: string[] }).readers).toContain("ApexClass:Reader");
  });

  it("returns writers", async () => {
    const r = await callTool("analyze_field", { org: fix.orgId, object: "Account", field: "Name" });
    expect((r.data as { writers: string[] }).writers).toContain("ApexClass:Writer");
  });

  it("returns grants and mermaid", async () => {
    const r = await callTool("analyze_field", { org: fix.orgId, object: "Account", field: "Name" });
    expect((r.data as { grants: string[] }).grants).toContain("PermissionSet:Sales");
    expect(r.markdown).toMatch(/```mermaid/);
  });
});
