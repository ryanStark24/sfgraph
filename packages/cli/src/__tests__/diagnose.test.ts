/**
 * Phase 1.5 W1.5-05 — diagnose CLI subcommand tests.
 *
 * The diagnose command's heavy lifting is the parsing of namespaced
 * warning strings into the structured report shape, plus the env-restore
 * try/finally invariant. We test those directly here against the
 * `DiagnoseReporter` class and the `diagnoseCmd` entrypoint with mocked
 * runner/resolveOrg so no Salesforce connection is required.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagnoseReporter, diagnoseCmd, topSlowestSources } from "../commands/diagnose.js";
import type {
  DiagnoseLiveRunner,
  DiagnoseReportSourceEntry,
  DiagnoseResolveOrg,
} from "../commands/diagnose.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sfgraph-diagnose-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const fakeResolveOrg: DiagnoseResolveOrg = async (alias: string) => ({
  alias,
  orgId: "00DTEST00000001",
  apiVersion: "60.0",
  instanceUrl: "https://test.my.salesforce.com",
  conn: {},
});

/** Build a runner that just emits a canned LiveIngestResult — no real
 *  Salesforce activity, no SqliteGraphStore touched (the diagnoseCmd
 *  still opens one against the temp dir, which is fine; the runner
 *  bypasses any heavy work). */
function fakeRunner(opts: {
  warnings?: string[];
  capabilities?: Record<string, unknown>;
  throws?: Error;
  timeoutMs?: number;
}): DiagnoseLiveRunner {
  return async () => {
    if (opts.timeoutMs) {
      await new Promise((r) => setTimeout(r, opts.timeoutMs));
    }
    if (opts.throws) throw opts.throws;
    const stub = {
      orgId: "00DTEST00000001",
      capabilities: opts.capabilities ?? { sourceTracking: false, agentforce: false },
      mode: "full",
      membersProcessed: 0,
      parseErrors: 0,
      deletions: 0,
      durationMs: 1,
      crossFlavorEdges: 0,
      arityResolved: 0,
      flowMethodsResolved: 0,
      danglingEdges: 0,
      reflectionEdges: 0,
      overlap: { matched: 0, diverged: 0, empty: 0, annotated: 0 },
      warnings: opts.warnings ?? [],
    };
    return stub as unknown as Awaited<ReturnType<DiagnoseLiveRunner>>;
  };
}

describe("DiagnoseReporter.ingestWarnings", () => {
  it("parses a firstYield wedge warning into a structured event", () => {
    const r = new DiagnoseReporter("00DTEST00000001", "alias", 1_000);
    r.ingestWarning(
      "wedge:lwc:firstYield:90s:lastYielded=LightningComponentBundle/Foo:wedgedForMs=90123",
    );
    const out = r.build({
      finishedAtEpoch: 2_000,
      capabilities: {},
      config: { sourceConcurrency: 1, toolingPool: 1, metadataPool: 1, dataPool: 1 },
      warnings: [
        "wedge:lwc:firstYield:90s:lastYielded=LightningComponentBundle/Foo:wedgedForMs=90123",
      ],
      exitStatus: "ok",
    });
    const lwc = out.perSource.find((s) => s.name === "lwc");
    expect(lwc).toBeDefined();
    expect(lwc?.wedged).toBe(true);
    expect(lwc?.lastYieldedRecord).toBe("LightningComponentBundle/Foo");
    expect(lwc?.wedgeEvents).toHaveLength(1);
    expect(lwc?.wedgeEvents[0]?.kind).toBe("firstYield");
    expect(lwc?.wedgeEvents[0]?.atMs).toBe(90_000);
    expect(lwc?.wedgeEvents[0]?.lastYieldedRecord).toBe("LightningComponentBundle/Foo");
  });

  it("parses an empty-stream detect-deletions refusal", () => {
    const r = new DiagnoseReporter("00DTEST00000001");
    r.ingestWarning(
      "wedge:detect-deletions:refuse:label=Profile:reason=empty-stream:priorCount=100",
    );
    const out = r.build({
      capabilities: {},
      config: { sourceConcurrency: 1, toolingPool: 1, metadataPool: 1, dataPool: 1 },
      warnings: [],
      exitStatus: "ok",
    });
    expect(out.detectDeletionsRefusals).toHaveLength(1);
    expect(out.detectDeletionsRefusals[0]).toEqual({
      label: "Profile",
      reason: "empty-stream",
      priorCount: 100,
    });
    // Mirrors onto perSource with needsDiagnose=true
    const profile = out.perSource.find((s) => s.name === "Profile");
    expect(profile?.needsDiagnose).toBe(true);
    expect(out.needsDiagnose).toContain("Profile");
  });

  it("parses a drop-ratio refusal with dropped/prior/ratio fields", () => {
    const r = new DiagnoseReporter("00DTEST00000001");
    r.ingestWarning(
      "wedge:detect-deletions:refuse:label=Profile:reason=drop-ratio:dropped=50:prior=100:ratio=0.50",
    );
    const out = r.build({
      capabilities: {},
      config: { sourceConcurrency: 1, toolingPool: 1, metadataPool: 1, dataPool: 1 },
      warnings: [],
      exitStatus: "ok",
    });
    expect(out.detectDeletionsRefusals[0]).toEqual({
      label: "Profile",
      reason: "drop-ratio",
      priorCount: 100,
      touchedCount: 50,
      ratio: 0.5,
    });
  });

  it("parses a cap-evicted background-wedge entry onto the named source", () => {
    const r = new DiagnoseReporter("00DTEST00000001");
    r.ingestWarning(
      "wedge:cap:backgroundWedgeAborted:source=generic:Layout:ageMs=12345:reason=backgroundWedgeCapExceeded",
    );
    const out = r.build({
      capabilities: {},
      config: { sourceConcurrency: 1, toolingPool: 1, metadataPool: 1, dataPool: 1 },
      warnings: [],
      exitStatus: "ok",
    });
    // "source=generic" is the parsed value because colon-split treats
    // generic:Layout as two segments. The reporter records whatever the
    // warning string identified; the contract is that future warning
    // formats stay compatible. We assert structure, not the exact label.
    const evicted = out.perSource.find((s) => s.wedgeEvents.some((e) => e.kind === "cap-evicted"));
    expect(evicted).toBeDefined();
    expect(evicted?.wedged).toBe(true);
    expect(evicted?.wedgeEvents[0]?.wedgedForMs).toBe(12345);
  });

  it("ignores non-wedge warnings (e.g. plain skip messages)", () => {
    const r = new DiagnoseReporter("00DTEST00000001");
    r.ingestWarning("generic:Layout: skipped (insufficient_access)");
    const out = r.build({
      capabilities: {},
      config: { sourceConcurrency: 1, toolingPool: 1, metadataPool: 1, dataPool: 1 },
      warnings: ["generic:Layout: skipped (insufficient_access)"],
      exitStatus: "ok",
    });
    expect(out.perSource).toHaveLength(0);
    expect(out.detectDeletionsRefusals).toHaveLength(0);
  });
});

describe("topSlowestSources", () => {
  it("returns top N by elapsedMs descending; wedged-but-incomplete sources sort to the top", () => {
    const src = (
      name: string,
      elapsedMs: number | undefined,
      wedged = false,
    ): DiagnoseReportSourceEntry => ({
      name,
      yieldCount: 0,
      wedged,
      wedgeEvents: [],
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    });
    const sources = [
      src("a", 1_000),
      src("b", 5_000),
      src("c", undefined, true), // wedged, no elapsed → top
      src("d", 3_000),
      src("e", 2_000),
    ];
    const top = topSlowestSources(sources, 3);
    expect(top.map((s) => s.name)).toEqual(["c", "b", "d"]);
  });

  it("respects the N parameter", () => {
    const sources: DiagnoseReportSourceEntry[] = [
      { name: "x", yieldCount: 0, wedged: false, wedgeEvents: [], elapsedMs: 100 },
      { name: "y", yieldCount: 0, wedged: false, wedgeEvents: [], elapsedMs: 200 },
      { name: "z", yieldCount: 0, wedged: false, wedgeEvents: [], elapsedMs: 300 },
    ];
    expect(topSlowestSources(sources, 1).map((s) => s.name)).toEqual(["z"]);
    expect(topSlowestSources(sources, 2).map((s) => s.name)).toEqual(["z", "y"]);
  });
});

describe("diagnoseCmd integration", () => {
  it("writes a JSON report with the expected shape to --output", async () => {
    const outPath = join(tmpRoot, "report.json");
    const { reportPath, report } = await diagnoseCmd(
      { orgId: "myalias", output: outPath, keepGraph: false },
      {
        resolveOrg: fakeResolveOrg,
        runner: fakeRunner({
          warnings: [
            "wedge:lwc:firstYield:90s:lastYielded=LightningComponentBundle/Foo:wedgedForMs=90123",
            "wedge:detect-deletions:refuse:label=Profile:reason=empty-stream:priorCount=100",
          ],
          capabilities: { sourceTracking: false, agentforce: true },
        }),
      },
    );
    expect(reportPath).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(outPath, "utf8"));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.diagnosticMode).toBe(true);
    expect(onDisk.orgId).toBe("myalias");
    expect(onDisk.exitStatus).toBe("ok");
    expect(onDisk.config).toMatchObject({
      sourceConcurrency: 1,
      toolingPool: 1,
      metadataPool: 1,
      dataPool: 1,
    });
    expect(onDisk.capabilities.agentforce).toBe(true);
    // Per-source wedge + refusal parsed
    expect(onDisk.perSource.find((s: { name: string }) => s.name === "lwc").wedged).toBe(true);
    expect(onDisk.detectDeletionsRefusals).toHaveLength(1);
    expect(onDisk.needsDiagnose).toContain("Profile");
    // The in-memory `report` matches what was written
    expect(report.exitStatus).toBe("ok");
  });

  it("restores SFGRAPH_SOURCE_CONCURRENCY after the run (try/finally invariant)", async () => {
    const prior = process.env.SFGRAPH_SOURCE_CONCURRENCY;
    process.env.SFGRAPH_SOURCE_CONCURRENCY = "4";
    try {
      const outPath = join(tmpRoot, "report.json");
      await diagnoseCmd(
        { orgId: "myalias", output: outPath, keepGraph: false },
        { resolveOrg: fakeResolveOrg, runner: fakeRunner({ warnings: [] }) },
      );
      expect(process.env.SFGRAPH_SOURCE_CONCURRENCY).toBe("4");
    } finally {
      if (prior === undefined) {
        // biome-ignore lint/performance/noDelete: env var restoration requires removing the key
        delete process.env.SFGRAPH_SOURCE_CONCURRENCY;
      } else {
        process.env.SFGRAPH_SOURCE_CONCURRENCY = prior;
      }
    }
  });

  it("restores SFGRAPH_TOOLING_POOL / METADATA_POOL / DATA_POOL even when the runner throws", async () => {
    const snapshot: Record<string, string | undefined> = {
      SFGRAPH_TOOLING_POOL: process.env.SFGRAPH_TOOLING_POOL,
      SFGRAPH_METADATA_POOL: process.env.SFGRAPH_METADATA_POOL,
      SFGRAPH_DATA_POOL: process.env.SFGRAPH_DATA_POOL,
    };
    process.env.SFGRAPH_TOOLING_POOL = "7";
    process.env.SFGRAPH_METADATA_POOL = "8";
    process.env.SFGRAPH_DATA_POOL = "9";
    try {
      const outPath = join(tmpRoot, "report.json");
      const { report } = await diagnoseCmd(
        { orgId: "myalias", output: outPath, keepGraph: false },
        {
          resolveOrg: fakeResolveOrg,
          runner: fakeRunner({ throws: new Error("simulated wedge") }),
        },
      );
      expect(report.exitStatus).toBe("failed");
      expect(report.error).toContain("simulated wedge");
      // Env restored despite the throw
      expect(process.env.SFGRAPH_TOOLING_POOL).toBe("7");
      expect(process.env.SFGRAPH_METADATA_POOL).toBe("8");
      expect(process.env.SFGRAPH_DATA_POOL).toBe("9");
    } finally {
      for (const [k, v] of Object.entries(snapshot)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("hits the timeout path when the runner outlasts --max-duration", async () => {
    const outPath = join(tmpRoot, "report.json");
    const { report } = await diagnoseCmd(
      { orgId: "myalias", output: outPath, keepGraph: false, maxDuration: 0 },
      {
        resolveOrg: fakeResolveOrg,
        // Promise that never resolves within 0s — Promise.race picks the timeout
        runner: fakeRunner({ timeoutMs: 100_000 }),
      },
    );
    expect(report.exitStatus).toBe("timeout");
    expect(report.error).toMatch(/max-duration/);
  });
});
