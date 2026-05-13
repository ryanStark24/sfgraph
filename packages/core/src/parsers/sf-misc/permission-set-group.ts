import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { sha256, toArr, xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface PermissionSetGroupInput {
  name: string;
  xml: string;
}

export class PermissionSetGroupParser implements Parser<PermissionSetGroupInput> {
  readonly category = METADATA_CATEGORY.PERMISSION_SET_GROUP;
  readonly type = "PermissionSetGroup";

  async parse(input: PermissionSetGroupInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `PermissionSetGroup:${name}`;
    const parsed = xmlParser.parse(input.xml ?? "") as any;
    const psg = parsed?.PermissionSetGroup ?? {};
    nodes.push(
      makeNode(
        ctx,
        "PermissionSetGroup",
        qname,
        { name, label: psg.label ?? null },
        sha256(input.xml ?? ""),
      ),
    );
    for (const ps of toArr<any>(psg.permissionSets)) {
      const pname = stripNs(String(ps), ctx.namespace);
      edges.push(makeEdge(ctx, qname, REL_TYPES.GRANTS_USER_PERMISSION, `PermissionSet:${pname}`));
    }
    return { nodes, edges };
  }
}
