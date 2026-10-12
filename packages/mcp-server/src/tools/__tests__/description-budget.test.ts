import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DATA_POINTER, assertNoDataPointer, defaultRegistry } from "./_runner.js";

// Cycle 2 T5 fix round 2: every tool description is sent to the model on every turn (tools/list),
// so the descriptions share a size budget. An MCP client receives only the markdown text of a
// result (server.ts runTool), never `data`, so a description names what the text shows, not
// `data.*` fields the caller cannot see.
const tools = () =>
  defaultRegistry.list().map((t) => ({ name: t.name, d: t.schema.description ?? "" }));

describe("tool description budget", () => {
  // Cycle 3 T5: the whole tools/list (descriptions plus schemas) is budgeted in
  // __tests__/t5-tool-list.test.ts; this keeps any one description short.
  it("all descriptions together stay within 4000 characters", () => {
    const total = tools().reduce((n, t) => n + t.d.length, 0);
    expect(total).toBeLessThanOrEqual(4000);
  });

  it("no single description exceeds 300 characters", () => {
    const long = tools()
      .filter((t) => t.d.length > 300)
      .map((t) => `${t.name} ${t.d.length}`);
    expect(long).toEqual([]);
  });

  it("descriptions do not point the caller at `data.*` fields it never receives", () => {
    const hits = tools()
      .filter((t) => /`data\.|data\.[a-z]/.test(t.d))
      .map((t) => t.name);
    expect(hits).toEqual([]);
  });
});

// T5 review fix 2: the same holds for result text. Every tool test that calls a tool through
// _runner.callTool checks the fixture output (assertNoDataPointer); this scans the tool sources
// for text that only a branch the fixtures do not reach would print.
describe("result text never points at data.* fields", () => {
  it("the callTool guard rejects a result text naming a data field", () => {
    expect(() =>
      assertNoDataPointer("probe", { summary: "s", markdown: "+3 more in `data.items`" }),
    ).toThrow(/data\./);
    expect(() =>
      assertNoDataPointer("probe", {
        summary: "s",
        markdown: "+3 more (narrow the call: a lower `limit`)",
      }),
    ).not.toThrow();
    expect(DATA_POINTER.test("CustomMetadata.Foo__mdt and metadata.xml")).toBe(false);
  });

  // Cycle 3 T5 (parked Low): every source file under tools/ (test code aside), and every string
  // literal in it, not only lines matching a narrow pattern.
  const LIT = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  const pointers = (src: string): number[] => {
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^\s*\/\/.*$/gm, "");
    const lines: number[] = [];
    for (const m of code.matchAll(LIT)) {
      const body = m[0].replace(/\$\{[^}]*\}/g, "");
      if (/\bdata\.[a-z_]/i.test(body)) lines.push(code.slice(0, m.index).split("\n").length);
    }
    return lines;
  };

  it("the scan finds a data.* pointer in any string literal, and skips comments and code", () => {
    expect(pointers('const a = "see data.items";')).toEqual([1]);
    expect(pointers("x;\nconst b = `+${n} more in data.rows`;")).toEqual([2]);
    expect(pointers("const c = 'data.total';")).toEqual([1]);
    expect(pointers("// data.items\n/* data.rows */\nconst d = r.data.items;")).toEqual([]);
    expect(pointers("const e = `${r.data.items.length} items`;")).toEqual([]);
  });

  it("no tool source prints a data.* pointer in a string", () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files = (readdirSync(dir, { recursive: true }) as string[])
      .filter((n) => n.endsWith(".ts") && !n.split(path.sep).includes("__tests__"))
      .sort();
    // Every top-level source file (tools and helpers) is scanned.
    expect(files).toEqual(
      readdirSync(dir)
        .filter((n) => n.endsWith(".ts"))
        .sort(),
    );
    expect(files.length).toBeGreaterThan(35);
    const hits: string[] = [];
    for (const f of files)
      for (const l of pointers(readFileSync(path.join(dir, f), "utf8"))) hits.push(`${f}:${l}`);
    expect(hits).toEqual([]);
  });
});
