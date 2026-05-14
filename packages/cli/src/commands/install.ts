import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SkillTarget, install as installSkills } from "@ryanstark24/sfgraph-skills";
import { type McpTarget, writeMcpConfig } from "./_mcp-config.js";

/** Snapshot of `sf` CLI org state at install time. Written to
 *  `<dataDir>/orgs-snapshot.json`. list_orgs and other tools read this when
 *  StateAggregator returns empty (the sandboxed-IDE-child case). */
export interface OrgSnapshot {
  recordedAt: number;
  defaultAlias: string | null;
  /** alias -> username */
  aliases: Record<string, string>;
  /** username -> { orgId, instanceUrl } */
  authorizations: Record<string, { orgId: string; instanceUrl: string }>;
}

export const ORG_SNAPSHOT_FILENAME = "orgs-snapshot.json";

/** Exported so `sfgraph refresh-orgs` can call it directly without going
 *  through the rest of the install flow (MCP config writes, skill copies). */
export async function writeOrgSnapshot(dataDir: string): Promise<void> {
  // Run @salesforce/core in this process (NOT the MCP child) so it can
  // actually read ~/.sf/. Capture everything we need; the sandboxed child
  // will read from the JSON instead of from ~/.sf/.
  // @salesforce/core isn't a direct dep of the CLI package — resolve it
  // through a sibling (@ryanstark24/sfgraph-server) that lists it as a
  // direct dependency. Same pattern doctor.ts uses for better-sqlite3.
  const { createRequire } = await import("node:module");
  const here = createRequire(import.meta.url);
  let resolvedSfCorePath: string;
  try {
    const serverEntry = here.resolve("@ryanstark24/sfgraph-server");
    const sibling = createRequire(serverEntry);
    resolvedSfCorePath = sibling.resolve("@salesforce/core");
  } catch {
    // Fall back to direct resolve (might work in some hoisted layouts).
    resolvedSfCorePath = "@salesforce/core";
  }
  const sfCore = (await import(resolvedSfCorePath)) as unknown as {
    AuthInfo: {
      listAllAuthorizations: () => Promise<
        Array<{
          alias?: string | null;
          username?: string;
          orgId?: string;
          instanceUrl?: string;
        }>
      >;
    };
    StateAggregator?: {
      create: () => Promise<{ aliases: { getAll: () => Record<string, string> } }>;
    };
    ConfigAggregator?: {
      create: () => Promise<{ getInfo: (k: string) => { value?: unknown } | null }>;
    };
  };

  const auths = await sfCore.AuthInfo.listAllAuthorizations();
  const authorizations: Record<string, { orgId: string; instanceUrl: string }> = {};
  for (const a of auths) {
    if (!a.username) continue;
    authorizations[a.username] = {
      orgId: a.orgId ?? "",
      instanceUrl: a.instanceUrl ?? "",
    };
  }

  let aliases: Record<string, string> = {};
  try {
    if (sfCore.StateAggregator?.create) {
      const agg = await sfCore.StateAggregator.create();
      aliases = agg.aliases.getAll() ?? {};
    }
  } catch {
    /* aliases stay empty */
  }

  let defaultAlias: string | null = null;
  try {
    if (sfCore.ConfigAggregator?.create) {
      const cfg = await sfCore.ConfigAggregator.create();
      const v = (cfg.getInfo("target-org") ?? cfg.getInfo("defaultusername"))?.value;
      if (typeof v === "string" && v.length > 0) defaultAlias = v;
    }
  } catch {
    /* default stays null */
  }
  // Fallback: ConfigAggregator reads project-local config first which is
  // usually empty when we run from outside the user's sfdx project. Read
  // the GLOBAL config file directly so `sf config set target-org=foo`
  // (run from any project dir) still resolves.
  if (!defaultAlias) {
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { join } = await import("node:path");
      // Newer sf CLI: ~/.sf/config.json. Legacy sfdx: ~/.sfdx/sfdx-config.json.
      const candidates = [
        join(homedir(), ".sf", "config.json"),
        join(homedir(), ".sfdx", "sfdx-config.json"),
      ];
      for (const cfgPath of candidates) {
        if (!existsSync(cfgPath)) continue;
        const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
        const v = parsed["target-org"] ?? parsed.defaultusername;
        if (typeof v === "string" && v.length > 0) {
          defaultAlias = v;
          break;
        }
      }
    } catch {
      /* fallback failed; defaultAlias stays null */
    }
  }

  const snapshot: OrgSnapshot = {
    recordedAt: Date.now(),
    defaultAlias,
    aliases,
    authorizations,
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, ORG_SNAPSHOT_FILENAME), JSON.stringify(snapshot, null, 2), "utf8");
}

export interface InstallCmdOpts {
  target?: "claude" | "cursor" | "vscode" | "all";
  dryRun?: boolean;
  skillsOnly?: boolean;
  mcpOnly?: boolean;
  /** Write MCP entry that invokes the currently-running binary directly,
   *  instead of `npx @ryanstark24/sfgraph-mcp`. Use this for local dev
   *  before the package is published. */
  local?: boolean;
  /** Absolute path to a Node binary. With --local, the MCP entry's
   *  `command` is pinned to this Node so IDE-spawned children always use a
   *  Node ABI that matches the rebuilt better-sqlite3 binding. Defaults to
   *  `process.execPath` when `--local` is set without `--pin-node`. */
  pinNode?: string;
  homeOverride?: string;
  log?: (s: string) => void;
}

export interface InstallSummaryRow {
  target: string;
  kind: "skill" | "mcp";
  name: string;
  path: string;
  action: string;
}

export async function installCmd(opts: InstallCmdOpts = {}): Promise<InstallSummaryRow[]> {
  const target: SkillTarget = opts.target ?? "all";
  const log = opts.log ?? ((s: string) => console.log(s));
  const rows: InstallSummaryRow[] = [];

  const sharedOpts: { dryRun: boolean; homeOverride?: string } = {
    dryRun: opts.dryRun ?? false,
  };
  if (opts.homeOverride !== undefined) sharedOpts.homeOverride = opts.homeOverride;

  // Local-dev mode: derive the absolute path of THIS sfgraph binary so the
  // MCP entry invokes it directly. process.argv[1] is the script path that
  // Node received. Resolve to an absolute, normalized form.
  let localBinPath: string | undefined;
  if (opts.local) {
    const { realpathSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const candidate = process.argv[1] ?? "";
    if (!candidate) {
      throw new Error("install --local: cannot detect this binary's path from process.argv");
    }
    try {
      localBinPath = realpathSync(resolve(candidate));
    } catch {
      localBinPath = resolve(candidate);
    }
  }
  const mcpOpts: {
    dryRun: boolean;
    homeOverride?: string;
    localBinPath?: string;
    pinNode?: string;
    env?: Record<string, string>;
  } = {
    ...sharedOpts,
  };
  if (localBinPath) mcpOpts.localBinPath = localBinPath;
  // Always propagate the shell's resolved data/config/log dirs into the MCP
  // entry's env. This is the only way sandboxed IDE child processes (Cursor
  // on macOS, Claude Desktop) read from the same on-disk location the shell
  // wrote to. Without this, the child's env-paths resolver lands in a
  // different (often non-writable) location than the shell.
  const { getSfgraphPaths } = await import("@ryanstark24/sfgraph-shared");
  const shellPaths = getSfgraphPaths();
  mcpOpts.env = {
    SFGRAPH_DATA_DIR: shellPaths.data,
    SFGRAPH_CONFIG_DIR: shellPaths.config,
    SFGRAPH_CACHE_DIR: shellPaths.cache,
    SFGRAPH_LOG_DIR: shellPaths.log,
  };

  // Snapshot the sf-CLI alias map + default-org at install time. The
  // sandboxed MCP child on Cursor/Claude can't read ~/.sf/alias.json or
  // ~/.sf/config.json (filesystem permission), so StateAggregator and
  // ConfigAggregator return empty there. We capture both while running
  // outside the sandbox and persist to a JSON file under the data dir
  // (which is sandbox-readable thanks to SFGRAPH_DATA_DIR above).
  if (!opts.dryRun) {
    try {
      await writeOrgSnapshot(shellPaths.data);
    } catch (e) {
      // Best-effort: install shouldn't fail if sf isn't authenticated yet.
      log(
        `note: could not snapshot sf orgs (${(e as Error).message}); list_orgs in IDE may show empty aliases`,
      );
    }
  }
  // Resolve pinNode: explicit flag wins; otherwise default to process.execPath
  // when --local is set so the IDE child uses the same Node that ran install.
  if (opts.pinNode) {
    mcpOpts.pinNode = opts.pinNode;
  } else if (opts.local) {
    mcpOpts.pinNode = process.execPath;
  }

  if (!opts.mcpOnly) {
    const skillResults = await installSkills(target, sharedOpts);
    for (const r of skillResults) {
      rows.push({
        target: r.target,
        kind: "skill",
        name: r.skill,
        path: r.path,
        action: r.action,
      });
    }
  }

  if (!opts.skillsOnly) {
    const mcpTargets: McpTarget[] = target === "all" ? ["claude", "cursor", "vscode"] : [target];
    for (const t of mcpTargets) {
      const res = await writeMcpConfig(t, mcpOpts);
      rows.push({
        target: res.target,
        kind: "mcp",
        name: "sfgraph",
        path: res.path,
        action: res.action,
      });
    }
  }

  // Print summary table.
  const header = ["target", "kind", "name", "action", "path"];
  const widths = header.map((h) => h.length);
  const data = rows.map((r) => [r.target, r.kind, r.name, r.action, r.path]);
  for (const row of data) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? "";
      const w = widths[i] ?? cell.length;
      widths[i] = Math.max(w, cell.length);
    }
  }
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join("  ");
  log(pad(header));
  log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of data) {
    log(pad(row));
  }
  if (opts.dryRun) {
    log("");
    log("[dry-run] no files written");
  }
  return rows;
}
