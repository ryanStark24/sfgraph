import { spawnSync } from "node:child_process";
import { constants, accessSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

/**
 * macOS-only: verify the better-sqlite3 binding's code signature is one
 * dyld will actually accept. The failure mode this catches is the
 * "linker-signed adhoc" stamp that the build toolchain emits — macOS 26+
 * rejects it with SIGKILL on dlopen, with no JS handler able to intercept.
 * The kill is silent; ingests die mid-run with no error message. This
 * check surfaces the issue *before* the next ingest hits it.
 */
function checkMacosCodesign(requireFn?: (id: string) => unknown): Omit<DoctorCheck, "name"> | null {
  if (process.platform !== "darwin") return null;
  const req = requireFn ?? defaultRequire();
  // Resolve the actual .node file path.
  let bindingPath: string | null = null;
  try {
    // The official entry point is index.js; the .node lives under build/Release.
    const entry = (req as unknown as { resolve: (id: string) => string }).resolve(
      "better-sqlite3",
    );
    // entry ≈ <pkg>/lib/index.js — walk up to <pkg> then into build/Release.
    const pkgRoot = path.resolve(path.dirname(entry), "..");
    const candidate = path.join(pkgRoot, "build", "Release", "better_sqlite3.node");
    if (existsSync(candidate)) bindingPath = candidate;
  } catch {
    /* unresolvable; skip */
  }
  if (!bindingPath) {
    return {
      status: "warn",
      detail: "couldn't locate better_sqlite3.node to verify code signature",
    };
  }
  const r = spawnSync("codesign", ["--verify", "--strict", bindingPath], {
    encoding: "utf8",
  });
  if (r.error) {
    return {
      status: "warn",
      detail: `codesign tool unavailable: ${r.error.message}`,
    };
  }
  if (r.status === 0) {
    // Verified. Also check it's not the brittle linker-signed adhoc stamp.
    const display = spawnSync("codesign", ["-dvv", bindingPath], { encoding: "utf8" });
    const out = (display.stderr || display.stdout || "").toString();
    if (/linker-signed/.test(out)) {
      return {
        status: "warn",
        detail:
          "binding has linker-signed adhoc stamp; macOS 26+ may SIGKILL on dlopen. Re-sign with ad-hoc.",
        fix: `codesign --force --sign - "${bindingPath}"`,
      };
    }
    // Secondary check: AMFI library-validation rejection. If Node has
    // Hardened Runtime + library validation enabled (the default for the
    // Node.js Foundation builds + nvm), it refuses to load ad-hoc-signed
    // bindings — even though `codesign --verify` says the binding itself
    // is fine. The symptom is a silent SIGKILL mid-ingest. Detect by
    // inspecting Node's own signing flags + entitlements (NOT the
    // binding's — those are unrelated).
    const nodeFlags = spawnSync("codesign", ["-dvv", process.execPath], { encoding: "utf8" });
    const nodeFlagsOut = (nodeFlags.stderr || nodeFlags.stdout || "").toString();
    const nodeEnts = spawnSync(
      "codesign",
      ["-d", "--entitlements", "-", "--xml", process.execPath],
      { encoding: "utf8" },
    );
    const entsOut = (nodeEnts.stdout || nodeEnts.stderr || "").toString();
    const hasLibValDisabled = /com\.apple\.security\.cs\.disable-library-validation/.test(entsOut);
    // Node binary has Hardened Runtime if its codesign flags include
    // `runtime` (the human-readable name) or 0x10000 (the bit). Foundation
    // / nvm builds always do.
    const isHardenedRuntime =
      /flags=0x[0-9a-f]*\(.*\bruntime\b/.test(nodeFlagsOut) ||
      /flags=0x10000\b/.test(nodeFlagsOut) ||
      /\bruntime\b/.test(nodeFlagsOut);
    if (isHardenedRuntime && !hasLibValDisabled) {
      const entitlementsPath = "/tmp/sfgraph-node-libval.plist";
      const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>`;
      return {
        status: "warn",
        detail: `Node has Hardened Runtime with library validation; AMFI will SIGKILL on ad-hoc-signed bindings mid-ingest (silent death, no error). Re-sign Node with disable-library-validation entitlement.`,
        fix: `cat > ${entitlementsPath} <<'EOF'\n${plistBody}\nEOF\ncodesign --force --sign - --entitlements ${entitlementsPath} ${process.execPath}`,
      };
    }
    return { status: "ok", detail: `code signature valid (${bindingPath})` };
  }
  return {
    status: "fail",
    detail: `codesign rejected binding: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`,
    fix: `codesign --force --sign - "${bindingPath}"`,
  };
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
      // Surface the full multi-line error message — better-sqlite3 ABI
      // mismatch errors put the salient detail on lines 2-4, and the
      // single-line truncation made every failure look identical even
      // when the root cause varied.
      const fullMsg = (e as Error).message.replace(/\n/g, "\n        ");
      failures.push(`${f}:\n        ${fullMsg}`);
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

function checkOrgSnapshot(dataDir: string): Omit<DoctorCheck, "name"> {
  const p = path.join(dataDir, "orgs-snapshot.json");
  if (!existsSync(p)) {
    return {
      status: "warn",
      detail:
        "missing — list_orgs in a sandboxed MCP child will show empty aliases / no default-org",
      fix: "Run `sfgraph refresh-orgs` (or `sfgraph install`) to capture sf state",
    };
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      recordedAt?: number;
      aliases?: Record<string, string>;
      authorizations?: Record<string, unknown>;
    };
    const orgCount = Object.keys(raw.authorizations ?? {}).length;
    if (orgCount === 0) {
      return {
        status: "warn",
        detail: "snapshot has 0 orgs — sf was probably not authenticated when install ran",
        fix: "Run `sf org login web --alias <X>` then `sfgraph refresh-orgs`",
      };
    }
    const ageMs = Date.now() - (raw.recordedAt ?? statSync(p).mtimeMs);
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    if (ageDays >= 7) {
      return {
        status: "warn",
        detail: `${orgCount} org${orgCount === 1 ? "" : "s"} snapshot, ${ageDays}d old`,
        fix: "Run `sfgraph refresh-orgs` to capture any sf-CLI changes",
      };
    }
    return {
      status: "ok",
      detail: `${orgCount} org${orgCount === 1 ? "" : "s"} snapshot, ${ageDays}d old`,
    };
  } catch (e) {
    return {
      status: "fail",
      detail: `unreadable: ${(e as Error).message}`,
      fix: "Run `sfgraph refresh-orgs` to regenerate",
    };
  }
}

export function runDoctorChecks(opts: DoctorOpts = {}): DoctorReport {
  const dataDir = opts.dataDir ?? getSfgraphPaths().data;
  const checks: DoctorCheck[] = [
    check("node runtime", checkNode),
    check("better-sqlite3 native binding", () => checkBetterSqlite3(opts.requireFn)),
  ];
  if (process.platform === "darwin") {
    const codesign = checkMacosCodesign(opts.requireFn);
    if (codesign) checks.push({ name: "macOS code-signing", ...codesign });
  }
  checks.push(
    check("sfgraph data dir", () => checkDataDir(dataDir)),
    check("org databases", () => checkOrgDatabases(dataDir, opts.requireFn)),
    check("org snapshot", () => checkOrgSnapshot(dataDir)),
    check("sf CLI", () => checkSfCli(opts.sfProbe)),
    check("IDE MCP configs", () => checkMcpConfigs(opts.homeOverride)),
  );
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
