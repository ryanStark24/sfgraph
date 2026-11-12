import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { parse as parseYaml } from "yaml";
import { parserRegistry } from "../registry.js";
import { RuleBasedParser } from "./_engine.js";
import { RuleSchema } from "./_schema.js";

/**
 * User rule files: extra YAML rules loaded from the directory named by
 * `SFGRAPH_RULES_DIR` (CLI: `--rules-dir`), validated with the same schema as
 * the built-in rules (`_schema.ts`), so a new Salesforce metadata type can get
 * a parser without a release. Format: docs/RULES.md.
 *
 * Never throws: an unreadable directory, a file that is not valid YAML, one
 * that fails the schema, or a type that clashes is skipped with a warning.
 * A built-in parser wins on a type-name clash unless the file sets
 * `override: true`.
 */

export interface UserRulesResult {
  dir: string;
  /** Files whose rule is now registered. */
  loaded: string[];
  /** Subset of `loaded` that replaced a built-in parser (`override: true`). */
  overridden: string[];
  skipped: Array<{ file: string; reason: string }>;
  warnings: string[];
}

/** Parsers this module registered, so a second load of the same dir is a quiet no-op. */
const userParsers = new Map<string, RuleBasedParser>();

export async function loadUserRules(
  dir: string,
  opts: { /** Parse and validate only: register nothing. */ dryRun?: boolean } = {},
): Promise<UserRulesResult> {
  const result: UserRulesResult = { dir, loaded: [], overridden: [], skipped: [], warnings: [] };
  const warn = (file: string, reason: string): void => {
    result.skipped.push({ file, reason });
    result.warnings.push(`rules-dir: skipped ${file}: ${reason}`);
  };
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name) && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort();
  } catch (e) {
    result.warnings.push(`rules-dir: cannot read ${dir}: ${(e as Error).message}`);
    emit(result);
    return result;
  }
  const seenHere = new Map<string, string>();
  for (const file of names) {
    let raw: unknown;
    try {
      raw = parseYaml(await readFile(join(dir, file), "utf8"));
    } catch (e) {
      warn(file, `invalid YAML: ${(e as Error).message}`);
      continue;
    }
    const parsed = RuleSchema.safeParse(raw);
    if (!parsed.success) {
      warn(
        file,
        `invalid rule: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
      );
      continue;
    }
    const rule = parsed.data;
    const prior = seenHere.get(rule.type);
    if (prior) {
      warn(file, `type "${rule.type}" already defined by ${prior} in this directory`);
      continue;
    }
    seenHere.set(rule.type, file);
    const parser = new RuleBasedParser(rule);
    const existing = parserRegistry.for(rule.type);
    if (existing && existing === userParsers.get(rule.type)) {
      result.loaded.push(file); // already registered from this dir by an earlier load
      continue;
    }
    if (existing && !rule.override) {
      warn(
        file,
        `type "${rule.type}" already has a built-in parser; set "override: true" to replace it`,
      );
      continue;
    }
    if (!opts.dryRun) {
      if (existing) parserRegistry.replace(parser);
      else parserRegistry.register(parser);
      userParsers.set(rule.type, parser);
    }
    result.loaded.push(file);
    if (existing) result.overridden.push(file);
  }
  emit(result);
  return result;
}

/** One stderr line per warning, from the main thread only (workers re-run the load). */
function emit(r: UserRulesResult): void {
  if (!isMainThread) return;
  for (const w of r.warnings) console.warn(`sfgraph: ${w}`);
}
