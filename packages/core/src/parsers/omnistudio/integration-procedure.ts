import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { asJson, buildBaseNode, sha256, walk } from "../vlocity/common.js";

export interface OmniIntegrationProcedureInput {
  name: string;
  metadata: unknown;
}

export class OmniIntegrationProcedureParser implements Parser<OmniIntegrationProcedureInput> {
  readonly category = METADATA_CATEGORY.OMNI_INTEGRATION_PROCEDURE;
  readonly type = "OmniIntegrationProcedure";

  async parse(input: OmniIntegrationProcedureInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const md = asJson(input.metadata);
    const hash = sha256(JSON.stringify(md));
    const node = buildBaseNode({
      ctx,
      label: "OmniIntegrationProcedure",
      prefix: "OMNI",
      name: input.name,
      raw: md,
      hash,
    });
    nodes.push(node);
    const src = node.qualifiedName as unknown as string;
    walk(md, (v) => {
      if (!v || typeof v !== "object") return;
      const rawType = (v as any).Type ?? (v as any).type;
      if (typeof rawType !== "string" || rawType.length === 0) return;
      const props = (v as any).propertySet ?? v;
      const type = rawType.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (type.includes("datatransform") || type.includes("dataraptor")) {
        const target = String(props?.dataTransformName ?? props?.bundle ?? "");
        if (target)
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.OMNI_CALLS_DATA_TRANSFORM,
              `OmniDataTransform:${stripNs(target, ctx.namespace)}`,
            ),
          );
      } else if (type.includes("integrationprocedure")) {
        const target = String(props?.integrationProcedureKey ?? "");
        if (target)
          edges.push(
            makeEdge(
              ctx,
              src,
              REL_TYPES.OMNI_CALLS_INTEGRATION_PROCEDURE,
              `OmniIntegrationProcedure:${stripNs(target, ctx.namespace)}`,
            ),
          );
      } else if (type.includes("remote") || type.includes("rest")) {
        edges.push(makeEdge(ctx, src, REL_TYPES.OMNI_INVOKES_REMOTE, "Remote:unknown"));
      }
    });
    return { nodes, edges };
  }
}
