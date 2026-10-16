import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Cycle 3: the jargon lint for tool reports, from the banned list bench/quality/jargon.json shares
// with bench/quality/jargon-lint.mjs. Text inside backticks and fenced blocks is allowed.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../../../..");
const jargon = JSON.parse(readFileSync(path.join(REPO, "bench/quality/jargon.json"), "utf8")) as {
  patterns: { id: string; regex: string; flags?: string }[];
  words: string[];
};
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const banned = [
  ...jargon.patterns.map((p) => ({ id: p.id, re: new RegExp(p.regex, `${p.flags ?? ""}g`) })),
  ...jargon.words.map((w) => ({
    id: `word:${w}`,
    re: new RegExp(`\\b${esc(w).replace(/\s+/g, "\\s+")}s?\\b`, "gi"),
  })),
];

export const stripCode = (t: string) =>
  t.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");

/** The banned-list matches in `t`, code excluded: `id "match"` strings. */
export const lint = (t: string) =>
  banned.flatMap((b) => [...stripCode(t).matchAll(b.re)].map((m) => `${b.id} "${m[0]}"`));

/** The body of the `**<heading>**` section: up to the next bold heading or `## ` title. */
export const section = (text: string, heading: string) => {
  const lines = text.split("\n");
  const at = lines.indexOf(`**${heading}**`);
  if (at < 0) return null;
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^\*\*[^*]+\*\*$/.test(l) || l.startsWith("## ")) break;
    body.push(l);
  }
  return body.join("\n").trim();
};
