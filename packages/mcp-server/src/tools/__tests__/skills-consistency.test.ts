import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REL_TYPES } from "@ryanstark24/sfgraph-core";
import { describe, expect, it } from "vitest";
import { defaultRegistry } from "./_runner.js";

/**
 * The skills (packages/skills/skills/*\/SKILL.md) tell an agent which tool to call with which
 * arguments, and which edge types to look for. Nothing tied them to the tools, so they drifted:
 * skills named parameters (`orgA`), edge types (`CALLS_METHOD`, `INVOKES_FLOW`) and risk kinds
 * that do not exist. This holds every skill to the registry and REL_TYPES.
 */
const SKILLS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../skills/skills",
);
const skills = readdirSync(SKILLS).map((name) => ({
  name,
  text: readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8"),
}));

const tools = new Map(
  defaultRegistry.list().map((t) => {
    const schema = t.schema.inputSchema as { properties?: Record<string, unknown> } | undefined;
    return [t.name, new Set(Object.keys(schema?.properties ?? {}))] as const;
  }),
);
const relTypes = new Set<string>(Object.values(REL_TYPES));

/** Upper-snake words in backticks that are not edge types: env vars, and the debug-log event
 *  names sf-debug-log-analysis teaches the agent to read. */
const NOT_EDGES =
  /^(SFGRAPH_[A-Z_]+|CUMULATIVE_LIMIT_USAGE|CODE_UNIT(_STARTED)?|METHOD_(ENTRY|EXIT)|SOQL_EXECUTE_BEGIN|DML_BEGIN|CALLOUT_REQUEST|EXCEPTION_THROWN|FATAL_ERROR|USER_DEBUG|LIMIT_USAGE_FOR_NS|HEAP_ALLOCATE|STATEMENT_EXECUTE|VARIABLE_ASSIGNMENT)$/;

const frontmatter = (text: string): string => text.split(/^---$/m)[1] ?? "";
const toolsUsed = (text: string): string[] => {
  const m = /tools_used:\s*\n((?:\s+-\s*\S+\s*\n)+)/.exec(frontmatter(text));
  return m ? [...m[1]!.matchAll(/-\s*(\S+)/g)].map((x) => x[1]!) : [];
};

describe("skills match the tools", () => {
  it("finds the skills", () => {
    expect(skills.length).toBeGreaterThan(15);
  });

  it.each(skills)("$name: every tools_used entry is a registered tool", ({ text }) => {
    const unknown = toolsUsed(text).filter((t) => !tools.has(t));
    expect(unknown).toEqual([]);
  });

  it.each(skills)("$name: every edge type in backticks exists", ({ text }) => {
    const named = [...text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1]!);
    expect(named.filter((r) => !relTypes.has(r) && !NOT_EDGES.test(r))).toEqual([]);
  });

  it.each(skills)(
    "$name: every `tool(name=…)` argument is a parameter of that tool",
    ({ text }) => {
      const bad: string[] = [];
      for (const m of text.matchAll(/\b([a-z]+(?:_[a-z]+)+)\(([^)]*)\)/g)) {
        const params = tools.get(m[1]!);
        if (!params) continue;
        // Quoted values may hold colons (`"CustomObject:Account"`): drop them first.
        const args = m[2]!.replace(/"[^"]*"|'[^']*'|`[^`]*`|\[[^\]]*\]/g, "");
        for (const a of args.matchAll(/([A-Za-z_]+)\s*[:=]/g))
          if (!params.has(a[1]!)) bad.push(`${m[1]}(${a[1]})`);
      }
      expect(bad).toEqual([]);
    },
  );
});
