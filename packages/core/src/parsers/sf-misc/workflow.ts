import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface WorkflowInput {
  object: string;
  xml: string;
}

export class WorkflowParser implements Parser<WorkflowInput> {
  readonly category = METADATA_CATEGORY.WORKFLOW;
  readonly type = "Workflow";

  async parse(input: WorkflowInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const obj = stripNs(input.object, ctx.namespace);
    const qname = `Workflow:${obj}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const wf = parsed?.Workflow ?? {};
    nodes.push(makeNode(ctx, "Workflow", qname, { object: obj }, sha256(input.xml ?? "")));

    for (const rule of toArr<any>(wf.rules)) {
      const rname = String(rule.fullName ?? rule.name ?? "");
      const ruleQ = `WorkflowRule:${obj}.${stripNs(rname, ctx.namespace)}`;
      nodes.push(
        makeNode(ctx, "WorkflowRule", ruleQ, { name: rname, object: obj, active: !!rule.active }),
      );
      edges.push(makeEdge(ctx, qname, REL_TYPES.WORKFLOW_TRIGGERS, ruleQ));
      edges.push(makeEdge(ctx, ruleQ, REL_TYPES.TRIGGER_FIRES_ON, `CustomObject:${obj}`));
    }
    for (const upd of toArr<any>(wf.fieldUpdates)) {
      const f = String(upd.field ?? "");
      if (!f) continue;
      edges.push(
        makeEdge(
          ctx,
          qname,
          REL_TYPES.WORKFLOW_UPDATES_FIELD,
          `CustomField:${obj}.${stripNs(f, ctx.namespace)}`,
        ),
      );
    }
    return { nodes, edges };
  }
}
