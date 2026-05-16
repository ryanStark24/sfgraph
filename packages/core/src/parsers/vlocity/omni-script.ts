import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { asJson, buildBaseNode, sha256, walk } from "./common.js";

export interface OmniScriptInput {
  name: string;
  datapack: unknown;
}

export class OmniScriptParser implements Parser<OmniScriptInput> {
  readonly category = METADATA_CATEGORY.VLOCITY_OMNISCRIPT;
  readonly type = "VlocityOmniScript";

  async parse(input: OmniScriptInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const dp = asJson(input.datapack);
    const hash = sha256(JSON.stringify(dp));
    const node = buildBaseNode({
      ctx,
      label: "OmniScript",
      prefix: "OS",
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
        const target = String(propSet?.dataRaptorBundleName ?? propSet?.bundle ?? "");
        if (target)
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.OS_USES_DR,
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
              REL_TYPES.OS_CALLS_IP,
              `IntegrationProcedure:${stripNs(target, ctx.namespace)}`,
            ),
          );
      } else if (type.includes("card")) {
        const target = String(propSet?.cardName ?? propSet?.bundle ?? "");
        if (target)
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.OS_EMBEDS_VC,
              `VlocityCard:${stripNs(target, ctx.namespace)}`,
            ),
          );
      } else if (type.includes("remote") || type.includes("rest")) {
        const target = String(propSet?.remoteClass ?? propSet?.endpointURL ?? "");
        edges.push(
          makeEdge(ctx, src, REL_TYPES.OS_INVOKES_REMOTE, `Remote:${target || "unknown"}`),
        );
      }
    });

    return { nodes, edges };
  }
}
