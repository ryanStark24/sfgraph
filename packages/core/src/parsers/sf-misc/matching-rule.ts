import { METADATA_CATEGORY, type NodeFact } from "../../domain/index.js";
import { sha256, xmlParser } from "../_xml-helpers.js";
import { makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface MatchingRuleInput {
  name: string;
  xml: string;
}

export class MatchingRuleParser implements Parser<MatchingRuleInput> {
  readonly category = METADATA_CATEGORY.MATCHING_RULE;
  readonly type = "MatchingRule";

  async parse(input: MatchingRuleInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `MatchingRule:${name}`;
    // Parse but don't currently emit edges; preserves prior behavior.
    xmlParser.parse(input.xml ?? "");
    nodes.push(makeNode(ctx, "MatchingRule", qname, { name }, sha256(input.xml ?? "")));
    return { nodes, edges: [] };
  }
}
