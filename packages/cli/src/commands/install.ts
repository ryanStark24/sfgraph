import { type SkillTarget, install as installSkills } from "@ryanstark24/sfgraph-skills";
import { type McpTarget, writeMcpConfig } from "./_mcp-config.js";

export interface InstallCmdOpts {
  target?: "claude" | "cursor" | "vscode" | "all";
  dryRun?: boolean;
  skillsOnly?: boolean;
  mcpOnly?: boolean;
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
      const res = await writeMcpConfig(t, sharedOpts);
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
