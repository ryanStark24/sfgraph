import {
  type EdgeFact,
  METADATA_CATEGORY,
  type NodeFact,
  REL_TYPES,
  type RelType,
} from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import {
  type ElementKind,
  TARGET_LABEL,
  VLOCITY_ELEMENT_HASH_SALT,
  asJson,
  buildBaseNode,
  classifyDataSource,
  classifyElement,
  collectRefEdges,
  payloadParseErrors,
  sha256,
} from "./common.js";

export interface VlocityCardInput {
  name: string;
  datapack: unknown;
}

const KIND_REL: Partial<Record<ElementKind, RelType>> = {
  dataraptor: REL_TYPES.VC_USES_DR,
  ip: REL_TYPES.VC_CALLS_IP,
  remote: REL_TYPES.VC_INVOKES_REMOTE,
  card: REL_TYPES.EMBEDS_VC,
  lwc: REL_TYPES.VC_EMBEDS_LWC,
  rest: REL_TYPES.CALLS_NAMED_CREDENTIAL,
};

export class VlocityCardParser implements Parser<VlocityCardInput> {
  readonly category = METADATA_CATEGORY.VLOCITY_CARD;
  readonly type = "VlocityCard";

  async parse(input: VlocityCardInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const dp = asJson(input.datapack);
    const hash = sha256(`${VLOCITY_ELEMENT_HASH_SALT}\n${JSON.stringify(dp)}`);
    const node = buildBaseNode({
      ctx,
      label: "VlocityCard",
      prefix: "VC",
      name: input.name,
      raw: dp,
      hash,
    });
    nodes.push(node, ...payloadParseErrors(ctx, node, dp));
    const src = node.qualifiedName as unknown as string;

    edges.push(
      ...collectRefEdges(
        dp,
        ctx,
        src,
        (v, key) => {
          const isDs = typeof key === "string" && key.toLowerCase() === "datasource";
          // A dataSource object is not an element: classifyElement would fall back
          // to it as its own propertySet and emit a junk `Remote:unknown`.
          const refs = isDs ? [] : classifyElement(v);
          if (isDs) {
            let ds: unknown = v;
            if (typeof v === "string" && v.trimStart().startsWith("{")) {
              try {
                ds = JSON.parse(v);
              } catch {
                ds = null;
              }
            }
            refs.push(...classifyDataSource(ds));
          }
          return refs;
        },
        (k) => KIND_REL[k],
      ),
    );

    return { nodes, edges };
  }
}
