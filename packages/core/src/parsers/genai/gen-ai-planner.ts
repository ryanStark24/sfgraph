import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface GenAiPlannerInput {
  name: string;
  xml: string;
}

export class GenAiPlannerParser implements Parser<GenAiPlannerInput> {
  readonly category = METADATA_CATEGORY.GEN_AI_PLANNER;
  readonly type = "GenAiPlanner";

  async parse(input: GenAiPlannerInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `GenAiPlanner:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const p = parsed?.GenAiPlanner ?? {};
    nodes.push(makeNode(ctx, "GenAiPlanner", qname, { name }, sha256(input.xml ?? "")));

    for (const plugin of toArr<any>(p.genAiPlugins)) {
      const pn = String(plugin.genAiPluginName ?? plugin.name ?? plugin);
      if (!pn) continue;
      edges.push(
        makeEdge(
          ctx,
          qname,
          REL_TYPES.PLANNER_USES_PLUGIN,
          `GenAiPlugin:${stripNs(pn, ctx.namespace)}`,
        ),
      );
    }
    return { nodes, edges };
  }
}
