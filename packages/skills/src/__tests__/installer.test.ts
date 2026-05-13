import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { install, listSkillsBundled } from "../installer.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sfgraph-home-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("skills installer", () => {
  it("installs all 10 skills to the claude target", async () => {
    const results = await install("claude", { homeOverride: home });
    const skillNames = await listSkillsBundled();
    expect(skillNames.length).toBe(10);
    expect(results.length).toBe(10);
    for (const r of results) {
      expect(r.target).toBe("claude");
      expect(r.action).toBe("created");
      expect(existsSync(r.path)).toBe(true);
      expect(r.path).toContain(join(home, ".claude", "skills"));
      expect(r.path.endsWith("SKILL.md")).toBe(true);
    }
  });

  it("installs to the cursor target as .mdc files with tools_used stripped", async () => {
    const results = await install("cursor", { homeOverride: home });
    expect(results.length).toBe(10);
    const cursorDir = join(home, ".cursor", "rules");
    const files = readdirSync(cursorDir);
    expect(files.every((f) => f.endsWith(".mdc"))).toBe(true);
    expect(files.length).toBe(10);
    // Spot-check: tools_used: block should not survive transform.
    const sample = readFileSync(join(cursorDir, files[0] ?? ""), "utf8");
    expect(sample).not.toMatch(/^tools_used:/m);
    // But the body and other frontmatter survive:
    expect(sample).toMatch(/^name:/m);
    expect(sample).toMatch(/## Playbook/);
  });

  it("installs to all targets in one call", async () => {
    const results = await install("all", { homeOverride: home });
    const claudeCount = results.filter((r) => r.target === "claude").length;
    const cursorCount = results.filter((r) => r.target === "cursor").length;
    const vscodeCount = results.filter((r) => r.target === "vscode").length;
    expect(claudeCount).toBe(10);
    expect(cursorCount).toBe(10);
    expect(vscodeCount).toBe(10);
    expect(existsSync(join(home, ".claude", "skills"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "rules"))).toBe(true);
  });

  it("dry-run returns would-write actions and writes nothing", async () => {
    const results = await install("all", { homeOverride: home, dryRun: true });
    expect(results.every((r) => r.action === "would-write")).toBe(true);
    expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(home, ".cursor", "rules"))).toBe(false);
  });
});
