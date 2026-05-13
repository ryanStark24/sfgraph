import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface DuplicateRuleInput {
  name: string;
  xml: string;
}

export class DuplicateRuleParser implements Parser<DuplicateRuleInput> {
  readonly category = METADATA_CATEGORY.DUPLICATE_RULE;
  readonly type = "DuplicateRule";

  async parse(input: DuplicateRuleInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `DuplicateRule:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const dr = parsed?.DuplicateRule ?? {};
    nodes.push(
      makeNode(
        ctx,
        "DuplicateRule",
        qname,
        { name, isActive: !!dr.isActive },
        sha256(input.xml ?? ""),
      ),
    );
    for (const md of toArr<any>(dr.duplicateRuleMatchRules)) {
      const mr = String(md.matchingRule ?? "");
      if (mr) {
        edges.push(
          makeEdge(ctx, qname, REL_TYPES.REFERENCES, `MatchingRule:${stripNs(mr, ctx.namespace)}`),
        );
      }
    }
    return { nodes, edges };
  }
}

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
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const mr = parsed?.MatchingRules?.matchingRules ?? parsed?.MatchingRule ?? {};
    nodes.push(makeNode(ctx, "MatchingRule", qname, { name }, sha256(input.xml ?? "")));
    return { nodes, edges: [] };
  }
}
