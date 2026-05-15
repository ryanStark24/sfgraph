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

  it("returns found:false for unknown field", async () => {
    const r = await callTool("analyze_field", {
      org: fix.orgId,
      object: "Account",
      field: "Nonexistent__c",
    });
    expect((r.data as { found: boolean }).found).toBe(false);
    expect(r.summary).toBe("field not found");
  });

  it("rejects dotted object name (regex)", async () => {
    await expect(
      callTool("analyze_field", { org: fix.orgId, object: "Account.Name", field: "X" }),
    ).rejects.toThrow();
  });

  it("rejects field name with whitespace", async () => {
    await expect(
      callTool("analyze_field", { org: fix.orgId, object: "Account", field: "First Name" }),
    ).rejects.toThrow();
  });

  it("rejects empty org", async () => {
    await expect(
      callTool("analyze_field", { org: "", object: "Account", field: "Name" }),
    ).rejects.toThrow();
  });

  it("handles field with zero readers/writers/grants", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Lonely", label: "CustomField" });
    const r = await callTool("analyze_field", {
      org: fix.orgId,
      object: "Account",
      field: "Lonely",
    });
    const d = r.data as { readers: string[]; writers: string[]; grants: string[] };
    expect(d.readers).toEqual([]);
    expect(d.writers).toEqual([]);
    expect(d.grants).toEqual([]);
  });

  it("scales to 100 readers", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Wide", label: "CustomField" });
    for (let i = 0; i < 100; i++) {
      fix.addNode({ qualifiedName: `ApexClass:R${i}`, label: "ApexClass" });
      fix.addEdge({
        srcQualifiedName: `ApexClass:R${i}`,
        dstQualifiedName: "CustomField:Account.Wide",
        relType: REL_TYPES.READS_FIELD,
      });
    }
    const r = await callTool("analyze_field", {
      org: fix.orgId,
      object: "Account",
      field: "Wide",
    });
    expect((r.data as { readers: string[] }).readers.length).toBe(100);
  });
});
