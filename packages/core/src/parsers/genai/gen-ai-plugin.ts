import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface GenAiPluginInput {
  name: string;
  xml: string;
}

export class GenAiPluginParser implements Parser<GenAiPluginInput> {
  readonly category = METADATA_CATEGORY.GEN_AI_PLUGIN;
  readonly type = "GenAiPlugin";

  async parse(input: GenAiPluginInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `GenAiPlugin:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const p = parsed?.GenAiPlugin ?? {};
    nodes.push(makeNode(ctx, "GenAiPlugin", qname, { name }, sha256(input.xml ?? "")));

    for (const fn of toArr<any>(p.genAiFunctions)) {
      const fname = String(fn.functionName ?? fn.name ?? fn);
      if (!fname) continue;
      edges.push(
        makeEdge(
          ctx,
          qname,
          REL_TYPES.PLUGIN_INVOKES_FUNCTION,
          `GenAiFunction:${stripNs(fname, ctx.namespace)}`,
        ),
      );
    }
    return { nodes, edges };
  }
}
