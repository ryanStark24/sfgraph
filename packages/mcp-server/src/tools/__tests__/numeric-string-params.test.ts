import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { numeric, z } from "../_define.js";
import { type Fixture, createFixture } from "./_fixture.js";
import { callTool, defaultRegistry } from "./_runner.js";

// MCP clients (and LLM tool calls) often send numbers as strings, e.g. `"depth":"1"`.
// Numeric params accept numeric strings; validation (int/min/max) still applies and
// non-numeric strings are still rejected.

describe("numeric() helper", () => {
  const s = numeric(z.number().int().min(1).max(5).default(3));
  it("coerces numeric strings and keeps numbers", () => {
    expect(s.parse("1")).toBe(1);
    expect(s.parse(" 4 ")).toBe(4);
    expect(s.parse(2)).toBe(2);
    expect(s.parse(undefined)).toBe(3);
  });
  it("keeps int/min/max validation", () => {
    expect(() => s.parse("0")).toThrow();
    expect(() => s.parse("6")).toThrow();
    expect(() => s.parse("2.5")).toThrow();
  });
  it("rejects non-numeric strings and other types", () => {
    for (const bad of [
      "abc",
      "",
      " ",
      "1abc",
      "0x10",
      "1e2",
      "Infinity",
      "NaN",
      null,
      true,
      [],
      {},
    ]) {
      expect(() => s.parse(bad), JSON.stringify(bad)).toThrow();
    }
  });
  it("accepts decimal strings for non-int schemas", () => {
    const f = numeric(z.number().min(0).max(1).default(0.3));
    expect(f.parse("0.5")).toBe(0.5);
    expect(f.parse(".25")).toBe(0.25);
    expect(() => f.parse("1.5")).toThrow();
  });
  it("optional numeric stays optional", () => {
    const o = z.object({ limit: numeric(z.number().int().positive().optional()) });
    expect(o.parse({})).toEqual({});
    expect(o.parse({ limit: "7" })).toEqual({ limit: 7 });
  });
});

// Base args for every tool that has a numeric input (the test below fails if a new
// numeric tool is added without an entry here).
const BASE: Record<string, (orgId: string) => Record<string, unknown>> = {
  impact_from_git_diff: (org) => ({ org, diff: "x" }),
  test_gap_intelligence_from_git_diff: (org) => ({ org, diff: "x" }),
  trace_downstream: (org) => ({ org, qname: "ApexClass:Nope" }),
  trace_upstream: (org) => ({ org, qname: "ApexClass:Nope" }),
  wip_impact: (org) => ({ org, project_root: "/nonexistent-sfgraph-root" }),
  wip_test_gap: (org) => ({ org, project_root: "/nonexistent-sfgraph-root" }),
  find_nodes: (org) => ({ org, pattern: "ApexClass:*" }),
  find_similar: (org) => ({ org, qname: "ApexClass:Nope" }),
  governor_risk_check: (org) => ({ org }),
  dead_code_audit: (org) => ({ org }),
  security_audit: (org) => ({ org }),
  what_broke: (org) => ({ org, since: "snap-nope" }),
  point_in_time_diff: (org) => ({ org, from: "snap-nope" }),
};

interface Prop {
  type?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
}
function numericParams(): Array<{ tool: string; param: string; prop: Prop }> {
  const out: Array<{ tool: string; param: string; prop: Prop }> = [];
  for (const t of defaultRegistry.list()) {
    const props = (t.schema.inputSchema as { properties?: Record<string, Prop> }).properties ?? {};
    for (const [param, prop] of Object.entries(props)) {
      if (prop.type === "number" || prop.type === "integer")
        out.push({ tool: t.name, param, prop });
    }
  }
  return out;
}

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

describe("every tool's numeric params accept numeric strings", () => {
  let fix: Fixture;
  beforeEach(async () => {
    fix = await createFixture();
  });
  afterEach(async () => {
    await fix.cleanup();
  });

  const params = numericParams();

  it("covers every numeric param, advertised as a number in the JSON schema", () => {
    expect(params.length).toBeGreaterThanOrEqual(13);
    expect(new Set(params.map((p) => p.tool))).toEqual(new Set(Object.keys(BASE)));
  });

  it.each(numericParams().map((p) => [`${p.tool}.${p.param}`, p] as const))(
    "%s",
    async (_name, { tool, param, prop }) => {
      const base = BASE[tool]?.(fix.orgId) ?? {};
      const lo =
        prop.minimum ?? (prop.exclusiveMinimum !== undefined ? prop.exclusiveMinimum + 1 : 1);
      const valid =
        prop.type === "integer"
          ? lo
          : prop.maximum !== undefined
            ? (lo + prop.maximum) / 2
            : lo + 0.5;
      const asNumber = await outcome(callTool(tool, { ...base, [param]: valid }));
      const asString = await outcome(callTool(tool, { ...base, [param]: String(valid) }));
      // Same behaviour as the number: the string got past validation.
      expect(asString).toBe(asNumber);
      expect(asString).not.toMatch(new RegExp(`"${param}"|Expected number`));

      await expect(callTool(tool, { ...base, [param]: "abc" })).rejects.toThrow(/Expected number/);
      const out = prop.maximum !== undefined ? prop.maximum + 1 : lo - 1;
      await expect(callTool(tool, { ...base, [param]: String(out) })).rejects.toThrow(
        new RegExp(`"${param}"`),
      );
      if (prop.type === "integer") {
        await expect(callTool(tool, { ...base, [param]: `${lo}.5` })).rejects.toThrow(/integer/);
      }
    },
  );

  it("no tool schema uses a bare z.number() / z.coerce.number() (recursive)", () => {
    const BARE = /z\s*\.\s*(coerce\s*\.\s*)?number\s*\(/g;
    // Only plain z.number() inside numeric(...) is allowed; z.coerce.number() never is.
    const WRAPPED = /numeric\(\s*z\s*\.\s*number\s*\(/g;
    // All of src/ (tool schemas and anything they import), minus test dirs.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "__tests__") walk(p);
        } else if (e.name.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const bare = (src.match(BARE) ?? []).length;
      const wrapped = (src.match(WRAPPED) ?? []).length;
      expect(bare, `${path.relative(root, f)}: wrap z.number() in numeric()`).toBe(wrapped);
    }
  });

  it("the guard regex catches spaced, coerce and nested forms", () => {
    const BARE = /z\s*\.\s*(coerce\s*\.\s*)?number\s*\(/g;
    for (const src of [
      "z.number()",
      "z .number()",
      "z.\n  number()",
      "z.coerce.number()",
      "z . coerce . number ()",
    ]) {
      expect((src.match(BARE) ?? []).length, src).toBe(1);
    }
  });
});
