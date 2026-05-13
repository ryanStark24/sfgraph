import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface LayoutInput {
  name: string; // e.g. Account-Account Layout
  xml: string;
}

export class LayoutParser implements Parser<LayoutInput> {
  readonly category = METADATA_CATEGORY.LAYOUT;
  readonly type = "Layout";

  async parse(input: LayoutInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `Layout:${name}`;
    const objName = name.split("-")[0] ?? "";
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const layout = parsed?.Layout ?? {};
    nodes.push(makeNode(ctx, "Layout", qname, { name, object: objName }, sha256(input.xml ?? "")));

    for (const section of toArr<any>(layout.layoutSections)) {
      for (const col of toArr<any>(section.layoutColumns)) {
        for (const item of toArr<any>(col.layoutItems)) {
          const f = String(item.field ?? "");
          if (!f) continue;
          const fieldName = stripNs(f, ctx.namespace);
          edges.push(
            makeEdge(ctx, qname, REL_TYPES.RENDERS_FIELD, `CustomField:${objName}.${fieldName}`),
          );
        }
      }
    }
    return { nodes, edges };
  }
}
