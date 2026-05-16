import type { Logger } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, MetadataCategory, NodeFact } from "../domain/index.js";
import type { SnippetRecord } from "../storage/interfaces.js";

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
  /** Optional source-text snippets for code parsers (e.g. Apex methods). */
  snippets?: SnippetRecord[];
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

/** Build a qualifiedName by stripping namespace first. */
export function qname(parts: TemplateStringsArray, ...vals: string[]): string {
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    out += parts[i] ?? "";
    if (i < vals.length) out += vals[i] ?? "";
  }
  return out;
}
