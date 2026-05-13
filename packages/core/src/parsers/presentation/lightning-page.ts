import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface LightningPageInput {
  name: string;
  xml: string;
}

function collectComponentNames(node: any, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const v of node) collectComponentNames(v, out);
    return;
  }
  if (typeof node.componentName === "string") out.add(node.componentName);
  for (const v of Object.values(node)) collectComponentNames(v, out);
}

export class LightningPageParser implements Parser<LightningPageInput> {
  readonly category = METADATA_CATEGORY.LIGHTNING_PAGE;
  readonly type = "FlexiPage";

  async parse(input: LightningPageInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `FlexiPage:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const fp = parsed?.FlexiPage ?? {};
    nodes.push(
      makeNode(
        ctx,
        "FlexiPage",
        qname,
        { name, type: fp.type ?? null, sobjectType: fp.sobjectType ?? null },
        sha256(input.xml ?? ""),
      ),
    );

    const compNames = new Set<string>();
    for (const region of toArr<any>(fp.flexiPageRegions)) {
      collectComponentNames(region, compNames);
    }
    for (const cn of compNames) {
      // Heuristic: lwc:bundle uses ns__name or c__name
      const bundle = stripNs(cn.replace(/^c:/, ""), ctx.namespace);
      edges.push(makeEdge(ctx, qname, REL_TYPES.EMBEDS_LWC, `LightningComponentBundle:${bundle}`));
    }
    return { nodes, edges };
  }
}
