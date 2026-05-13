import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface NetworkInput {
  name: string;
  xml: string;
}

export class NetworkParser implements Parser<NetworkInput> {
  readonly category = METADATA_CATEGORY.NETWORK;
  readonly type = "Network";

  async parse(input: NetworkInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `Network:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const n = parsed?.Network ?? {};
    nodes.push(
      makeNode(ctx, "Network", qname, { name, status: n.status ?? null }, sha256(input.xml ?? "")),
    );

    for (const b of toArr<any>(n.networkPageOverrides)) {
      // Some Experience Cloud bundles referenced here
      const bundle = String(b.lightningCommunityBundle ?? "");
      if (bundle)
        edges.push(
          makeEdge(
            ctx,
            qname,
            REL_TYPES.NETWORK_USES_BUNDLE,
            `LightningComponentBundle:${stripNs(bundle, ctx.namespace)}`,
          ),
        );
    }
    for (const b of toArr<string>(n.communityBundles)) {
      edges.push(
        makeEdge(
          ctx,
          qname,
          REL_TYPES.NETWORK_USES_BUNDLE,
          `LightningComponentBundle:${stripNs(String(b), ctx.namespace)}`,
        ),
      );
    }
    return { nodes, edges };
  }
}
