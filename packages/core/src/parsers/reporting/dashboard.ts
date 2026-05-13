import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface DashboardInput {
  name: string;
  xml: string;
}

export class DashboardParser implements Parser<DashboardInput> {
  readonly category = METADATA_CATEGORY.DASHBOARD;
  readonly type = "Dashboard";

  async parse(input: DashboardInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `Dashboard:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const d = parsed?.Dashboard ?? {};
    nodes.push(
      makeNode(ctx, "Dashboard", qname, { name, title: d.title ?? null }, sha256(input.xml ?? "")),
    );

    for (const c of toArr<any>(d.components)) {
      const rep = String(c.report ?? "");
      if (!rep) continue;
      edges.push(
        makeEdge(
          ctx,
          qname,
          REL_TYPES.DASHBOARD_USES_REPORT,
          `Report:${stripNs(rep, ctx.namespace)}`,
        ),
      );
    }
    return { nodes, edges };
  }
}
