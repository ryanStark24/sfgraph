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
    `@ryanstark24/sfgraph-skills: bundled skills directory not found (looked in ${candidates.join(", ")})`,
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
 * Cursor expects `.mdc` rule files with a specific frontmatter contract:
 *   description: <short description the agent matches against>
 *   globs: <file patterns; can be empty for non-file-scoped rules>
 *   alwaysApply: <true = always loaded; false = agent-requested>
 *
 * Our skill files use a different frontmatter (name/description/triggers/
 * tools_used). Rewrite the frontmatter into Cursor's shape so rules are
 * actually picked up. We use 'agent-requested' mode (alwaysApply: false +
 * rich description) which lets Cursor's agent pull the skill in when the
 * user's prompt matches the description — without polluting every chat in
 * unrelated projects.
 *
 * The body of the skill markdown (playbook, response shape, visualization,
 * don't list) is preserved verbatim — that's the actual instructions the
 * agent reads.
 */
export function toCursorFormat(md: string): string {
  // Parse the leading YAML frontmatter.
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return md; // no frontmatter — leave as-is

  const frontmatter = fmMatch[1] ?? "";
  const body = fmMatch[2] ?? "";

  // Pull out the name, description, and triggers list.
  const nameMatch = frontmatter.match(/^name:\s*(.+?)\s*$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+?)\s*$/m);
  const triggersMatch = frontmatter.match(/^triggers:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m);

  const name = nameMatch?.[1] ?? "sfgraph-skill";
  const baseDescription = descMatch?.[1] ?? "";
  const triggerPhrases: string[] = [];
  if (triggersMatch?.[1]) {
    for (const line of triggersMatch[1].split("\n")) {
      const m = line.match(/^\s*-\s*"?(.+?)"?\s*$/);
      if (m?.[1]) triggerPhrases.push(m[1]);
    }
  }

  // Compose a rich description: base + trigger phrases. Cursor's agent
  // matches the conversation against this string to decide whether to
  // pull the rule in. Mention sfgraph + Salesforce explicitly so the
  // match fires on tool-relevant questions.
  const descriptionParts = [baseDescription];
  if (triggerPhrases.length > 0) {
    descriptionParts.push(`Triggers: ${triggerPhrases.join("; ")}.`);
  }
  descriptionParts.push(
    `Use this skill (${name}) for Salesforce questions via the sfgraph MCP tools.`,
  );
  const description = descriptionParts.filter(Boolean).join(" ");

  // Salesforce file patterns that should auto-attach the rule when the user
  // opens any of them. Once any of these are in scope, Cursor's agent gets
  // the rule loaded into its context automatically — no need for the user
  // to mention sfgraph or invoke the rule by name.
  const globs = [
    "**/sfdx-project.json",
    "**/force-app/**",
    "**/*.cls",
    "**/*.cls-meta.xml",
    "**/*.trigger",
    "**/*.trigger-meta.xml",
    "**/lwc/**",
    "**/aura/**",
    "**/*.flow-meta.xml",
    "**/*.object-meta.xml",
    "**/*.field-meta.xml",
    "**/*.permissionset-meta.xml",
    "**/*.permissionsetgroup-meta.xml",
    "**/*.profile-meta.xml",
    "**/*.sharingRules-meta.xml",
    "**/*.layout-meta.xml",
    "**/*.flexipage-meta.xml",
    "**/*.namedCredential-meta.xml",
    "**/*.workflow-meta.xml",
  ].join(",");

  return `---
description: ${description.replace(/\n/g, " ").replace(/"/g, "'")}
globs: ${globs}
alwaysApply: false
---
${body}`;
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
