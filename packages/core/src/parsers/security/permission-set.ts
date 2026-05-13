import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface PermissionSetInput {
  name: string;
  xml: string;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function toArr<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class PermissionSetParser implements Parser<PermissionSetInput> {
  readonly category = METADATA_CATEGORY.PERMISSION_SET;
  readonly type = "PermissionSet";

  async parse(input: PermissionSetInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `PermissionSet:${name}`;
    const parsed = xmlParser.parse(input.xml) as any;
    const ps = parsed?.PermissionSet ?? {};
    nodes.push(
      makeNode(ctx, "PermissionSet", qname, { name, label: ps.label ?? null }, sha256(input.xml)),
    );

    for (const op of toArr<any>(ps.objectPermissions)) {
      const obj = stripNs(String(op.object ?? ""), ctx.namespace);
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.GRANTS_OBJECT_ACCESS, `CustomObject:${obj}`, {
          allowRead: !!op.allowRead,
          allowEdit: !!op.allowEdit,
          allowCreate: !!op.allowCreate,
          allowDelete: !!op.allowDelete,
        }),
      );
    }
    for (const fp of toArr<any>(ps.fieldPermissions)) {
      const f = String(fp.field ?? "");
      const [obj, fld] = f.split(".");
      if (obj && fld) {
        edges.push(
          makeEdge(
            ctx,
            qname,
            REL_TYPES.GRANTS_FIELD_ACCESS,
            `CustomField:${stripNs(obj, ctx.namespace)}.${fld}`,
            { readable: !!fp.readable, editable: !!fp.editable },
          ),
        );
      }
    }
    for (const ca of toArr<any>(ps.classAccesses)) {
      const c = stripNs(String(ca.apexClass ?? ""), ctx.namespace);
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.GRANTS_APEX_ACCESS, `ApexClass:${c}`, {
          enabled: !!ca.enabled,
        }),
      );
    }

    return { nodes, edges };
  }
}
