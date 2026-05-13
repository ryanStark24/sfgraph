import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { asJson, buildBaseNode, extractFieldRefs, sha256 } from "../vlocity/common.js";

export interface OmniDataTransformInput {
  name: string;
  metadata: unknown;
}

export class OmniDataTransformParser implements Parser<OmniDataTransformInput> {
  readonly category = METADATA_CATEGORY.OMNI_DATA_TRANSFORM;
  readonly type = "OmniDataTransform";

  async parse(input: OmniDataTransformInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const md = asJson(input.metadata);
    const hash = sha256(JSON.stringify(md));
    const node = buildBaseNode({
      ctx,
      label: "OmniDataTransform",
      prefix: "OMNI",
      name: input.name,
      raw: md,
      hash,
    });
    nodes.push(node);
    const src = node.qualifiedName as unknown as string;
    const refs = extractFieldRefs(JSON.stringify(md));
    for (const r of refs) {
      edges.push(
        makeEdge(
          ctx,
          src,
          REL_TYPES.OMNI_USES_DATA_TRANSFORM,
          `CustomField:${r.object}.${r.field}`,
        ),
      );
    }
    return { nodes, edges };
  }
}
