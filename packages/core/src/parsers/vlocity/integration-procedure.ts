import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { asJson, buildBaseNode, sha256, walk } from "./common.js";

export interface IntegrationProcedureInput {
  name: string;
  datapack: unknown;
}

export class IntegrationProcedureParser implements Parser<IntegrationProcedureInput> {
  readonly category = METADATA_CATEGORY.VLOCITY_INTEGRATION_PROCEDURE;
  readonly type = "VlocityIntegrationProcedure";

  async parse(input: IntegrationProcedureInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const dp = asJson(input.datapack);
    const hash = sha256(JSON.stringify(dp));
    const node = buildBaseNode({
      ctx,
      label: "IntegrationProcedure",
      prefix: "IP",
      name: input.name,
      raw: dp,
      hash,
    });
    nodes.push(node);
    const src = node.qualifiedName as unknown as string;

    walk(dp, (v, key) => {
      if (!v || typeof v !== "object") return;
      const propSet = (v as any).propertySet ?? v;
      const type = String((v as any).Type ?? (v as any).type ?? key ?? "");
      const nameProp =
        propSet?.bundle ??
        propSet?.integrationProcedureKey ??
        propSet?.remoteClass ??
        propSet?.dataRaptorBundleName ??
        "";
      const t = type.toLowerCase();
      if (t.includes("dataraptor")) {
        const target = String(nameProp || propSet?.dataRaptorBundleName || "");
        if (target) {
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.IP_CALLS_DR,
              `DataRaptor:${stripNs(target, ctx.namespace)}`,
            ),
          );
        }
      } else if (t.includes("integrationprocedure") || t === "ipaction" || t === "ip") {
        const target = String(nameProp || propSet?.integrationProcedureKey || "");
        if (target) {
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.IP_CALLS_IP,
              `IntegrationProcedure:${stripNs(target, ctx.namespace)}`,
            ),
          );
        }
      } else if (t.includes("remote") || t.includes("rest") || t.includes("http")) {
        const target = String(nameProp || propSet?.remoteClass || propSet?.endpointURL || "");
        edges.push(
          makeEdge(ctx, src, REL_TYPES.IP_INVOKES_REMOTE, `Remote:${target || "unknown"}`),
        );
      }
    });

    return { nodes, edges };
  }
}
