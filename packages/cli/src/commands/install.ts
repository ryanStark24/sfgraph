import { type SkillTarget, install as installSkills } from "@ryanstark24/sfgraph-skills";
import { type McpTarget, writeMcpConfig } from "./_mcp-config.js";

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
  } = {
    ...sharedOpts,
  };
  if (localBinPath) mcpOpts.localBinPath = localBinPath;
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
