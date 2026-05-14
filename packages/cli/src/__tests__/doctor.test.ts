import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctorChecks } from "../commands/doctor.js";

let home: string;
let dataDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sfgraph-doctor-home-"));
  dataDir = mkdtempSync(join(tmpdir(), "sfgraph-doctor-data-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("runDoctorChecks", () => {
  it("flags ABI mismatch as a hard fail with a rebuild hint", () => {
    const requireFn = () => {
      throw new Error(
        "NODE_MODULE_VERSION 137 mismatch — was compiled against a different Node.js version",
      );
    };
    const report = runDoctorChecks({
      dataDir,
      homeOverride: home,
      requireFn,
      sfProbe: () => ({ ok: true, detail: "@salesforce/cli 2.0.0" }),
    });
    const binding = report.checks.find((c) => c.name === "better-sqlite3 native binding");
    expect(binding?.status).toBe("fail");
    expect(binding?.fix).toMatch(/rebuild better-sqlite3/);
    expect(report.ok).toBe(false);
  });

  it("reports all-green when the environment is healthy and no orgs are ingested yet", () => {
    const requireFn = () => ({
      /* mock Database ctor never used because no .sqlite files */
    });
    const report = runDoctorChecks({
      dataDir,
      homeOverride: home,
      requireFn,
      sfProbe: () => ({ ok: true, detail: "@salesforce/cli 2.0.0" }),
    });
    expect(report.ok).toBe(true);
    // No org DBs yet → warn (still ok overall)
    const orgs = report.checks.find((c) => c.name === "org databases");
    expect(orgs?.status).toBe("warn");
    const node = report.checks.find((c) => c.name === "node runtime");
    expect(node?.detail).toContain(process.version);
  });

  it("emits a warn (not fail) when no IDE MCP configs are present yet", () => {
    const requireFn = () => ({});
    const report = runDoctorChecks({
      dataDir,
      homeOverride: home,
      requireFn,
      sfProbe: () => ({ ok: false, detail: "not found" }),
    });
    const mcp = report.checks.find((c) => c.name === "IDE MCP configs");
    expect(mcp?.status).toBe("warn");
    expect(mcp?.fix).toMatch(/sfgraph install/);
    // sf CLI missing is warn, not fail
    expect(report.ok).toBe(true);
  });
});
