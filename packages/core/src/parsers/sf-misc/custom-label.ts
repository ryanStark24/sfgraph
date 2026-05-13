import { METADATA_CATEGORY, type NodeFact } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface CustomLabelsInput {
  xml: string;
}

export class CustomLabelsParser implements Parser<CustomLabelsInput> {
  readonly category = METADATA_CATEGORY.CUSTOM_LABEL;
  readonly type = "CustomLabels";

  async parse(input: CustomLabelsInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const root = parsed?.CustomLabels ?? {};
    for (const lbl of toArr<any>(root.labels)) {
      const name = stripNs(String(lbl.fullName ?? lbl.name ?? ""), ctx.namespace);
      if (!name) continue;
      nodes.push(
        makeNode(
          ctx,
          "CustomLabel",
          `CustomLabel:${name}`,
          { name, value: lbl.value ?? null, language: lbl.language ?? null },
          sha256(String(lbl.value ?? "")),
        ),
      );
    }
    return { nodes, edges: [] };
  }
}
