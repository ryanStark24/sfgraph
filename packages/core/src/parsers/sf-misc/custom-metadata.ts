import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface CustomMetadataInput {
  name: string; // Type.RecordName or Type
  xml: string;
  kind?: "type" | "record";
}

export class CustomMetadataParser implements Parser<CustomMetadataInput> {
  readonly category = METADATA_CATEGORY.CUSTOM_METADATA_TYPE;
  readonly type = "CustomMetadata";

  async parse(input: CustomMetadataInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const parsed = xmlParser.parse(input.xml ?? "") as any;

    if (input.kind === "record" || name.includes(".")) {
      const qname = `CustomMetadataRecord:${name}`;
      const [type] = name.split(".");
      nodes.push(makeNode(ctx, "CustomMetadataRecord", qname, { name }, sha256(input.xml ?? "")));
      if (type)
        edges.push(makeEdge(ctx, qname, REL_TYPES.INSTANCE_OF, `CustomMetadataType:${type}`));
    } else {
      const qname = `CustomMetadataType:${name}`;
      const md = parsed?.CustomObject ?? parsed?.CustomMetadata ?? {};
      nodes.push(
        makeNode(
          ctx,
          "CustomMetadataType",
          qname,
          { name, label: md.label ?? null },
          sha256(input.xml ?? ""),
        ),
      );
    }
    return { nodes, edges };
  }
}
