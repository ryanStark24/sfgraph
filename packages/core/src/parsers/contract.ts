import type { Logger } from "@sfgraph/shared";
import type { EdgeFact, MetadataCategory, NodeFact } from "../domain/index.js";

export interface ParseContext {
  orgId: string;
  sourceUri: string;
  parseTimestamp: string;
  namespace: string | null;
  logger: Logger;
}

export interface ParseResult {
  nodes: NodeFact[];
  edges: EdgeFact[];
}

export interface Parser<TInput = unknown> {
  readonly category: MetadataCategory;
  readonly type: string;
  parse(input: TInput, ctx: ParseContext): Promise<ParseResult>;
}

export interface ParserRegistry {
  register(parser: Parser<unknown>): void;
  for(type: string): Parser<unknown> | undefined;
  all(): Parser<unknown>[];
}

/** Strip the org namespace prefix from a name when it matches. */
export function stripNamespace(name: string, namespace: string | null): string {
  if (!namespace) return name;
  const prefix = `${namespace}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Build a qualifiedName by stripping namespace first. */
export function qname(parts: TemplateStringsArray, ...vals: string[]): string {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    out += parts[i] ?? "";
    if (i < vals.length) out += vals[i] ?? "";
  }
  return out;
}
