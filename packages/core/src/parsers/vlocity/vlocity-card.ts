import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { asJson, buildBaseNode, sha256, walk } from "./common.js";

export interface VlocityCardInput {
  name: string;
  datapack: unknown;
}

export class VlocityCardParser implements Parser<VlocityCardInput> {
  readonly category = METADATA_CATEGORY.VLOCITY_CARD;
  readonly type = "VlocityCard";

  async parse(input: VlocityCardInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const dp = asJson(input.datapack);
    const hash = sha256(JSON.stringify(dp));
    const node = buildBaseNode({
      ctx,
      label: "VlocityCard",
      prefix: "VC",
      name: input.name,
      raw: dp,
      hash,
    });
    nodes.push(node);
    const src = node.qualifiedName as unknown as string;

    walk(dp, (v) => {
      if (!v || typeof v !== "object") return;
      const rawType = (v as any).Type ?? (v as any).type;
      if (typeof rawType !== "string" || rawType.length === 0) return;
      const propSet = (v as any).propertySet ?? v;
      const type = rawType.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (type.includes("dataraptor")) {
        const target = String(propSet?.dataRaptorBundleName ?? "");
        if (target)
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.VC_USES_DR,
              `DataRaptor:${stripNs(target, ctx.namespace)}`,
            ),
          );
      } else if (type.includes("integrationprocedure")) {
        const target = String(propSet?.integrationProcedureKey ?? "");
        if (target)
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.VC_CALLS_IP,
              `IntegrationProcedure:${stripNs(target, ctx.namespace)}`,
            ),
          );
      } else if (type.includes("lwc") || type.includes("lightning")) {
        const target = String(propSet?.componentName ?? propSet?.bundle ?? "");
        if (target)
          edges.push(
            makeEdge(ctx, src, REL_TYPES.VC_EMBEDS_LWC, `LWC:${stripNs(target, ctx.namespace)}`),
          );
      } else if (type.includes("card")) {
        const target = String(propSet?.cardName ?? "");
        if (target)
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.EMBEDS_VC,
              `VlocityCard:${stripNs(target, ctx.namespace)}`,
            ),
          );
      } else if (type.includes("remote") || type.includes("rest")) {
        const target = String(propSet?.remoteClass ?? propSet?.endpointURL ?? "");
        edges.push(
          makeEdge(ctx, src, REL_TYPES.VC_INVOKES_REMOTE, `Remote:${target || "unknown"}`),
        );
      }
    });

    return { nodes, edges };
  }
}
