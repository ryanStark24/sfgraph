import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";

/**
 * Resolve `FLOW_INVOKES_APEX → ApexClass:Foo` edges to the specific
 * `@InvocableMethod` defined on the class. Flow XML only exposes the class
 * (and any input parameter mapping), not the method name — but because Apex
 * allows at most one `@InvocableMethod` per class, we can pair them up
 * unambiguously when there is exactly one such method.
 *
 *   0 invocable methods on the class → leave the class-level edge alone,
 *     count as `missing` (likely the class doesn't actually implement
 *     Invocable; could be a stale flow ref).
 *   1 invocable method → emit a new FLOW_INVOKES_APEX_METHOD edge.
 *   >1 invocable methods → ambiguous (legal in Apex? technically the compiler
 *     forbids two `@InvocableMethod`s in one class, but we defend anyway).
 */
export interface FlowInvocableResolveResult {
  /** Flow→ApexClass edges scanned. */
  scanned: number;
  /** Edges that produced exactly one method-level edge. */
  resolved: number;
  /** Classes with multiple invocable methods — should never happen but
   *  tracked defensively. */
  ambiguous: number;
  /** Class qnames that didn't contain any `@InvocableMethod` annotation. */
  missing: number;
}

const METHOD_QNAME_RE = /^ApexMethod:(.+)\.([A-Za-z_][\w]*)\(\d+\)$/;

export function resolveFlowApexMethods(
  store: GraphStore,
  orgIdIn: OrgId | string,
  ctx: ParseContext,
): FlowInvocableResolveResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const result: FlowInvocableResolveResult = {
    scanned: 0,
    resolved: 0,
    ambiguous: 0,
    missing: 0,
  };

  // Build className → ApexMethod[] of invocable methods (one query, walked once).
  const apexMethods: NodeFact[] = [
    ...store.listNodesByLabel(orgId, "ApexMethod"),
    ...store.listNodesByLabel(orgId, "TestMethod"),
  ];
  const invocableByClass = new Map<string, NodeFact[]>();
  for (const n of apexMethods) {
    if ((n.attributes as Record<string, unknown>)?.isInvocable !== true) continue;
    const m = METHOD_QNAME_RE.exec(String(n.qualifiedName));
    if (!m) continue;
    const cls = m[1] ?? "";
    const bucket = invocableByClass.get(cls) ?? [];
    bucket.push(n);
    invocableByClass.set(cls, bucket);
  }

  // Find every FLOW_INVOKES_APEX edge and try to resolve it.
  // listEdgesByDstLike("ApexClass:%") is cheap given how many ApexClass nodes
  // exist in a typical org.
  const flowEdges = store.listEdgesByDstLike(
    orgId,
    "ApexClass:%",
    REL_TYPES.FLOW_INVOKES_APEX,
  );

  const newEdges = [] as ReturnType<typeof makeEdge>[];
  for (const edge of flowEdges) {
    result.scanned += 1;
    const className = String(edge.dstQualifiedName).slice("ApexClass:".length);
    const candidates = invocableByClass.get(className) ?? [];
    if (candidates.length === 0) {
      result.missing += 1;
      continue;
    }
    if (candidates.length > 1) {
      result.ambiguous += 1;
      // Still emit edges to all of them so downstream impact analysis sees both.
    }
    result.resolved += 1;
    for (const m of candidates) {
      const e = makeEdge(
        ctx,
        String(edge.srcQualifiedName),
        REL_TYPES.FLOW_INVOKES_APEX_METHOD,
        String(m.qualifiedName),
        {
          ...edge.attributes,
          resolvedBy: "flow-invocable-resolver",
          ambiguous: candidates.length > 1,
        },
      );
      newEdges.push({
        ...e,
        orgId: edge.orgId,
        firstSeenAt: edge.firstSeenAt,
      });
    }
  }

  if (newEdges.length > 0) store.mergeEdges(newEdges);

  // Suppress an unused-import warning when asQualifiedName isn't directly used.
  void asQualifiedName;
  return result;
}
