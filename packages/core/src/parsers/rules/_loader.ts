import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parserRegistry } from "../registry.js";
import { RuleBasedParser } from "./_engine.js";
import { type Rule, RuleSchema } from "./_schema.js";

export interface LoadResult {
  loaded: string[];
  parsers: RuleBasedParser[];
}

/**
 * Load all rule YAML files from the given directory (defaults to this module's dir)
 * and register each with the parser registry.
 *
 * Files prefixed with `_` are treated as engine internals and skipped.
 */
export async function loadAllRules(opts?: {
  dir?: string;
  /** When true, do not register globally — return parsers only. */
  skipRegister?: boolean;
}): Promise<LoadResult> {
  const here = opts?.dir ?? dirname(fileURLToPath(import.meta.url));
  const entries = await readdir(here, { withFileTypes: true }).catch(() => []);
  const loaded: string[] = [];
  const parsers: RuleBasedParser[] = [];
  const seenTypes = new Map<string, string>();
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith(".yml") && !ent.name.endsWith(".yaml")) continue;
    if (ent.name.startsWith("_")) continue;
    const fp = join(here, ent.name);
    const text = await readFile(fp, "utf8");
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (err) {
      throw new Error(`Invalid YAML in rule file ${ent.name}: ${(err as Error).message}`);
    }
    const parsed = RuleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid rule file ${ent.name}: ${parsed.error.message}`);
    }
    const rule: Rule = parsed.data;
    const prior = seenTypes.get(rule.type);
    if (prior) {
      throw new Error(
        `Duplicate parser type "${rule.type}" in ${ent.name} (already registered by ${prior})`,
      );
    }
    seenTypes.set(rule.type, ent.name);
    const parser = new RuleBasedParser(rule);
    if (!opts?.skipRegister) {
      // Tolerate already-registered (idempotent re-load in tests).
      if (!parserRegistry.for(rule.type)) {
        parserRegistry.register(parser);
      }
    }
    loaded.push(ent.name);
    parsers.push(parser);
  }
  return { loaded, parsers };
}

let defaultLoad: Promise<LoadResult> | null = null;

/**
 * Register the bundled rule parsers once per process (memoised; a failed load
 * is retried on the next call). Every in-process parse goes through this, so
 * a parse never sees a registry without the declarative parsers (a delta's
 * main-thread pre-parse used to run before liveIngest loaded them, and
 * mis-parsed every rule-based type as opaque).
 */
export function ensureRulesLoaded(): Promise<LoadResult> {
  if (!defaultLoad) {
    defaultLoad = loadAllRules().catch((e: unknown) => {
      defaultLoad = null;
      throw e;
    });
  }
  return defaultLoad;
}
