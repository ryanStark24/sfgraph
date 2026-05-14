import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export type McpTarget = "claude" | "cursor" | "vscode";

export interface McpWriteResult {
  target: McpTarget;
  path: string;
  action: "created" | "updated" | "skipped" | "would-write";
}

export interface McpWriteOptions {
  dryRun?: boolean;
  homeOverride?: string;
  /** Override the OS platform for testing. Accepts node's platform() values. */
  platformOverride?: NodeJS.Platform;
  /** When set, write an MCP entry that invokes the local binary at this
   *  absolute path instead of `npx @ryanstark24/sfgraph-mcp`. Used during
   *  local development before the package is published to npm. */
  localBinPath?: string;
  /** Absolute path to a Node binary. When set together with `localBinPath`,
   *  the MCP entry's `command` is this path instead of bare `"node"`. Use to
   *  pin the MCP server to a specific Node ABI so IDE-spawned children don't
   *  end up with a different ABI than the better-sqlite3 binding was built
   *  against. */
  pinNode?: string;
}

interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfigShape {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/** MCP server invocation. On Windows, `npx` is `npx.cmd`; spawned tools that
 *  receive `command: 'npx'` literally will ENOENT. We emit the platform-correct
 *  binary so the same `sfgraph install` produces a working config on macOS,
 *  Linux, and Windows.
 *
 *  When `localBinPath` is set (local-dev mode), invoke the local build via
 *  `node <absPath> mcp` — no PATH dependency, no published npm package
 *  required. */
function sfgraphEntryFor(
  plat: NodeJS.Platform,
  localBinPath?: string,
  pinNode?: string,
): McpServerEntry {
  if (localBinPath) {
    return { command: pinNode ?? "node", args: [localBinPath, "mcp"] };
  }
  if (plat === "win32") {
    return { command: "npx.cmd", args: ["-y", "@ryanstark24/sfgraph-mcp"] };
  }
  return { command: "npx", args: ["-y", "@ryanstark24/sfgraph-mcp"] };
}

export function configPathFor(target: McpTarget, opts: McpWriteOptions = {}): string {
  const home = opts.homeOverride ?? homedir();
  const plat = opts.platformOverride ?? platform();
  switch (target) {
    case "claude": {
      // Claude Desktop config path is per-platform.
      if (plat === "darwin") {
        return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (plat === "win32") {
        return join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
      }
      // linux fallback
      return join(home, ".config", "Claude", "claude_desktop_config.json");
    }
    case "cursor":
      // Cursor uses ~/.cursor on every platform.
      return join(home, ".cursor", "mcp.json");
    case "vscode":
      // VS Code's User settings dir is per-platform.
      if (plat === "darwin") {
        return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
      }
      if (plat === "win32") {
        return join(home, "AppData", "Roaming", "Code", "User", "mcp.json");
      }
      return join(home, ".config", "Code", "User", "mcp.json");
  }
}

export async function writeMcpConfig(
  target: McpTarget,
  opts: McpWriteOptions = {},
): Promise<McpWriteResult> {
  const path = configPathFor(target, opts);
  const plat = opts.platformOverride ?? platform();
  const sfgraphEntry = sfgraphEntryFor(plat, opts.localBinPath, opts.pinNode);
  let existing: McpConfigShape = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(await readFile(path, "utf8")) as McpConfigShape;
    } catch {
      existing = {};
    }
  }
  const merged: McpConfigShape = { ...existing };
  const servers: Record<string, McpServerEntry> = { ...(merged.mcpServers ?? {}) };
  const before = servers.sfgraph;
  servers.sfgraph = sfgraphEntry;
  merged.mcpServers = servers;

  const nextJson = `${JSON.stringify(merged, null, 2)}\n`;

  let action: McpWriteResult["action"];
  if (opts.dryRun) {
    action = "would-write";
  } else if (existsSync(path)) {
    const prev = await readFile(path, "utf8");
    if (prev === nextJson && before && before.command === sfgraphEntry.command) {
      action = "skipped";
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, nextJson, "utf8");
      action = "updated";
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, nextJson, "utf8");
    action = "created";
  }
  return { target, path, action };
}
