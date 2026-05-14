import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPathFor, writeMcpConfig } from "../commands/_mcp-config.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sfgraph-mcp-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("writeMcpConfig", () => {
  it("creates a fresh config file with the sfgraph entry", async () => {
    const res = await writeMcpConfig("cursor", { homeOverride: home, platformOverride: "darwin" });
    expect(res.action).toBe("created");
    const path = configPathFor("cursor", { homeOverride: home });
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.sfgraph).toEqual({
      command: "npx",
      args: ["-y", "@ryanstark24/sfgraph-mcp"],
    });
  });

  it("emits npx.cmd on Windows so spawned process doesn't ENOENT", async () => {
    const res = await writeMcpConfig("cursor", { homeOverride: home, platformOverride: "win32" });
    expect(res.action).toBe("created");
    const path = configPathFor("cursor", { homeOverride: home });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.sfgraph).toEqual({
      command: "npx.cmd",
      args: ["-y", "@ryanstark24/sfgraph-mcp"],
    });
  });

  it("with localBinPath, invokes the local build directly via node", async () => {
    const res = await writeMcpConfig("cursor", {
      homeOverride: home,
      platformOverride: "darwin",
      localBinPath: "/abs/path/to/sfgraph.mjs",
    });
    expect(res.action).toBe("created");
    const path = configPathFor("cursor", { homeOverride: home });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.sfgraph).toEqual({
      command: "node",
      args: ["/abs/path/to/sfgraph.mjs", "mcp"],
    });
  });

  it("with pinNode + localBinPath, pins the command to the absolute Node path", async () => {
    const res = await writeMcpConfig("cursor", {
      homeOverride: home,
      platformOverride: "darwin",
      localBinPath: "/abs/path/to/sfgraph.mjs",
      pinNode: "/opt/cursor/bin/node-v24",
    });
    expect(res.action).toBe("created");
    const path = configPathFor("cursor", { homeOverride: home });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.sfgraph).toEqual({
      command: "/opt/cursor/bin/node-v24",
      args: ["/abs/path/to/sfgraph.mjs", "mcp"],
    });
  });

  it("merges with an existing config preserving other servers", async () => {
    const path = configPathFor("cursor", { homeOverride: home });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { other: { command: "node", args: ["other.js"] } },
        unrelated: { keep: true },
      }),
      "utf8",
    );
    const res = await writeMcpConfig("cursor", { homeOverride: home, platformOverride: "darwin" });
    expect(res.action).toBe("updated");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
    expect(parsed.mcpServers.sfgraph.command).toBe("npx");
    expect(parsed.unrelated).toEqual({ keep: true });
  });

  it("is idempotent — second write reports skipped", async () => {
    await writeMcpConfig("cursor", { homeOverride: home, platformOverride: "darwin" });
    const res2 = await writeMcpConfig("cursor", {
      homeOverride: home,
      platformOverride: "darwin",
    });
    expect(res2.action).toBe("skipped");
  });
});
