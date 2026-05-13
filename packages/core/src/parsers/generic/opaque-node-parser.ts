import { METADATA_CATEGORY, type NodeFact } from "../../domain/index.js";
import { sha256 } from "../_xml-helpers.js";
import { makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface OpaqueInput {
  metadataType: string;
  name: string;
  raw: string;
}

/**
 * Fallback for long-tail XML metadata types not given a dedicated parser.
 * Emits a single node with the raw blob as `rawSize` and no edges.
 */
export class OpaqueNodeParser implements Parser<OpaqueInput> {
  readonly category = METADATA_CATEGORY.OPAQUE;
  readonly type = "OpaqueMetadata";

  async parse(input: OpaqueInput, ctx: ParseContext): Promise<ParseResult> {
    const name = stripNs(input.name, ctx.namespace);
    const qname = `${input.metadataType}:${name}`;
    const node = makeNode(
      ctx,
      input.metadataType,
      qname,
      { name, metadataType: input.metadataType, rawSize: input.raw?.length ?? 0 },
      sha256(input.raw ?? ""),
    );
    return { nodes: [node], edges: [] };
  }
}
