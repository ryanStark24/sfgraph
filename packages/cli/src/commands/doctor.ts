import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { isAbiMismatch } from "@ryanstark24/sfgraph-core";
import { getSfgraphPaths } from "@ryanstark24/sfgraph-shared";
import { configPathFor } from "./_mcp-config.js";

export interface DoctorOpts {
  log?: (s: string) => void;
  /** Override the data dir used for the on-disk checks (tests). */
  dataDir?: string;
  /** Override home for resolving IDE MCP config paths (tests). */
  homeOverride?: string;
  /** Stub the `sf --version` check (tests). */
  sfProbe?: () => { ok: boolean; detail: string };
  /** Stub the require used to load better-sqlite3 (tests). */
  requireFn?: (id: string) => unknown;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** Optional copy-paste fix command shown to the user. */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

function check(name: string, fn: () => Omit<DoctorCheck, "name">): DoctorCheck {
  try {
    return { name, ...fn() };
  } catch (e) {
    return {
      name,
      status: "fail",
      detail: `unexpected error: ${(e as Error).message}`,
    };
  }
}

function checkNode(): Omit<DoctorCheck, "name"> {
  return {
    status: "ok",
    detail: `${process.version} (ABI ${process.versions.modules}); exec=${process.execPath}`,
  };
}

/** Resolve better-sqlite3 from any package that depends on it (core/mcp-server),
 *  not just the CLI's own node_modules. Packaged distribution sees it hoisted
 *  alongside `@ryanstark24/sfgraph-server`, so resolve via that package's path. */
function defaultRequire(): (id: string) => unknown {
  // Resolve through a sibling package (@ryanstark24/sfgraph-server) that
  // depends on better-sqlite3, so the doctor works whether or not the CLI's
  // own node_modules has the binding hoisted into it.
  const here = createRequire(import.meta.url);
  try {
    const serverEntry = here.resolve("@ryanstark24/sfgraph-server");
    return createRequire(serverEntry) as unknown as (id: string) => unknown;
  } catch {
    return here as unknown as (id: string) => unknown;
  }
}

function checkBetterSqlite3(requireFn?: (id: string) => unknown): Omit<DoctorCheck, "name"> {
  const req = requireFn ?? defaultRequire();
  try {
    req("better-sqlite3");
    return { status: "ok", detail: "loads cleanly" };
  } catch (e) {
    const msg = (e as Error).message;
    if (isAbiMismatch(msg)) {
      return {
        status: "fail",
        detail: `ABI mismatch — binding compiled for a different Node ABI (running ABI ${process.versions.modules})`,
        fix: "npm rebuild better-sqlite3   # or: pnpm rebuild better-sqlite3",
      };
    }
    return {
      status: "fail",
      detail: `failed to load: ${msg.split("\n")[0]}`,
      fix: "npm install --force better-sqlite3",
    };
  }
}

function checkDataDir(dataDir: string): Omit<DoctorCheck, "name"> {
  if (!existsSync(dataDir)) {
    return {
      status: "warn",
      detail: `${dataDir} does not exist (will be created on first ingest)`,
    };
  }
  try {
    accessSync(dataDir, constants.W_OK);
    return { status: "ok", detail: `${dataDir} (writable)` };
  } catch {
    return {
      status: "fail",
      detail: `${dataDir} exists but is not writable`,
      fix: `chmod u+w "${dataDir}"`,
    };
  }
}

function checkOrgDatabases(
  dataDir: string,
  requireFn?: (id: string) => unknown,
): Omit<DoctorCheck, "name"> {
  if (!existsSync(dataDir)) {
    return { status: "warn", detail: "no data dir yet — run `sfgraph ingest --org <alias>`" };
  }
  let files: string[] = [];
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith(".sqlite") && !f.startsWith("backups"));
  } catch {
    return { status: "warn", detail: "cannot read data dir" };
  }
  if (files.length === 0) {
    return { status: "warn", detail: "no <orgId>.sqlite files yet" };
  }
  const req = requireFn ?? defaultRequire();
  let Ctor: unknown;
  try {
    Ctor = req("better-sqlite3");
  } catch (e) {
    return {
      status: "fail",
      detail: `cannot load better-sqlite3 to verify org DBs: ${(e as Error).message.split("\n")[0]}`,
    };
  }
  const Ctor2 = Ctor as new (
    p: string,
    o?: unknown,
  ) => { prepare: (s: string) => { get: () => unknown }; close: () => void };
  const failures: string[] = [];
  for (const f of files) {
    const dbPath = path.join(dataDir, f);
    try {
      const db = new Ctor2(dbPath, { readonly: true, fileMustExist: true });
      try {
        // _sfgraph_schema_version is created by the migration runner on first init
        db.prepare("SELECT version FROM _sfgraph_schema_version LIMIT 1").get();
      } finally {
        db.close();
      }
    } catch (e) {
      failures.push(`${f}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  if (failures.length > 0) {
    return {
      status: "fail",
      detail: `${failures.length} of ${files.length} org DBs failed to open:\n      ${failures.join("\n      ")}`,
      fix: "Re-ingest the failing org(s): sfgraph ingest --org <alias> --rebuild",
    };
  }
  return { status: "ok", detail: `${files.length} org DB(s) open with expected schema` };
}

function checkSfCli(sfProbe?: DoctorOpts["sfProbe"]): Omit<DoctorCheck, "name"> {
  if (sfProbe) {
    const r = sfProbe();
    return r.ok
      ? { status: "ok", detail: r.detail }
      : { status: "warn", detail: r.detail, fix: "install: npm i -g @salesforce/cli" };
  }
  const r = spawnSync(process.platform === "win32" ? "sf.cmd" : "sf", ["--version"], {
    encoding: "utf8",
  });
  if (r.error || r.status !== 0) {
    return {
      status: "warn",
      detail: "`sf` CLI not found on PATH (only required for `sfgraph ingest`)",
      fix: "npm i -g @salesforce/cli",
    };
  }
  return { status: "ok", detail: (r.stdout || "").trim().split("\n")[0] ?? "found" };
}

function checkMcpConfigs(homeOverride?: string): Omit<DoctorCheck, "name"> {
  const targets: Array<"claude" | "cursor" | "vscode"> = ["claude", "cursor", "vscode"];
  const found: string[] = [];
  const missing: string[] = [];
  for (const t of targets) {
    const opts = homeOverride ? { homeOverride } : {};
    const p = configPathFor(t, opts);
    if (existsSync(p)) found.push(`${t}: ${p}`);
    else missing.push(t);
  }
  if (found.length === 0) {
    return {
      status: "warn",
      detail: "no IDE MCP configs detected",
      fix: "sfgraph install --target cursor   # or claude / vscode / all",
    };
  }
  const detail =
    found.join(", ") + (missing.length > 0 ? ` (not configured: ${missing.join(", ")})` : "");
  return { status: "ok", detail };
}

export function runDoctorChecks(opts: DoctorOpts = {}): DoctorReport {
  const dataDir = opts.dataDir ?? getSfgraphPaths().data;
  const checks: DoctorCheck[] = [
    check("node runtime", checkNode),
    check("better-sqlite3 native binding", () => checkBetterSqlite3(opts.requireFn)),
    check("sfgraph data dir", () => checkDataDir(dataDir)),
    check("org databases", () => checkOrgDatabases(dataDir, opts.requireFn)),
    check("sf CLI", () => checkSfCli(opts.sfProbe)),
    check("IDE MCP configs", () => checkMcpConfigs(opts.homeOverride)),
  ];
  const ok = checks.every((c) => c.status !== "fail");
  return { checks, ok };
}

const ICON: Record<DoctorCheck["status"], string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

export async function doctorCmd(opts: DoctorOpts = {}): Promise<DoctorReport> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const report = runDoctorChecks(opts);
  log("sfgraph doctor");
  log("");
  for (const c of report.checks) {
    log(`  ${ICON[c.status]} ${c.name}: ${c.detail}`);
    if (c.fix) log(`      fix: ${c.fix}`);
  }
  log("");
  log(report.ok ? "All checks passed." : "One or more checks failed — see fix hints above.");
  if (!report.ok) process.exitCode = 1;
  return report;
}
