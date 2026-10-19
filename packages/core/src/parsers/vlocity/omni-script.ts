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
  classifyElement,
  collectRefEdges,
  payloadParseErrors,
  setValuesCandidates,
  sha256,
} from "./common.js";

export interface OmniScriptInput {
  name: string;
  datapack: unknown;
}

const KIND_REL: Partial<Record<ElementKind, RelType>> = {
  dataraptor: REL_TYPES.OS_USES_DR,
  ip: REL_TYPES.OS_CALLS_IP,
  remote: REL_TYPES.OS_INVOKES_REMOTE,
  card: REL_TYPES.OS_EMBEDS_VC,
  omniscript: REL_TYPES.OS_EMBEDS_OS,
  lwc: REL_TYPES.OS_EMBEDS_LWC,
  rest: REL_TYPES.CALLS_NAMED_CREDENTIAL,
};

export class OmniScriptParser implements Parser<OmniScriptInput> {
  readonly category = METADATA_CATEGORY.VLOCITY_OMNISCRIPT;
  readonly type = "VlocityOmniScript";

  async parse(input: OmniScriptInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const dp = asJson(input.datapack);
    const hash = sha256(`${VLOCITY_ELEMENT_HASH_SALT}\n${JSON.stringify(dp)}`);
    const node = buildBaseNode({
      ctx,
      label: "OmniScript",
      prefix: "OS",
      name: input.name,
      raw: dp,
      hash,
    });
    // Set Values literals that may name a component run by reference.
    const candidates = setValuesCandidates(dp);
    if (candidates.length > 0)
      (node.attributes as Record<string, unknown>).nameMatchCandidates = candidates;
    nodes.push(node, ...payloadParseErrors(ctx, node, dp));
    const src = node.qualifiedName as unknown as string;

    edges.push(
      ...collectRefEdges(
        dp,
        ctx,
        src,
        (v) => classifyElement(v),
        (k) => KIND_REL[k],
      ),
    );

    return { nodes, edges };
  }
}
