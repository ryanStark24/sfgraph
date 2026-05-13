import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";

export interface SharingRulesInput {
  object: string;
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

export class SharingRulesParser implements Parser<SharingRulesInput> {
  readonly category = METADATA_CATEGORY.SHARING_RULE;
  readonly type = "SharingRules";

  async parse(input: SharingRulesInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const obj = stripNs(input.object, ctx.namespace);
    const parsed = xmlParser.parse(input.xml) as any;
    const root = parsed?.SharingRules ?? {};

    const all = [
      ...toArr<any>(root.sharingOwnerRules).map((r) => ({ kind: "owner", r })),
      ...toArr<any>(root.sharingCriteriaRules).map((r) => ({ kind: "criteria", r })),
    ];

    for (const { kind, r } of all) {
      const ruleName = stripNs(String(r.fullName ?? r.name ?? ""), ctx.namespace);
      const qname = `SharingRule:${obj}.${ruleName}`;
      const accessLevel = String(r.accessLevel ?? "");
      const sharedTo = r.sharedTo ?? {};
      const audit = accessLevel === "All";
      nodes.push(
        makeNode(
          ctx,
          "SharingRule",
          qname,
          { ruleName, object: obj, kind, accessLevel, audit },
          sha256(input.xml + ruleName),
        ),
      );
      edges.push(
        makeEdge(ctx, qname, REL_TYPES.SHARING_GRANTS, `CustomObject:${obj}`, {
          accessLevel,
          audit,
        }),
      );

      if (sharedTo.group) {
        edges.push(
          makeEdge(
            ctx,
            qname,
            REL_TYPES.SHARING_TO_GROUP,
            `Group:${stripNs(String(sharedTo.group), ctx.namespace)}`,
          ),
        );
      }
      if (sharedTo.role || sharedTo.roleAndSubordinates) {
        const role = sharedTo.role ?? sharedTo.roleAndSubordinates;
        edges.push(
          makeEdge(
            ctx,
            qname,
            REL_TYPES.SHARING_TO_ROLE,
            `Role:${stripNs(String(role), ctx.namespace)}`,
            { includesSubordinates: !!sharedTo.roleAndSubordinates },
          ),
        );
      }
      // sharedFrom (owner sharing)
      if (kind === "owner" && r.sharedFrom?.group) {
        edges.push(
          makeEdge(
            ctx,
            qname,
            REL_TYPES.SHARING_FROM_OWNER_GROUP,
            `Group:${stripNs(String(r.sharedFrom.group), ctx.namespace)}`,
          ),
        );
      }
    }

    return { nodes, edges };
  }
}
