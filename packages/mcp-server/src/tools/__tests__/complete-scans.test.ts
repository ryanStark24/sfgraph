import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FilesystemMetadataSource,
  SqliteGraphStore,
  SqliteSnapshotStore,
  analyze,
  liveIngest,
  offlineResolvedOrg,
} from "@ryanstark24/sfgraph-core";
import { ConsoleLogger, type OrgId } from "@ryanstark24/sfgraph-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ToolContext, closeAllContexts, setToolContextFactory } from "../../context.js";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool } from "./_runner.js";

// S-1.8.2-004/005/006 (F04, F06, F07): audit scans page to completion, say how much they
// looked at, and never say "no findings" for a partial scan; dead-code text says "no captured
// incoming references" and keeps external entry points apart; unbounded_query and no_bulk work
// on normally parsed Apex. All through the MCP tool handlers.

type Db = { prepare: (s: string) => unknown };
const dbOf = (f: Fixture): Db => (f.ctx.graphStore as unknown as { db: Db }).db;

function recordSync(f: Fixture): void {
  f.ctx.graphStore.upsertOrg({
    id: f.orgId,
    alias: "scan",
    instanceUrl: "https://example.invalid",
    apiVersion: "62.0",
    createdAt: Date.now(),
  });
  f.ctx.graphStore.markSyncComplete(f.orgId, new Date(Date.now() - 60_000).toISOString());
}

async function populateCache(f: Fixture): Promise<void> {
  (f.ctx as { db?: unknown }).db = dbOf(f);
  recordSync(f);
  await analyze.populateAnalysisTables(f.ctx.graphStore, f.orgId, dbOf(f) as never);
}

type Sarif = {
  runs: Array<{
    results: Array<{
      ruleId: string;
      message: { text: string };
      properties?: Record<string, unknown>;
    }>;
    properties?: Record<string, unknown>;
    invocations?: Array<{ toolExecutionNotifications: Array<{ message: { text: string } }> }>;
  }>;
};

let fix: Fixture;
let exportsDir: string;
let prevExports: string | undefined;

beforeEach(async () => {
  fix = await createFixture();
  exportsDir = path.join(fix.workDir, "exports");
  prevExports = process.env.SFGRAPH_EXPORTS_DIR;
  process.env.SFGRAPH_EXPORTS_DIR = exportsDir;
});

afterEach(async () => {
  analyze.scanLimits.maxNodesPerLabel = 5_000_000;
  await closeAllContexts();
  if (prevExports === undefined) Reflect.deleteProperty(process.env, "SFGRAPH_EXPORTS_DIR");
  else process.env.SFGRAPH_EXPORTS_DIR = prevExports;
  await fix.cleanup();
});

describe("F04: dead_code_audit above the old 10,000-node cap", () => {
  const N = 10_001;
  const LAST = `ApexClass:Scale${String(N - 1).padStart(5, "0")}`;

  beforeEach(() => {
    fix.ctx.graphStore.transaction(() =>
      fix.addNodes(
        Array.from({ length: N }, (_, i) => ({
          qualifiedName: `ApexClass:Scale${String(i).padStart(5, "0")}`,
          label: "ApexClass",
          attributes: { modifiers: ["public"] },
          lastModifiedAt: 1,
        })),
      ),
    );
  });

  it("finds the class right after the cap by pattern, without the cache", async () => {
    const r = await callTool("dead_code_audit", {
      org: fix.orgId,
      label: "ApexClass",
      pattern: "Scale10000",
    });
    const d = r.data as {
      dead: Array<{ qualifiedName: string }>;
      total: number;
      scan: analyze.ScanCoverage;
    };
    expect(d.dead.map((x) => x.qualifiedName)).toEqual([LAST]);
    expect(d.scan.complete).toBe(true);
    expect(r.markdown).not.toContain("No code with no captured incoming references found");
  });

  it("without a filter, counts every class and reports full coverage", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, limit: 5 });
    const d = r.data as { total: number; scan: analyze.ScanCoverage };
    expect(d.total).toBe(N);
    expect(d.scan).toEqual({ scanned: N, total: N, complete: true });
  });

  it("finds it with the cache populated too, and SARIF lists it live and cached", async () => {
    const live = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    const liveReport = (live.data as { report: Sarif }).report;
    expect(
      liveReport.runs[0]?.results.filter((x) => x.ruleId === "dead-code.unreferenced"),
    ).toHaveLength(N);

    await populateCache(fix);
    const r = await callTool("dead_code_audit", { org: fix.orgId, pattern: "Scale10000" });
    const d = r.data as { dead: Array<{ qualifiedName: string }>; cached: boolean };
    expect(d.cached).toBe(true);
    expect(d.dead.map((x) => x.qualifiedName)).toEqual([LAST]);

    const cached = await callTool("export_sarif", { org: fix.orgId, audits: ["dead-code"] });
    const cd = cached.data as {
      report: Sarif;
      sources: Record<string, string>;
      scanCoverage: Record<string, analyze.ScanCoverage>;
    };
    expect(cd.sources["dead-code"]).toBe("cache");
    expect(cd.report.runs[0]?.results).toHaveLength(N);
    expect(cd.report.runs[0]?.results.some((x) => x.message.text.startsWith(LAST))).toBe(true);
    expect(cd.scanCoverage["dead-code"]).toEqual({ scanned: N, total: N, complete: true });
    expect(cd.report.runs[0]?.properties?.sfgraphScanComplete).toBe(true);
  });
});

describe("F04: governor scans above the old 20,000-node cap", () => {
  const N = 20_001;
  const LAST = `ApexMethod:Scale.m${String(N - 1).padStart(5, "0")}(0)`;

  beforeEach(() => {
    fix.ctx.graphStore.transaction(() => {
      fix.addNodes(
        Array.from({ length: N }, (_, i) => ({
          qualifiedName: `ApexMethod:Scale.m${String(i).padStart(5, "0")}(0)`,
          label: "ApexMethod",
          attributes: { isTest: false },
        })),
      );
      fix.addEdges([
        {
          srcQualifiedName: LAST,
          dstQualifiedName: "CustomObject:Account",
          relType: "EXECUTES_SOQL",
          attributes: { inLoop: true, query: "[SELECT Id FROM Account]" },
        },
      ]);
    });
  });

  it("reports the in-loop query on the last method (no cache)", async () => {
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const d = r.data as {
      risks: Array<{ qualifiedName: string; risk: string }>;
      scan: analyze.ScanCoverage;
    };
    expect(d.risks).toEqual([
      expect.objectContaining({ qualifiedName: LAST, risk: "soql_in_loop" }),
    ]);
    expect(d.scan).toEqual({ scanned: N, total: N, complete: true });
  });

  it("reports it with the cache populated, and in SARIF", async () => {
    await populateCache(fix);
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    expect(
      (r.data as { risks: Array<{ qualifiedName: string }> }).risks.map((x) => x.qualifiedName),
    ).toEqual([LAST]);
    const s = await callTool("export_sarif", { org: fix.orgId, audits: ["governor"] });
    const res = (s.data as { report: Sarif }).report.runs[0]?.results ?? [];
    expect(res.map((x) => x.ruleId)).toEqual(["governor.soql-in-loop"]);
    expect(res[0]?.message.text).toContain(LAST);
  });
});

describe("F04: a scan that hits its safety limit says so instead of claiming nothing was found", () => {
  beforeEach(() => {
    fix.addNodes(
      Array.from({ length: 150 }, (_, i) => ({
        qualifiedName: `ApexClass:Cls${String(i).padStart(3, "0")}`,
        label: "ApexClass",
        attributes: { modifiers: ["public"] },
      })),
    );
    fix.addNodes(
      Array.from({ length: 150 }, (_, i) => ({
        qualifiedName: `ApexMethod:Cls.m${String(i).padStart(3, "0")}(0)`,
        label: "ApexMethod",
        attributes: { isTest: false },
      })),
    );
    // Every class is referenced, so a complete dead-code scan would find none.
    fix.addNodes([{ qualifiedName: "ApexClass:User", label: "ApexClass" }]);
    fix.addEdges(
      Array.from({ length: 150 }, (_, i) => ({
        srcQualifiedName: "ApexClass:User",
        dstQualifiedName: `ApexClass:Cls${String(i).padStart(3, "0")}`,
        relType: "REFERENCES",
      })),
    );
    analyze.scanLimits.maxNodesPerLabel = 100;
  });

  it("dead_code_audit: no 'nothing found' for the partial scan, in text and data", async () => {
    const r = await callTool("dead_code_audit", { org: fix.orgId, label: "ApexClass" });
    const d = r.data as { dead: unknown[]; scan: analyze.ScanCoverage };
    expect(d.scan.complete).toBe(false);
    expect(d.scan.scanned).toBe(100);
    expect(d.scan.total).toBe(151);
    expect(r.markdown).toContain("in the 100 of 151 inspected");
    expect(r.markdown).not.toMatch(/No code with no captured incoming references found among/);
    expect(r.summary).toContain("scan incomplete");
  });

  it("governor_risk_check: 'none in the N of M inspected', not 'no spots found'", async () => {
    const r = await callTool("governor_risk_check", { org: fix.orgId });
    const d = r.data as { scan: analyze.ScanCoverage; total: number };
    expect(d.total).toBe(0);
    expect(d.scan).toEqual({ scanned: 100, total: 150, complete: false });
    expect(r.markdown).toContain("in the 100 of 150 methods and triggers inspected");
    expect(r.markdown).not.toContain("No spots found where Apex code");
    expect(r.summary).toContain("scan incomplete");
  });

  it("export_sarif: run properties and a warning notification carry the incomplete scan", async () => {
    const s = await callTool("export_sarif", { org: fix.orgId, audits: ["governor", "dead-code"] });
    const run = (s.data as { report: Sarif }).report.runs[0];
    expect(run?.properties?.sfgraphScanComplete).toBe(false);
    expect(run?.properties?.sfgraphScanCoverage).toMatchObject({
      governor: { scanned: 100, total: 150, complete: false },
    });
    expect(
      run?.invocations?.[0]?.toolExecutionNotifications.map((n) => n.message.text).join(" "),
    ).toContain("inspected 100 of 150");
    expect(s.markdown).toContain("scan is incomplete");
  });

  it("a cache written by a partial scan is reported incomplete (and a filter rescans live)", async () => {
    await populateCache(fix);
    const cov = analyze.readScanCoverage(dbOf(fix) as never, fix.orgId, "dead_code");
    expect(cov?.complete).toBe(false);
    const all = await callTool("dead_code_audit", { org: fix.orgId });
    expect((all.data as { scan: analyze.ScanCoverage }).scan.complete).toBe(false);
    // Raise the limit: the same filtered question is now answered by a live scan to completion.
    analyze.scanLimits.maxNodesPerLabel = 5_000_000;
    const one = await callTool("dead_code_audit", { org: fix.orgId, pattern: "User" });
    const od = one.data as {
      dead: Array<{ qualifiedName: string }>;
      cached: boolean;
      scan: analyze.ScanCoverage;
    };
    expect(od.scan.complete).toBe(true);
    expect(od.dead.map((x) => x.qualifiedName)).toEqual(["ApexClass:User"]);
  });
});

// ---------------------------------------------------------------------------
// F06 and F07 through a real filesystem ingest of a small Apex project.
// ---------------------------------------------------------------------------

const logger = new ConsoleLogger("error");
const META = `<?xml version="1.0" encoding="UTF-8"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><status>Active</status></ApexClass>`;
const TRIGGER_META = `<?xml version="1.0" encoding="UTF-8"?><ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>60.0</apiVersion><status>Active</status></ApexTrigger>`;

const CLASSES: Record<string, string> = {
  PublicEndpoint: `@RestResource(urlMapping='/acme/*')
global with sharing class PublicEndpoint {
  @HttpGet
  global static String read() {
    return 'ok';
  }
}
`,
  NightlyJob: `global class NightlyJob implements Schedulable {
  global void execute(SchedulableContext sc) {
    Integer x = 1;
  }
}
`,
  LegacyHelper: `public class LegacyHelper {
  public static Integer twice(Integer n) {
    return n * 2;
  }
}
`,
  Queries: `public class Queries {
  public static List<Account> everything() {
    return [SELECT Id FROM Account];
  }
  public static List<Account> limited() {
    return [SELECT Id FROM Account LIMIT 10];
  }
  public static List<Account> byId(Id accountId) {
    return [SELECT Id FROM Account WHERE Id = :accountId];
  }
  public static Integer howMany() {
    return [SELECT COUNT() FROM Account];
  }
}
`,
};
const TRIGGERS: Record<string, string> = {
  OneAtATime: `trigger OneAtATime on Account (before insert) {
  Account a = Trigger.new[0];
  a.Name = 'x';
}
`,
  Bulkified: `trigger Bulkified on Account (before insert) {
  for (Account a : Trigger.new) {
    a.Name = 'x';
  }
}
`,
  Delegating: `trigger Delegating on Account (before insert) {
  Queries.limited();
}
`,
};

describe("F06 + F07 through a filesystem ingest", () => {
  let dir: string;
  let store: SqliteGraphStore;
  let ctx: ToolContext;
  let orgId: OrgId;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "sfg-complete-"));
    const proj = path.join(dir, "proj");
    const classes = path.join(proj, "force-app/main/default/classes");
    const triggers = path.join(proj, "force-app/main/default/triggers");
    mkdirSync(classes, { recursive: true });
    mkdirSync(triggers, { recursive: true });
    writeFileSync(
      path.join(proj, "sfdx-project.json"),
      JSON.stringify({ packageDirectories: [{ path: "force-app" }] }),
    );
    const old = new Date("2019-01-01T00:00:00Z");
    for (const [name, text] of Object.entries(CLASSES)) {
      writeFileSync(path.join(classes, `${name}.cls`), text);
      writeFileSync(path.join(classes, `${name}.cls-meta.xml`), META);
      utimesSync(path.join(classes, `${name}.cls`), old, old);
    }
    for (const [name, text] of Object.entries(TRIGGERS)) {
      writeFileSync(path.join(triggers, `${name}.trigger`), text);
      writeFileSync(path.join(triggers, `${name}.trigger-meta.xml`), TRIGGER_META);
    }
    const dbPath = path.join(dir, "g.sqlite");
    store = new SqliteGraphStore({ dbPath, backupDir: path.join(dir, "bk") });
    await store.init();
    const snapshotStore = new SqliteSnapshotStore({
      dbPath,
      db: (store as unknown as { db: never }).db,
      skipMigrations: true,
    });
    await snapshotStore.init();
    orgId = offlineResolvedOrg(proj, "fixture").orgId as OrgId;
    await liveIngest({
      alias: "fixture",
      graphStore: store,
      mode: "full",
      rebuild: true,
      preResolved: offlineResolvedOrg(proj, "fixture"),
      metadataSource: FilesystemMetadataSource.fromProjectRoot(proj),
      logger,
      skipSnapshot: true,
      analysisDb: store.db,
    });
    ctx = { graphStore: store, snapshotStore, orgId };
    setToolContextFactory(async () => ctx);
    process.env.SFGRAPH_EXPORTS_DIR = path.join(dir, "exports");
  });

  afterEach(async () => {
    setToolContextFactory(null);
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  const useCache = (on: boolean): void => {
    (ctx as { db?: unknown }).db = on ? store.db : undefined;
  };

  for (const cache of [false, true]) {
    describe(cache ? "with the cache populated" : "without the cache", () => {
      beforeEach(() => useCache(cache));

      it("F06: a REST endpoint and a scheduled job are external entry points, not high-confidence dead code", async () => {
        const r = await callTool("dead_code_audit", { org: "fixture" });
        const d = r.data as {
          cached: boolean;
          dead: Array<{ qualifiedName: string; confidence: string }>;
          externalEntryPoints: Array<{
            qualifiedName: string;
            kinds: string[];
            confidence: string;
            score: number;
            reasons: string[];
          }>;
        };
        expect(d.cached).toBe(cache);
        const ep = new Map(d.externalEntryPoints.map((e) => [e.qualifiedName, e]));
        expect(ep.get("ApexClass:PublicEndpoint")?.kinds).toEqual(
          expect.arrayContaining(["rest_resource", "global"]),
        );
        expect(ep.get("ApexClass:NightlyJob")?.kinds).toEqual(
          expect.arrayContaining(["schedulable", "global"]),
        );
        // Old (2019) code: age alone would be high confidence. Entry points stay low; the age signal is kept.
        for (const e of ep.values()) {
          expect(e.confidence).toBe("low");
          expect(e.reasons).toContain("stale_freshness");
          expect(e.score).toBeLessThan(0.2);
        }
        const dead = d.dead.map((x) => x.qualifiedName);
        expect(dead).toContain("ApexClass:LegacyHelper");
        expect(dead).not.toContain("ApexClass:PublicEndpoint");
        expect(dead).not.toContain("ApexClass:NightlyJob");
        // A plain unreferenced old class keeps age-based high confidence.
        expect(d.dead.find((x) => x.qualifiedName === "ApexClass:LegacyHelper")?.confidence).toBe(
          "high",
        );
      });

      it("F06: the text says 'no captured incoming references' and never claims nothing uses it", async () => {
        const r = await callTool("dead_code_audit", { org: "fixture" });
        const text = `${r.summary}\n${r.markdown}`;
        expect(text).toContain("no captured incoming references");
        expect(text).toContain("Callers outside the graph");
        expect(text).toContain("Known external entry points");
        expect(text).toContain("PublicEndpoint");
        expect(text).not.toMatch(
          /Code nothing uses|confirm nothing uses|nothing else in the org|looks? unused/i,
        );
        expect(r.markdown.startsWith("## Code with no captured incoming references")).toBe(true);
      });

      it("F06: SARIF marks the entry points and carries the external-caller caveat", async () => {
        const s = await callTool("export_sarif", { org: "fixture", audits: ["dead-code"] });
        const run = (s.data as { report: Sarif }).report.runs[0];
        const byName = (n: string) =>
          run?.results.find((x) => x.message.text.startsWith(`ApexClass:${n}:`));
        expect(byName("PublicEndpoint")?.properties?.externalEntryPoint).toBe(true);
        expect(byName("PublicEndpoint")?.message.text).toContain("known external entry point");
        expect(byName("LegacyHelper")?.properties?.externalEntryPoint).toBe(false);
        for (const res of run?.results ?? []) {
          expect(res.message.text).toContain("Callers outside the graph");
          expect(res.message.text).not.toMatch(/no incoming references\b(?! )/);
        }
      });

      it("F07: unbounded_query fires on a normally parsed query with no LIMIT and no WHERE, and only there", async () => {
        const r = await callTool("governor_risk_check", { org: "fixture", min_severity: "low" });
        const risks = (
          r.data as { risks: Array<{ qualifiedName: string; risk: string; evidence: string }> }
        ).risks;
        const unb = risks.filter((x) => x.risk === "unbounded_query");
        expect(unb.map((x) => x.qualifiedName)).toEqual(["ApexMethod:Queries.everything(0)"]);
        expect(unb[0]?.evidence).toBe("[SELECT Id FROM Account]");
      });

      it("F07: no_bulk fires on the trigger that reads Trigger.new[0] without a loop, and only there", async () => {
        const r = await callTool("governor_risk_check", { org: "fixture" });
        const nb = (
          r.data as { risks: Array<{ qualifiedName: string; risk: string }> }
        ).risks.filter((x) => x.risk === "no_bulk");
        expect(nb.map((x) => x.qualifiedName)).toEqual(["ApexTrigger:OneAtATime"]);
      });

      it("F07: the SARIF governor results include both rules", async () => {
        const s = await callTool("export_sarif", { org: "fixture", audits: ["governor"] });
        const res = (s.data as { report: Sarif }).report.runs[0]?.results ?? [];
        expect(res.filter((x) => x.ruleId === "governor.unbounded-query")).toHaveLength(1);
        expect(res.filter((x) => x.ruleId === "governor.no-bulk")).toHaveLength(1);
      });
    });
  }

  it("F07: the cache table holds the same two risks (one shared detector)", () => {
    const rows = store.db
      .prepare(
        "SELECT qualified_name AS q, risk_type AS t FROM _sfgraph_governor_risks WHERE risk_type IN ('unbounded_query','no_bulk') ORDER BY t, q",
      )
      .all() as Array<{ q: string; t: string }>;
    expect(rows).toEqual([
      { q: "ApexTrigger:OneAtATime", t: "no_bulk" },
      { q: "ApexMethod:Queries.everything(0)", t: "unbounded_query" },
    ]);
  });
});
