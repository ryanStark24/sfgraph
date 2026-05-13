import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact, RelType } from "../domain/index.js";
import type { ParseContext } from "./contract.js";

export function nowMs(ctx: ParseContext): number {
  const t = Date.parse(ctx.parseTimestamp);
  return Number.isFinite(t) ? t : Date.now();
}

export function makeNode(
  ctx: ParseContext,
  label: string,
  qualifiedName: string,
  attributes: Record<string, unknown> = {},
  sourceHash = "",
): NodeFact {
  const ts = nowMs(ctx);
  return {
    orgId: asOrgId(ctx.orgId),
    qualifiedName: asQualifiedName(qualifiedName),
    label,
    attributes: { ...attributes, sourceUri: ctx.sourceUri },
    sourceHash: asSha256(sourceHash),
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastModifiedAt: ts,
  };
}

export function makeEdge(
  ctx: ParseContext,
  src: string,
  rel: RelType,
  dst: string,
  attributes: Record<string, unknown> = {},
): EdgeFact {
  const ts = nowMs(ctx);
  return {
    orgId: asOrgId(ctx.orgId),
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel,
    attributes,
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

export function stripNs(name: string, namespace: string | null): string {
  if (!namespace) return name;
  const prefix = `${namespace}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
