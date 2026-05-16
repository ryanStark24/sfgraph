import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPathFor } from "../commands/_mcp-config.js";
import { installCmd } from "../commands/install.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sfgraph-e2e-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("installCmd e2e", () => {
  it("installs skills + MCP config for all targets", async () => {
    const rows = await installCmd({
      target: "all",
      homeOverride: home,
      log: () => {},
    });
    const skillRows = rows.filter((r) => r.kind === "skill");
    const mcpRows = rows.filter((r) => r.kind === "mcp");
    expect(skillRows.length).toBe(51); // 17 skills * 3 targets
    expect(mcpRows.length).toBe(3);
    expect(existsSync(join(home, ".claude", "skills"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "rules"))).toBe(true);
    // verify cursor mcp.json has sfgraph entry
    const cursorMcp = configPathFor("cursor", { homeOverride: home });
    const parsed = JSON.parse(readFileSync(cursorMcp, "utf8"));
    expect(parsed.mcpServers.sfgraph).toBeDefined();
  });
});
