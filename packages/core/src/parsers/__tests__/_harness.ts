import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConsoleLogger } from "@ryanstark24/sfgraph-shared";
import { expect } from "vitest";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

const VOLATILE_KEYS = new Set([
  "orgId",
  "lastSyncedAt",
  "firstSeenAt",
  "lastSeenAt",
  "lastModifiedAt",
  "sourceHash",
  "contentHash",
  "sourceUri",
]);

function stripObj(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripObj);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripObj(val);
    }
    return out;
  }
  return v;
}

export function stripVolatile(result: ParseResult): {
  nodes: unknown[];
  edges: unknown[];
} {
  const nodes = result.nodes
    .map((n) => stripObj(n) as Record<string, unknown>)
    .sort((a, b) => String(a.qualifiedName).localeCompare(String(b.qualifiedName)));
  const edges = result.edges
    .map((e) => stripObj(e) as Record<string, unknown>)
    .sort((a, b) => {
      const ka = `${a.srcQualifiedName}|${a.relType}|${a.dstQualifiedName}`;
      const kb = `${b.srcQualifiedName}|${b.relType}|${b.dstQualifiedName}`;
      return ka.localeCompare(kb);
    });
  return { nodes, edges };
}

export function makeTestCtx(sourceUri = "test://uri"): ParseContext {
  return {
    orgId: "org_test",
    sourceUri,
    parseTimestamp: "2026-01-01T00:00:00Z",
    namespace: null,
    logger: new ConsoleLogger("error"),
  };
}

export interface GoldenOpts {
  ctx?: ParseContext;
}

export async function runGolden<T>(
  parser: Parser<T>,
  input: T,
  expectedPath: string,
  opts: GoldenOpts = {},
): Promise<void> {
  const ctx = opts.ctx ?? makeTestCtx();
  const result = await parser.parse(input, ctx);
  const actual = stripVolatile(result);
  if (process.env.UPDATE_GOLDENS === "1") {
    writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  if (!existsSync(expectedPath)) {
    throw new Error(`Missing golden: ${expectedPath}`);
  }
  const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  expect(actual).toEqual(expected);
}

export function readFixture(p: string): string {
  return readFileSync(p, "utf8");
}

export function readBundle(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      const r = rel ? `${rel}/${entry}` : entry;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, r);
      else out[r] = readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return out;
}
