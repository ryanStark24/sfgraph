import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_MAX, SfgraphMcpServer, capData } from "../../server.js";
import { type Fixture, REL_TYPES, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

/**
 * Structured data (`_meta.data`) names things; it does not carry what is stored on them.
 * Record values, setting rows and query text stay in the graph.
 */
const SECRET = "s3cr3t-value-0042";
const SOQL = "SELECT Secret_Field__c FROM Account WHERE Name = 'hidden-0042'";

let fix: Fixture;

beforeEach(async () => {
  fix = await createFixture();
});

afterEach(async () => {
  await fix.cleanup();
});

describe("trace tools: structured data holds names, not stored values", () => {
  beforeEach(() => {
    fix.addNode({ qualifiedName: "ApexClass:Svc", label: "ApexClass" });
    fix.addNode({
      qualifiedName: "CustomSetting:Acme__c",
      label: "CustomSetting",
      attributes: { customSettingRows: [{ Api_Key__c: SECRET }] },
    });
    fix.addNode({
      qualifiedName: "CustomMetadataRecord:Cfg.r1",
      label: "CustomMetadataRecord",
      attributes: { values: [{ field: "Endpoint__c", value: SECRET }] },
    });
    for (const q of ["CustomSetting:Acme__c", "CustomMetadataRecord:Cfg.r1"]) {
      fix.addEdge({
        srcQualifiedName: q,
        dstQualifiedName: "ApexClass:Svc",
        relType: REL_TYPES.REFERENCES,
        attributes: { soql: SOQL, source: "file:///Users/someone/proj/Svc.cls" },
      });
    }
  });

  it("trace_upstream returns no record or setting values, query text or paths", async () => {
    const r = await callTool("trace_upstream", {
      org: fix.orgId,
      qname: "ApexClass:Svc",
      include_inferred: true,
    });
    const json = JSON.stringify(r.data);
    const d = r.data as { nodes: Array<{ qualifiedName: string }> };
    expect(d.nodes.map((n) => n.qualifiedName)).toContain("CustomSetting:Acme__c");
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("hidden-0042");
    expect(json).not.toContain("/Users/someone");
    expect(json).not.toContain("customSettingRows");
  });

  it("trace_downstream returns no stored values either", async () => {
    const r = await callTool("trace_downstream", {
      org: fix.orgId,
      qname: "CustomSetting:Acme__c",
      include_inferred: true,
    });
    const json = JSON.stringify(r.data);
    expect(json).toContain("ApexClass:Svc");
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("hidden-0042");
  });

  it("trace_upstream caps its lists at the text cap and says how many there were", async () => {
    const callers = Array.from({ length: 450 }, (_, i) => `ApexClass:Caller${i}`);
    fix.addNodes(callers.map((q) => ({ qualifiedName: q, label: "ApexClass" })));
    fix.addEdges(
      callers.map((q) => ({
        srcQualifiedName: q,
        dstQualifiedName: "ApexClass:Svc",
        relType: REL_TYPES.CALLS,
      })),
    );
    const r = await callTool("trace_upstream", { org: fix.orgId, qname: "ApexClass:Svc" });
    const d = r.data as {
      nodes: unknown[];
      edges: unknown[];
      nodeTotal: number;
      edgeTotal: number;
    };
    expect(d.nodeTotal).toBeGreaterThanOrEqual(450);
    expect(d.edgeTotal).toBeGreaterThanOrEqual(450);
    expect(d.nodes.length).toBe(300);
    expect(d.edges.length).toBe(300);
  });
});

describe("point_in_time_diff: structured data holds names and kinds, not values", () => {
  it("lists added, removed and changed nodes without their attributes, query text or old values", async () => {
    fix.addNode({
      qualifiedName: "CustomMetadataRecord:Cfg.gone",
      label: "CustomMetadataRecord",
      attributes: { values: [{ field: "Key__c", value: SECRET }] },
    });
    fix.addNode({
      qualifiedName: "CustomMetadataRecord:Cfg.same",
      label: "CustomMetadataRecord",
      attributes: { values: [{ field: "Key__c", value: "old-0042" }] },
      sourceHash: "v1",
    });
    fix.addNode({ qualifiedName: "ApexClass:A", label: "ApexClass" });
    const sid = fix.ctx.snapshotStore.createSnapshot(fix.orgId, "base", true).id;
    fix.ctx.graphStore.deleteNode(fix.orgId, "CustomMetadataRecord:Cfg.gone" as never);
    fix.addNode({
      qualifiedName: "CustomMetadataRecord:Cfg.same",
      label: "CustomMetadataRecord",
      attributes: { values: [{ field: "Key__c", value: "new-0042" }] },
      sourceHash: "v2",
    });
    fix.addNode({
      qualifiedName: "CustomSetting:Acme__c",
      label: "CustomSetting",
      attributes: { customSettingRows: [{ Api_Key__c: SECRET }] },
    });
    fix.addEdge({
      srcQualifiedName: "CustomSetting:Acme__c",
      dstQualifiedName: "ApexClass:A",
      relType: REL_TYPES.REFERENCES,
      attributes: { soql: SOQL },
    });
    const r = await callTool("point_in_time_diff", { org: fix.orgId, from: sid });
    const json = JSON.stringify(r.data);
    const d = r.data as {
      nodeDiff: {
        added: Array<{ qualifiedName: string }>;
        removed: Array<{ qualifiedName: string }>;
        changed: Array<{ qualifiedName: string }>;
      };
    };
    expect(d.nodeDiff.removed.map((n) => n.qualifiedName)).toEqual([
      "CustomMetadataRecord:Cfg.gone",
    ]);
    expect(d.nodeDiff.changed.map((n) => n.qualifiedName)).toEqual([
      "CustomMetadataRecord:Cfg.same",
    ]);
    expect(d.nodeDiff.added.map((n) => n.qualifiedName)).toContain("CustomSetting:Acme__c");
    for (const v of [SECRET, "old-0042", "new-0042", "hidden-0042"]) expect(json).not.toContain(v);
  });
});

describe("every tool's structured data is capped (capData)", () => {
  it("leaves data that fits unchanged", () => {
    const d = { a: [1, 2, 3], b: "x" };
    expect(capData(d)).toBe(d);
  });

  it("keeps what fits, stubs the oversized fields and flags the cut", () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({
      q: `ApexClass:C${i}`,
      pad: "x".repeat(40),
    }));
    const out = capData({ found: true, total: 5000, items: big }) as Record<string, unknown>;
    expect(JSON.stringify(out).length).toBeLessThan(DATA_MAX);
    expect(out.found).toBe(true);
    expect(out.total).toBe(5000);
    expect(out.items).toEqual({ omitted: true, items: 5000 });
    expect(out.dataCut).toBe(true);
  });

  it("applies to a tool result sent through the server", async () => {
    const s = new SfgraphMcpServer();
    s.registry.register(
      "big_data_probe",
      async () => ({
        summary: "ok",
        markdown: "ok",
        data: { rows: Array.from({ length: 20000 }, (_, i) => `row-${i}`) },
      }),
      { name: "big_data_probe", description: "probe", inputSchema: { type: "object" } } as never,
    );
    const r = await s.dispatch("big_data_probe", {});
    expect(JSON.stringify(r._meta?.data).length).toBeLessThan(DATA_MAX);
    expect((r._meta?.data as { dataCut?: boolean }).dataCut).toBe(true);
  });
});
