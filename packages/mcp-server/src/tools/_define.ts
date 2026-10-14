import { REL_TYPES, type ToolResponse } from "@ryanstark24/sfgraph-core";
import { type ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerTool } from "../tool-registry.js";

export interface DefineToolSpec<S extends ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>) => Promise<ToolResponse<unknown>>;
}

/**
 * Cycle 3 T5: the schema as tools/list sends it, without the keywords that carry no information
 * for a caller: `$schema`, `additionalProperties: false`, a `default` of false, "" or [], and
 * `minLength: 1`. zod still enforces all of them on the call (execute parses with the zod schema).
 * `required`, `enum`, numeric bounds and types are kept.
 */
export function compactSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(compactSchema);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "$schema") continue;
    if (k === "additionalProperties" && x === false) continue;
    if (k === "minLength" && x === 1) continue;
    if (k === "default" && (x === false || x === "" || (Array.isArray(x) && x.length === 0)))
      continue;
    // `properties` maps option names to schemas: its keys are names, never keywords.
    out[k] =
      k === "properties" && x && typeof x === "object"
        ? Object.fromEntries(Object.entries(x).map(([n, s]) => [n, compactSchema(s)]))
        : compactSchema(x);
  }
  return out;
}

export function defineTool<S extends ZodTypeAny>(spec: DefineToolSpec<S>): void {
  // No $ref: defs[name] is lifted out below, so a reference into `definitions` would dangle.
  const jsonSchema = zodToJsonSchema(spec.inputSchema, {
    name: spec.name,
    target: "jsonSchema7",
    $refStrategy: "none",
  });
  let schemaObj: Record<string, unknown> = jsonSchema as Record<string, unknown>;
  const defs = (jsonSchema as { definitions?: Record<string, unknown> }).definitions;
  if (defs?.[spec.name]) {
    schemaObj = defs[spec.name] as Record<string, unknown>;
  }
  if (typeof schemaObj.type !== "string") {
    schemaObj = { type: "object", ...schemaObj };
  }
  registerTool({
    name: spec.name,
    description: spec.description,
    inputSchema: compactSchema(schemaObj) as Record<string, unknown>,
    async execute(raw) {
      const parsed = spec.inputSchema.parse(raw) as z.infer<S>;
      const r = await spec.execute(parsed);
      return r as unknown as Record<string, unknown>;
    },
  });
}

/** Plain decimal number text (optional sign, optional fraction), surrounding spaces allowed. */
const NUMERIC_STRING = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*$/;

/**
 * Accept a numeric string (`"3"`, `"0.5"`) wherever a number is expected: MCP clients and LLM
 * tool calls often send numbers as strings. Only plain decimal text is converted; anything else
 * (non-numeric strings, null, booleans) reaches `schema` unchanged and is rejected there, so the
 * wrapped schema's int/min/max/default rules still apply. The JSON schema advertised is `schema`'s.
 */
export function numeric<T extends ZodTypeAny>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && NUMERIC_STRING.test(v) ? Number(v) : v),
    schema,
  );
}

const KNOWN_REL_TYPES: readonly string[] = Object.values(REL_TYPES);
const REL_TYPE_BY_UPPER = new Map(KNOWN_REL_TYPES.map((r) => [r.toUpperCase(), r]));

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** The three known relationship types closest to `name`: most shared words, then fewest edits. */
export function nearestRelTypes(name: string): string[] {
  const want = name.toUpperCase();
  const words = new Set(want.split("_").filter(Boolean));
  return [...KNOWN_REL_TYPES]
    .map((r) => ({
      r,
      shared: r.split("_").filter((w) => words.has(w)).length,
      dist: editDistance(want, r),
    }))
    .sort((x, y) => y.shared - x.shared || x.dist - y.dist || x.r.localeCompare(y.r))
    .slice(0, 3)
    .map((x) => x.r);
}

/**
 * A `rel_types` filter. The graph's relationship types are a closed set (`REL_TYPES`), so an
 * unknown name is a mistake: before, it matched no edge and the tool answered "nothing relies on
 * X" with confidence. Names match case-insensitively and come out canonical; an unknown name is
 * rejected with the closest real ones.
 */
export function relTypes() {
  return z
    .array(z.string())
    .optional()
    .transform((names, ctx) => {
      if (!names) return names;
      const out: string[] = [];
      for (const n of names) {
        const known = REL_TYPE_BY_UPPER.get(n.trim().toUpperCase());
        if (known) out.push(known);
        else
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `unknown rel_type \`${n}\`; did you mean ${nearestRelTypes(n)
              .map((r) => `\`${r}\``)
              .join(", ")}?`,
          });
      }
      return out;
    });
}

export { z };
