import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillTarget = "claude" | "cursor" | "vscode" | "all";

export interface InstallResult {
  target: "claude" | "cursor" | "vscode";
  skill: string;
  path: string;
  action: "created" | "updated" | "would-write" | "skipped";
}

export interface InstallOptions {
  dryRun?: boolean;
  homeOverride?: string;
}

function targetDirs(home: string): Record<"claude" | "cursor" | "vscode", string> {
  return {
    claude: join(home, ".claude", "skills"),
    // Cursor uses ~/.cursor/rules with .mdc extension
    cursor: join(home, ".cursor", "rules"),
    // VS Code Claude extension shares ~/.claude
    vscode: join(home, ".claude", "skills"),
  };
}

/**
 * Walk up from the current source file (works in dist/ and src/) to locate
 * the bundled `skills/` directory next to this package's root.
 */
export function findSkillsRoot(): string {
  // import.meta.url -> /…/packages/skills/{dist,src}/installer.{js,ts}
  const here = dirname(fileURLToPath(import.meta.url));
  // candidates: ../skills, ../../skills (when inside dist/ subfolder)
  const candidates = [
    join(here, "..", "skills"),
    join(here, "..", "..", "skills"),
    join(here, "..", "..", "..", "skills"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `@sfgraph/skills: bundled skills directory not found (looked in ${candidates.join(", ")})`,
  );
}

export async function listSkillsBundled(): Promise<string[]> {
  const root = findSkillsRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillPath = join(root, e.name, "SKILL.md");
    if (existsSync(skillPath)) names.push(e.name);
  }
  return names.sort();
}

/** Claude consumes the SKILL.md format directly. */
export function toClaudeFormat(md: string): string {
  return md;
}

/**
 * Cursor expects `.mdc` rule files. We strip the `tools_used:` block from
 * the frontmatter (Cursor doesn't model tool lists) and keep the rest.
 */
export function toCursorFormat(md: string): string {
  // Strip the tools_used: line and its bulleted entries (until next top-level key or frontmatter end).
  return md.replace(/^tools_used:\s*\n(?:[ \t]+-[^\n]*\n)*/m, "");
}

export async function install(
  target: SkillTarget,
  opts: InstallOptions = {},
): Promise<InstallResult[]> {
  const home = opts.homeOverride ?? homedir();
  const dirs = targetDirs(home);
  const targets: ("claude" | "cursor" | "vscode")[] =
    target === "all" ? ["claude", "cursor", "vscode"] : [target];
  const results: InstallResult[] = [];

  const root = findSkillsRoot();
  const skills = await listSkillsBundled();

  for (const t of targets) {
    const outDir = dirs[t];
    if (!opts.dryRun) {
      await mkdir(outDir, { recursive: true });
    }
    for (const skill of skills) {
      const src = join(root, skill, "SKILL.md");
      const body = await readFile(src, "utf8");

      let outPath: string;
      let transformed: string;
      if (t === "cursor") {
        outPath = join(outDir, `${skill}.mdc`);
        transformed = toCursorFormat(body);
      } else {
        // claude + vscode: install as a directory with SKILL.md inside
        const skillDir = join(outDir, skill);
        outPath = join(skillDir, "SKILL.md");
        transformed = toClaudeFormat(body);
        if (!opts.dryRun) {
          await mkdir(skillDir, { recursive: true });
        }
      }

      let action: InstallResult["action"];
      if (opts.dryRun) {
        action = "would-write";
      } else {
        const existed = existsSync(outPath);
        if (existed) {
          const prev = await readFile(outPath, "utf8");
          if (prev === transformed) {
            action = "skipped";
          } else {
            await writeFile(outPath, transformed, "utf8");
            action = "updated";
          }
        } else {
          await writeFile(outPath, transformed, "utf8");
          action = "created";
        }
      }
      results.push({ target: t, skill, path: outPath, action });
    }
  }
  return results;
}
