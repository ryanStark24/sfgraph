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

    walk(dp, (v) => {
      if (!v || typeof v !== "object") return;
      // Only emit edges when the visited object has an EXPLICIT Type
      // property. The earlier implementation fell back to the parent
      // key name when Type was absent — that triggered false-positive
      // `Remote:unknown` edges every time the walker descended into an
      // object nested under any key containing "remote" (e.g.
      // `remoteOptions: {}`), which is rampant inside parsed
      // PropertySet blobs. Real elements always carry Type explicitly.
      const rawType = (v as any).Type ?? (v as any).type;
      if (typeof rawType !== "string" || rawType.length === 0) return;
      const propSet = (v as any).propertySet ?? v;
      const nameProp =
        propSet?.bundle ??
        propSet?.integrationProcedureKey ??
        propSet?.remoteClass ??
        propSet?.dataRaptorBundleName ??
        "";
      // Normalize the type string by stripping whitespace and
      // non-alphanumerics before substring checks. Salesforce element
      // Type values use spaces ("Integration Procedure Action",
      // "Remote Action", "DataRaptor Post Action") that `.includes(...)`
      // queries miss without normalization. e.g. previously
      // `"Integration Procedure Action".includes("integrationprocedure")`
      // was false and the element fell through to the Remote branch.
      const t = rawType.toLowerCase().replace(/[^a-z0-9]/g, "");
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
