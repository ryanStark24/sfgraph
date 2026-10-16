import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool, defaultRegistry } from "./_runner.js";

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

  it("hides grants by default and shows them with include_grants", async () => {
    const r = await callTool("analyze_field", { org: fix.orgId, object: "Account", field: "Name" });
    const d = r.data as { grants: string[]; grants_count: number };
    expect(d.grants).toEqual([]);
    expect(d.grants_count).toBe(1);
    expect(r.markdown).not.toContain("PermissionSet:Sales");
    expect(r.markdown).toContain("include_grants");
    // Cycle 3 T3: the Picture is shown by default; a hidden grant is not drawn in it.
    expect(r.markdown).toMatch(/```mermaid/);
    expect(r.markdown).not.toContain("Permission set: Sales");
    const g = await callTool("analyze_field", {
      org: fix.orgId,
      object: "Account",
      field: "Name",
      include_grants: true,
    });
    expect((g.data as { grants: string[] }).grants).toContain("PermissionSet:Sales");
    expect(g.markdown).toContain("- PermissionSet:Sales");
  });

  it("does not list a profile whose entry denies the field as giving access", async () => {
    fix.addNode({ qualifiedName: "Profile:Guest", label: "Profile" });
    fix.addEdge({
      srcQualifiedName: "Profile:Guest",
      dstQualifiedName: "CustomField:Account.Name",
      relType: REL_TYPES.GRANTS_FIELD_ACCESS,
      attributes: { readable: false, editable: false },
    });
    const r = await callTool("analyze_field", {
      org: fix.orgId,
      object: "Account",
      field: "Name",
      include_grants: true,
    });
    const d = r.data as { grants: string[]; grants_count: number };
    expect(d.grants).toEqual(["PermissionSet:Sales"]);
    expect(d.grants_count).toBe(1);
    expect(r.markdown).not.toContain("Profile:Guest");
  });

  it("includes DataRaptor and every other *_READS_FIELD / *_WRITES_FIELD rel", async () => {
    fix.addNode({ qualifiedName: "DataRaptor:Loader", label: "DataRaptor" });
    fix.addNode({ qualifiedName: "DataRaptor:Extractor", label: "DataRaptor" });
    fix.addEdge({
      srcQualifiedName: "DataRaptor:Loader",
      dstQualifiedName: "CustomField:Account.Name",
      relType: REL_TYPES.DR_WRITES_FIELD,
    });
    fix.addEdge({
      srcQualifiedName: "DataRaptor:Extractor",
      dstQualifiedName: "CustomField:Account.Name",
      relType: REL_TYPES.DR_READS_FIELD,
    });
    const r = await callTool("analyze_field", { org: fix.orgId, object: "Account", field: "Name" });
    const d = r.data as { readers: string[]; writers: string[] };
    expect(d.writers).toContain("DataRaptor:Loader");
    expect(d.readers).toContain("DataRaptor:Extractor");
    const md = r.markdown as string;
    expect(md).toContain("- DataRaptor:Loader — DR_WRITES_FIELD");
    expect(md).toContain("- DataRaptor:Extractor — DR_READS_FIELD");
    expect(md).toContain("- ApexClass:Reader — READS_FIELD");
    expect(md).toMatch(/readers 2/);
    expect(md).toMatch(/writers 2/);
  });

  it("mermaid:false hides the diagram (shown by default since cycle 3 T3)", async () => {
    const r = await callTool("analyze_field", {
      org: fix.orgId,
      object: "Account",
      field: "Name",
      mermaid: false,
    });
    expect(r.markdown).not.toMatch(/```mermaid/);
  });

  it("mermaid:true appends the diagram", async () => {
    const r = await callTool("analyze_field", {
      org: fix.orgId,
      object: "Account",
      field: "Name",
      mermaid: true,
    });
    expect(r.markdown).toMatch(/```mermaid/);
  });

  it("description names DataRaptors", () => {
    expect(defaultRegistry.get("analyze_field")?.schema.description).toMatch(/DataRaptor/);
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

  it("reports inbound edges when the field node is missing but edges target it", async () => {
    fix.addNode({ qualifiedName: "DataRaptor:Fetcher", label: "DataRaptor" });
    fix.addNode({ qualifiedName: "Layout:Widget-Main", label: "Layout" });
    fix.addEdge({
      srcQualifiedName: "DataRaptor:Fetcher",
      dstQualifiedName: "CustomField:Widget__c.Size__c",
      relType: REL_TYPES.DR_READS_FIELD,
    });
    fix.addEdge({
      srcQualifiedName: "Layout:Widget-Main",
      dstQualifiedName: "CustomField:Widget__c.Size__c",
      relType: REL_TYPES.RENDERS_FIELD,
    });
    const r = await callTool("analyze_field", {
      org: fix.orgId,
      object: "Widget__c",
      field: "Size__c",
    });
    const d = r.data as { found: boolean; readers: string[]; other: string[] };
    expect(d.found).toBe(false);
    expect(d.readers).toEqual(["DataRaptor:Fetcher"]);
    expect(d.other).toEqual(["Layout:Widget-Main"]);
    const md = r.markdown as string;
    expect(md).toContain("no node");
    expect(md).toContain("- DataRaptor:Fetcher — DR_READS_FIELD");
    expect(md).toContain("- Layout:Widget-Main — RENDERS_FIELD");
    expect(r.summary).not.toBe("field not found");
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

  it("counts LWC bindings as readers and workflow updates as writers; description is honest", async () => {
    fix.addNode({ qualifiedName: "LWC:cmp", label: "LWC" });
    fix.addNode({ qualifiedName: "WorkflowFieldUpdate:Upd", label: "WorkflowFieldUpdate" });
    fix.addEdge({
      srcQualifiedName: "LWC:cmp",
      dstQualifiedName: "CustomField:Account.Name",
      relType: REL_TYPES.LWC_BINDS_FIELD,
    });
    fix.addEdge({
      srcQualifiedName: "WorkflowFieldUpdate:Upd",
      dstQualifiedName: "CustomField:Account.Name",
      relType: REL_TYPES.WORKFLOW_UPDATES_FIELD,
    });
    const r = await callTool("analyze_field", { org: fix.orgId, object: "Account", field: "Name" });
    const d = r.data as { readers: string[]; writers: string[] };
    expect(d.readers).toContain("LWC:cmp");
    expect(d.writers).toContain("WorkflowFieldUpdate:Upd");
    // Cycle 3 T5: the caveat is in the result text, not the description.
    expect(r.markdown).toMatch(/Not tracked directly: OmniScript, .*DataRaptors they call/);
    expect(r.markdown).not.toMatch(/Flows, LWC, OmniScripts/);
  });

  it("caps readers+writers at 300 with a narrowing line", async () => {
    fix.addNode({ qualifiedName: "CustomField:Account.Hot", label: "CustomField" });
    for (let i = 0; i < 350; i++) {
      fix.addEdge({
        srcQualifiedName: `ApexClass:H${i}`,
        dstQualifiedName: "CustomField:Account.Hot",
        relType: REL_TYPES.READS_FIELD,
      });
    }
    const r = await callTool("analyze_field", { org: fix.orgId, object: "Account", field: "Hot" });
    const md = r.markdown as string;
    // Reader/writer lines of Technical details (`- <qname> — <REL>`), not the report's other lists.
    expect(md.split("\n").filter((l) => /^- \S+ — [A-Z_]+$/.test(l)).length).toBe(300);
    expect(md).toContain("readers 350");
    expect(md).toMatch(/50 more.*narrow/);
  });

  // Cycle 3 T5: these caveats moved from the description into the result text.
  it("the result notes commented-out code is excluded and Flow is tracked", async () => {
    fix.addEdge({
      srcQualifiedName: "Flow:F",
      dstQualifiedName: "CustomField:Account.Name",
      relType: REL_TYPES.READS_FIELD,
    });
    const r = await callTool("analyze_field", { org: fix.orgId, object: "Account", field: "Name" });
    expect(r.markdown).toMatch(/commented-out code/);
    expect(r.markdown).toContain(
      "Flow field references are tracked (READS_FIELD/WRITES_FIELD from Flow)",
    );
    expect(r.markdown).not.toContain("Not tracked directly: Flow");
    const d = defaultRegistry.get("analyze_field")?.schema.description ?? "";
    expect(d).not.toMatch(/commented-out|NOT tracked/);
  });
});
