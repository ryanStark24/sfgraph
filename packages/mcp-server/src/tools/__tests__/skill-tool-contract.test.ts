import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultRegistry } from "../index.js";

/**
 * Contract guard: every MCP tool a SKILL.md lists in `tools_used` must be a real
 * registered tool. This is the cheap CI check the re-audit asked for — it stops
 * skill/tool drift (a renamed/removed tool, or a typo'd reference) from shipping
 * silently. The skills live in a sibling package; resolved relative to this file.
 */
const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../skills/skills",
);

/** Pull the `tools_used:` list items out of a SKILL.md YAML frontmatter block. */
function parseToolsUsed(md: string): string[] {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const lines = fm[1]?.split("\n") ?? [];
  const out: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (/^tools_used:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      const m = line.match(/^\s+-\s+(.+?)\s*$/);
      if (m?.[1]) {
        out.push(m[1].replace(/^["']|["']$/g, ""));
      } else if (/^\S/.test(line)) {
        break; // next top-level key ends the block
      }
    }
  }
  return out;
}

describe("SKILL.md tools_used ↔ tool registry contract", () => {
  const toolNames = new Set(defaultRegistry.list().map((t) => t.name));
  const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("finds skills + a populated registry", () => {
    expect(skillDirs.length).toBeGreaterThan(0);
    expect(toolNames.size).toBeGreaterThan(0);
  });

  for (const dir of readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  )) {
    it(`${dir.name}: every tools_used entry is a registered MCP tool`, () => {
      const md = readFileSync(path.join(SKILLS_DIR, dir.name, "SKILL.md"), "utf8");
      const used = parseToolsUsed(md);
      const unknown = used.filter((t) => !toolNames.has(t));
      expect(unknown, `${dir.name} references unknown tool(s): ${unknown.join(", ")}`).toEqual([]);
    });
  }
});
