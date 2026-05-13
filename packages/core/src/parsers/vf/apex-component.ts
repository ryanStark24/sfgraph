import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface ApexComponentInput {
  name: string;
  xml: string;
  body?: string;
}

export class ApexComponentParser implements Parser<ApexComponentInput> {
  readonly category = METADATA_CATEGORY.APEX_COMPONENT;
  readonly type = "ApexComponent";

  async parse(input: ApexComponentInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `ApexComponent:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const meta = parsed?.ApexComponent ?? {};
    nodes.push(
      makeNode(
        ctx,
        "ApexComponent",
        qname,
        { name, apiVersion: meta.apiVersion ?? null, label: meta.label ?? null },
        sha256(input.xml ?? ""),
      ),
    );

    const body = input.body ?? "";
    const controllerMatch = body.match(/controller\s*=\s*"([^"]+)"/i);
    if (controllerMatch?.[1]) {
      const c = stripNs(controllerMatch[1], ctx.namespace);
      edges.push(makeEdge(ctx, qname, REL_TYPES.CONTROLLED_BY, `ApexClass:${c}`));
    }
    const extMatch = body.match(/extensions\s*=\s*"([^"]+)"/i);
    if (extMatch?.[1]) {
      for (const ext of extMatch[1].split(",")) {
        const e = stripNs(ext.trim(), ctx.namespace);
        if (e) edges.push(makeEdge(ctx, qname, REL_TYPES.EXTENDS_CONTROLLER, `ApexClass:${e}`));
      }
    }
    return { nodes, edges };
  }
}
