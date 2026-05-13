import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface ApprovalProcessInput {
  name: string; // ObjectName.ProcessName
  xml: string;
}

export class ApprovalProcessParser implements Parser<ApprovalProcessInput> {
  readonly category = METADATA_CATEGORY.APPROVAL_PROCESS;
  readonly type = "ApprovalProcess";

  async parse(input: ApprovalProcessInput, ctx: ParseContext): Promise<ApproveLike> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `ApprovalProcess:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const ap = parsed?.ApprovalProcess ?? {};
    nodes.push(
      makeNode(
        ctx,
        "ApprovalProcess",
        qname,
        { name, active: !!ap.active },
        sha256(input.xml ?? ""),
      ),
    );

    const formulas: string[] = [];
    if (ap.entryCriteria?.formula) formulas.push(String(ap.entryCriteria.formula));
    for (const step of toArr<any>(ap.approvalStep)) {
      if (step?.entryCriteria?.formula) formulas.push(String(step.entryCriteria.formula));
    }
    for (const f of formulas) {
      // emit edges to referenced fields (simple identifier match)
      for (const m of f.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*__c)\b/g)) {
        const field = stripNs(m[1] ?? "", ctx.namespace);
        edges.push(
          makeEdge(ctx, qname, REL_TYPES.APPROVAL_USES_FORMULA, `CustomField:${field}`, {
            formula: f,
          }),
        );
      }
    }
    return { nodes, edges };
  }
}

type ApproveLike = ParseResult;
