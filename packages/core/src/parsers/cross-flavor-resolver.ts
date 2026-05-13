import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { REL_TYPES } from "../domain/index.js";
import type { NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";
import { makeEdge } from "./common.js";
import type { ParseContext } from "./contract.js";

/**
 * Normalize a qualifiedName for cross-flavor matching.
 * - Strip the label prefix (`DataRaptor:`, `OmniDataTransform:`, …)
 * - Strip a namespace prefix `xx__` if present
 * - Strip a flavor prefix (DR_/IP_/OS_/VC_/OMNI_) on the bare name
 * - Lowercase
 */
export function normalizeKey(qname: string, namespace: string | null = null): string {
  let bare = qname.includes(":") ? qname.slice(qname.indexOf(":") + 1) : qname;
  if (namespace && bare.startsWith(`${namespace}__`)) {
    bare = bare.slice(namespace.length + 2);
  }
  bare = bare.replace(/^(DR_|IP_|OS_|VC_|OMNI_)/i, "");
  return bare.toLowerCase();
}

const PAIRS: Array<[string, string]> = [
  ["DataRaptor", "OmniDataTransform"],
  ["IntegrationProcedure", "OmniIntegrationProcedure"],
  ["OmniScript", "OmniProcess"],
  ["VlocityCard", "OmniUiCard"],
];

export interface ResolveOpts {
  orgId: OrgId | string;
  namespace?: string | null;
  ctx: ParseContext;
}

export function resolveCrossFlavor(store: GraphStore, opts: ResolveOpts): number {
  const orgId = typeof opts.orgId === "string" ? asOrgId(opts.orgId) : opts.orgId;
  let count = 0;

  store.transaction(() => {
    for (const [labelA, labelB] of PAIRS) {
      const a = store.listNodesByLabel(orgId, labelA);
      const b = store.listNodesByLabel(orgId, labelB);
      if (a.length === 0 || b.length === 0) continue;

      const byKey: Map<string, NodeFact> = new Map();
      for (const n of a) byKey.set(normalizeKey(n.qualifiedName, opts.namespace ?? null), n);

      for (const nb of b) {
        const k = normalizeKey(nb.qualifiedName, opts.namespace ?? null);
        const na = byKey.get(k);
        if (!na) continue;

        // Emit CANONICAL_OF edges in both directions
        const e1 = makeEdge(opts.ctx, na.qualifiedName, REL_TYPES.CANONICAL_OF, nb.qualifiedName, {
          pair: `${labelA}<>${labelB}`,
        });
        const e2 = makeEdge(opts.ctx, nb.qualifiedName, REL_TYPES.CANONICAL_OF, na.qualifiedName, {
          pair: `${labelB}<>${labelA}`,
        });
        store.mergeEdges([e1, e2]);
        count += 2;

        // Update flavors[] on both nodes via mergeNodes (idempotent upsert)
        const naFlavors = mergeFlavors(na, labelA, labelB);
        const nbFlavors = mergeFlavors(nb, labelB, labelA);
        store.mergeNodes([naFlavors, nbFlavors]);
      }
    }
  });

  return count;
}

function mergeFlavors(node: NodeFact, self: string, other: string): NodeFact {
  const existing = Array.isArray((node.attributes as any).flavors)
    ? ((node.attributes as any).flavors as string[])
    : [];
  const next = Array.from(new Set([...existing, self, other])).sort();
  // Bump sourceHash so the GraphStore picks up the attribute mutation.
  const bumped = `${node.sourceHash}+canonical:${next.join(",")}` as typeof node.sourceHash;
  return {
    ...node,
    attributes: { ...node.attributes, flavors: next },
    sourceHash: bumped,
  };
}
