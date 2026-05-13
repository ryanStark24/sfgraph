import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { OpaqueNodeParser } from "../generic/opaque-node-parser.js";

/**
 * Fallback rule-style parser that emits one opaque NodeFact for any unknown type.
 * Thin wrapper around the existing OpaqueNodeParser, exported so callers can
 * locate the fallback alongside the rule engine.
 */
export class GenericOpaqueParser implements Parser<unknown> {
  private readonly inner = new OpaqueNodeParser();
  readonly category = this.inner.category;
  readonly type = "OpaqueMetadata";
  parse(input: unknown, ctx: ParseContext): Promise<ParseResult> {
    return this.inner.parse(input as { metadataType: string; name: string; raw: string }, ctx);
  }
}
