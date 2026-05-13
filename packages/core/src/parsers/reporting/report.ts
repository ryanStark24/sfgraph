import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface ReportInput {
  name: string;
  xml: string;
}

export class ReportParser implements Parser<ReportInput> {
  readonly category = METADATA_CATEGORY.REPORT;
  readonly type = "Report";

  async parse(input: ReportInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `Report:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const r = parsed?.Report ?? {};
    const reportType = String(r.reportType ?? "");
    nodes.push(makeNode(ctx, "Report", qname, { name, reportType }, sha256(input.xml ?? "")));

    if (reportType) {
      edges.push(
        makeEdge(
          ctx,
          qname,
          REL_TYPES.REPORTS_ON,
          `CustomObject:${stripNs(reportType, ctx.namespace)}`,
        ),
      );
    }
    for (const col of toArr<any>(r.columns)) {
      const field = String(col.field ?? "");
      if (!field) continue;
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.READS_FIELD, `CustomField:${stripNs(field, ctx.namespace)}`),
      );
    }
    return { nodes, edges };
  }
}
