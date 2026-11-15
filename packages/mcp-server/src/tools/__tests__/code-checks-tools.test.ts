import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FilesystemMetadataSource,
  SqliteGraphStore,
  SqliteSnapshotStore,
  liveIngest,
  offlineResolvedOrg,
} from "@ryanstark24/sfgraph-core";
import { ConsoleLogger, type OrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ToolContext, setToolContextFactory } from "../../context.js";
import { assertNoDataPointer, callTool } from "./_runner.js";

// S-1.9.0-001..005: the four checks through the MCP tools. A real filesystem ingest of the
// synthetic project in core's analyze fixtures, then governor_risk_check, security_audit and
// export_sarif. Existing fields keep their shape; the new ones are additive.

const FIXTURE = path.resolve(
  __dirname,
  "../../../../core/src/analyze/__tests__/fixtures/code-checks-project",
);

type Risk = {
  qualifiedName: string;
  risk: string;
  evidence: string;
  ruleId?: string;
  severity?: string;
  file?: string;
  line?: number;
  message?: string;
  element?: string;
  loop?: string;
};

let dir: string;
let store: SqliteGraphStore;
let prevExports: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sfg-code-tools-"));
  const proj = path.join(dir, "proj");
  cpSync(FIXTURE, proj, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const dbPath = path.join(dir, "g.sqlite");
  store = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
  await store.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (store as unknown as { db: never }).db,
    skipMigrations: true,
  });
  await snapshotStore.init();
  const org = offlineResolvedOrg(proj, "fixture");
  await liveIngest({
    alias: "fixture",
    graphStore: store,
    mode: "full",
    rebuild: true,
    preResolved: org,
    metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
    logger: new ConsoleLogger("error"),
    skipSnapshot: true,
    analysisDb: store.db,
  });
  const ctx: ToolContext = { graphStore: store, snapshotStore, orgId: org.orgId as OrgId };
  setToolContextFactory(async () => ctx);
  prevExports = process.env.SFGRAPH_EXPORTS_DIR;
  process.env.SFGRAPH_EXPORTS_DIR = path.join(dir, "exports");
});

afterEach(async () => {
  setToolContextFactory(null);
  vi.restoreAllMocks();
  if (prevExports === undefined) Reflect.deleteProperty(process.env, "SFGRAPH_EXPORTS_DIR");
  else process.env.SFGRAPH_EXPORTS_DIR = prevExports;
  await store.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

describe("governor_risk_check: async work and Flow DML in a loop", () => {
  it("lists them with rule id, severity, file, line and the existing fields", async () => {
    const r = await callTool("governor_risk_check", { org: "fixture", limit: 100 });
    assertNoDataPointer("governor_risk_check", r);
    const d = r.data as {
      risks: Risk[];
      total: number;
      truncated: boolean;
      scan: { complete: boolean };
    };
    expect(d.scan.complete).toBe(true);
    const kinds = new Set(d.risks.map((x) => x.risk));
    expect(kinds).toEqual(new Set(["async_in_loop", "flow_dml_in_loop"]));
    expect(d.total).toBe(10);
    const one = d.risks.find((x) => x.risk === "async_in_loop" && x.line === 6);
    expect(one).toMatchObject({
      qualifiedName: "ApexMethod:VisitTriggerHandler.enqueuePerVisit(1)",
      risk: "async_in_loop",
      evidence: "System.enqueueJob(new VisitQueueable(v.Id));",
      ruleId: "governor.async-in-loop",
      severity: "high",
    });
    expect(one?.file).toMatch(/classes\/VisitTriggerHandler\.cls$/);
    const flow = d.risks.find((x) => x.qualifiedName === "Flow:Visit_Close_Tasks");
    expect(flow).toMatchObject({
      risk: "flow_dml_in_loop",
      ruleId: "governor.flow-dml-in-loop",
      severity: "high",
      element: "Update_Task",
      loop: "Loop_Open_Tasks",
      line: 38,
    });
    expect(r.markdown).toContain("async_in_loop");
    expect(r.markdown).toContain("(line 6)");
    expect(r.markdown).toContain("`Flow:Visit_Close_Tasks`");
  });

  it("min_severity high keeps them, and the existing limit kinds are not invented", async () => {
    const r = await callTool("governor_risk_check", { org: "fixture", min_severity: "high" });
    const d = r.data as { risks: Risk[] };
    expect(d.risks.length).toBe(10);
    expect(d.risks.some((x) => x.risk === "soql_in_loop" || x.risk === "dml_in_loop")).toBe(false);
  });
});

describe("security_audit: injection in Apex and component JavaScript", () => {
  it("adds codeFindings and keeps every existing field", async () => {
    const r = await callTool("security_audit", { org: "fixture", limit: 100 });
    assertNoDataPointer("security_audit", r);
    const d = r.data as Record<string, unknown> & {
      codeFindings: Array<{
        ruleId: string;
        severity: string;
        qualifiedName: string;
        line?: number;
        file?: string;
        evidence: string;
      }>;
      codeFindingsTotal: number;
      codeScan: { complete: boolean };
    };
    for (const key of [
      "sharingEditAccess",
      "sharingRuleAccess",
      "flsGaps",
      "fieldAccessMatrix",
      "flsGapsTotal",
      "truncated",
      "limited",
      "cachedFindings",
    ]) {
      expect(d).toHaveProperty(key);
    }
    expect(d.codeScan.complete).toBe(true);
    expect(d.codeFindingsTotal).toBe(8);
    const byRule = (id: string) => d.codeFindings.filter((f) => f.ruleId === id);
    expect(byRule("security.soql-injection")).toHaveLength(4);
    expect(byRule("security.dom-injection")).toHaveLength(4);
    expect(
      byRule("security.dom-injection")
        .map((f) => f.severity)
        .sort(),
    ).toEqual(["high", "high", "high", "low"]);
    expect(d.codeFindings.every((f) => f.file && f.line && f.evidence)).toBe(true);
    expect(r.summary).toMatch(/8 code security findings$/);
    expect(r.markdown).toContain("Code security findings (injection)");
  });

  it("an audit with no code findings returns the same data keys as before 1.9.0", async () => {
    store.mergeNodes([]);
    const r = await callTool("security_audit", { org: "fixture", object: "Visit__c" });
    const d = r.data as Record<string, unknown>;
    expect("codeFindings" in d).toBe(false);
    expect("codeScan" in d).toBe(false);
  });

  it("narrowed to one field, the code checks are left out", async () => {
    const r = await callTool("security_audit", {
      org: "fixture",
      field: "CustomField:Visit__c.Notes__c",
    });
    const d = r.data as { codeFindingsTotal?: number; codeScan?: unknown };
    expect(d.codeFindingsTotal).toBeUndefined();
    expect(d.codeScan).toBeUndefined();
    expect(r.summary).not.toMatch(/code security/);
  });
});

describe("export_sarif carries the new rules", () => {
  it("emits the four rule ids with level, file and line, and rule descriptors", async () => {
    const r = await callTool("export_sarif", { org: "fixture" });
    const file = /Saved to `([^`]+)`/.exec(r.markdown)?.[1]?.replace(/^~/, process.env.HOME ?? "~");
    const out =
      (r.data as { path?: string; file?: string }).path ??
      (r.data as { file?: string }).file ??
      file;
    expect(out).toBeTruthy();
    const sarif = JSON.parse(readFileSync(out as string, "utf8")) as {
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string }> } };
        results: Array<{
          ruleId: string;
          level: string;
          locations?: Array<{
            physicalLocation?: {
              artifactLocation: { uri: string };
              region?: { startLine: number };
            };
          }>;
        }>;
      }>;
    };
    const run = sarif.runs[0];
    const ids = new Set(run?.results.map((x) => x.ruleId));
    for (const id of [
      "governor.async-in-loop",
      "governor.flow-dml-in-loop",
      "security.soql-injection",
      "security.dom-injection",
    ]) {
      expect(ids.has(id)).toBe(true);
      expect(run?.tool.driver.rules.some((x) => x.id === id)).toBe(true);
    }
    const inj = run?.results.find((x) => x.ruleId === "security.soql-injection");
    expect(inj?.level).toBe("error");
    expect(inj?.locations?.[0]?.physicalLocation?.region?.startLine).toBeGreaterThan(0);
    expect(inj?.locations?.[0]?.physicalLocation?.artifactLocation.uri).toMatch(
      /VisitSearchController\.cls$/,
    );
  });
});
