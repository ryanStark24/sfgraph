import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface ProfileInput {
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

export class ProfileParser implements Parser<ProfileInput> {
  readonly category = METADATA_CATEGORY.PROFILE;
  readonly type = "Profile";

  async parse(input: ProfileInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const name = stripNs(input.name, ctx.namespace);
    const qname = `Profile:${name}`;
    const parsed = xmlParser.parse(input.xml) as any;
    const profile = parsed?.Profile ?? {};
    nodes.push(makeNode(ctx, "Profile", qname, { name }, sha256(input.xml)));

    for (const op of toArr<any>(profile.objectPermissions)) {
      const obj = stripNs(String(op.object ?? ""), ctx.namespace);
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.GRANTS_OBJECT_ACCESS, `CustomObject:${obj}`, {
          allowRead: !!op.allowRead,
          allowEdit: !!op.allowEdit,
          allowCreate: !!op.allowCreate,
          allowDelete: !!op.allowDelete,
          modifyAllRecords: !!op.modifyAllRecords,
          viewAllRecords: !!op.viewAllRecords,
        }),
      );
    }
    for (const fp of toArr<any>(profile.fieldPermissions)) {
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
    for (const ca of toArr<any>(profile.classAccesses)) {
      const c = stripNs(String(ca.apexClass ?? ""), ctx.namespace);
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.GRANTS_APEX_ACCESS, `ApexClass:${c}`, {
          enabled: !!ca.enabled,
        }),
      );
    }
    for (const pa of toArr<any>(profile.pageAccesses)) {
      const p = stripNs(String(pa.apexPage ?? ""), ctx.namespace);
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.GRANTS_PAGE_ACCESS, `ApexPage:${p}`, {
          enabled: !!pa.enabled,
        }),
      );
    }
    for (const tv of toArr<any>(profile.tabVisibilities)) {
      const t = stripNs(String(tv.tab ?? ""), ctx.namespace);
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.GRANTS_TAB_ACCESS, `CustomTab:${t}`, {
          visibility: tv.visibility ?? null,
        }),
      );
    }

    return { nodes, edges };
  }
}
