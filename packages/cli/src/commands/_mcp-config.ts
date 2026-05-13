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
}

interface McpServerEntry {
  command: string;
  args: string[];
}

interface McpConfigShape {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

const SFGRAPH_ENTRY: McpServerEntry = {
  command: "npx",
  args: ["-y", "sfgraph"],
};

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
      return join(home, ".cursor", "mcp.json");
    case "vscode":
      return join(home, ".config", "Code", "User", "mcp.json");
  }
}

export async function writeMcpConfig(
  target: McpTarget,
  opts: McpWriteOptions = {},
): Promise<McpWriteResult> {
  const path = configPathFor(target, opts);
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
  servers.sfgraph = SFGRAPH_ENTRY;
  merged.mcpServers = servers;

  const nextJson = `${JSON.stringify(merged, null, 2)}\n`;

  let action: McpWriteResult["action"];
  if (opts.dryRun) {
    action = "would-write";
  } else if (existsSync(path)) {
    const prev = await readFile(path, "utf8");
    if (prev === nextJson && before && before.command === SFGRAPH_ENTRY.command) {
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
