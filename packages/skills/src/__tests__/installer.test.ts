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
  it("installs all 17 skills to the claude target", async () => {
    const results = await install("claude", { homeOverride: home });
    const skillNames = await listSkillsBundled();
    expect(skillNames.length).toBe(17);
    expect(results.length).toBe(17);
    for (const r of results) {
      expect(r.target).toBe("claude");
      expect(r.action).toBe("created");
      expect(existsSync(r.path)).toBe(true);
      expect(r.path).toContain(join(home, ".claude", "skills"));
      expect(r.path.endsWith("SKILL.md")).toBe(true);
    }
  });

  it("installs to the cursor target as .mdc files in Cursor's frontmatter shape", async () => {
    const results = await install("cursor", { homeOverride: home });
    expect(results.length).toBe(17);
    const cursorDir = join(home, ".cursor", "rules");
    const files = readdirSync(cursorDir);
    expect(files.every((f) => f.endsWith(".mdc"))).toBe(true);
    expect(files.length).toBe(17);
    // Cursor-shaped frontmatter (the three keys Cursor's rule loader reads).
    const sample = readFileSync(join(cursorDir, files[0] ?? ""), "utf8");
    expect(sample).toMatch(/^description:/m);
    expect(sample).toMatch(/^globs:.*\*\*\/\*\.cls/m);
    expect(sample).toMatch(/^alwaysApply:\s*false$/m);
    // Old frontmatter is rewritten away (would confuse Cursor's parser).
    expect(sample).not.toMatch(/^name:/m);
    expect(sample).not.toMatch(/^triggers:/m);
    expect(sample).not.toMatch(/^tools_used:/m);
    // Body content preserved.
    expect(sample).toMatch(/## Playbook/);
  });

  it("installs to all targets in one call", async () => {
    const results = await install("all", { homeOverride: home });
    const claudeCount = results.filter((r) => r.target === "claude").length;
    const cursorCount = results.filter((r) => r.target === "cursor").length;
    const vscodeCount = results.filter((r) => r.target === "vscode").length;
    expect(claudeCount).toBe(17);
    expect(cursorCount).toBe(17);
    expect(vscodeCount).toBe(17);
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
