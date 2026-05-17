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
  loc?: { line?: number; column?: number },
): EdgeFact {
  const ts = nowMs(ctx);
  // Thread provenance from ParseContext + optional AST location into the
  // edge's attributes. Mirrors makeNode's behaviour (line 22) so every edge
  // can answer "where did this come from" without parser changes — callers
  // that have AST positions pass `loc` and get line/column too. Caller-
  // provided attributes win on key collision so an extractor can override
  // (e.g. post-merge resolver passes set sourceUri="post-merge://resolver").
  const provenance: Record<string, unknown> = {};
  if (ctx.sourceUri) provenance.sourceUri = ctx.sourceUri;
  if (loc?.line != null) provenance.line = loc.line;
  if (loc?.column != null) provenance.column = loc.column;
  return {
    orgId: asOrgId(ctx.orgId),
    srcQualifiedName: asQualifiedName(src),
    dstQualifiedName: asQualifiedName(dst),
    relType: rel,
    attributes: { ...provenance, ...attributes },
    firstSeenAt: ts,
    lastSeenAt: ts,
  };
}

export function stripNs(name: string, namespace: string | null): string {
  if (!namespace) return name;
  const prefix = `${namespace}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}
