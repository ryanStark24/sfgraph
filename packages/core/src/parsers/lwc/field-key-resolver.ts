import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";
import { pruneStaleResolverEdges } from "../resolver-prune.js";

/**
 * Post-ingest: bind LWC object-literal custom-field keys (`recordFieldKeys`,
 * set by the LWC parser from `{ Site_Remarks__c: v }`) to a CustomField. A key
 * names no object, so it is bound by this rule (case-insensitive):
 *  1. Object context, when statically present: the LWC node's `recordObjects`
 *     (`@salesforce/schema` imports, js-meta `targetConfig` objects) plus the
 *     `sobjectType` of every FlexiPage that embeds the component. If exactly
 *     one context object has the field, bind to it; several is ambiguous.
 *  2. Otherwise (no context, or no context object has the field): bind only
 *     when exactly one CustomField node in the org has that API name. More
 *     than one is left unresolved and counted `ambiguous`; the resolver never
 *     fans out to every object with that name. Custom metadata type fields
 * (`X__mdt.F`) are not candidates: an object-literal record key is record
 * data, and CMDT records are not written through LWC record APIs. The edge
 * is `LWC_BINDS_FIELD` with `attrs.inferred=true, via="object-key",
 * resolvedBy="lwc-field-key-resolver"`. A key the LWC already binds to that
 * field another way (compared case-insensitively, like the store's edge key)
 * is left untouched. Edges merge by key, so re-running is idempotent; earlier
 * inferred edges the run no longer derives are pruned.
 */
export interface LwcFieldKeyResolveResult {
  scanned: number;
  resolved: number;
  ambiguous: number;
  missing: number;
  existing: number;
}

export function resolveLwcFieldKeys(
  store: GraphStore,
  orgIdIn: OrgId | string,
  ctx: ParseContext,
): LwcFieldKeyResolveResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const result: LwcFieldKeyResolveResult = {
    scanned: 0,
    resolved: 0,
    ambiguous: 0,
    missing: 0,
    existing: 0,
  };

  const OWNER = "lwc-field-key-resolver";
  const allLwcs = store.listNodesByLabel(orgId, "LWC");
  const lwcs = allLwcs.filter((n) =>
    Array.isArray((n.attributes as Record<string, unknown>).recordFieldKeys),
  );
  const previous = allLwcs.flatMap((n) =>
    store.listEdgesFrom(orgId, n.qualifiedName, REL_TYPES.LWC_BINDS_FIELD),
  );

  const byName = new Map<string, string[]>();
  for (const f of store.listNodesByLabel(orgId, "CustomField")) {
    const qn = String(f.qualifiedName);
    const dot = qn.lastIndexOf(".");
    if (dot < 0) continue;
    if (/__mdt$/i.test(qn.slice(0, dot))) continue;
    const key = qn.slice(dot + 1).toLowerCase();
    const bucket = byName.get(key) ?? [];
    bucket.push(qn);
    byName.set(key, bucket);
  }

  const contextOf = (lwc: (typeof lwcs)[number]): Set<string> => {
    const ctxObjs = new Set<string>();
    const own = (lwc.attributes as Record<string, unknown>).recordObjects;
    if (Array.isArray(own))
      for (const o of own) if (typeof o === "string") ctxObjs.add(o.toLowerCase());
    for (const e of store.listEdgesTo(orgId, lwc.qualifiedName, REL_TYPES.EMBEDS_LWC)) {
      const page = store.getNode(orgId, e.srcQualifiedName);
      const obj = page?.label === "FlexiPage" ? page.attributes.sobjectType : undefined;
      if (typeof obj === "string" && obj) ctxObjs.add(obj.toLowerCase());
    }
    return ctxObjs;
  };
  const objectOf = (fieldQn: string) =>
    fieldQn.slice("CustomField:".length, fieldQn.lastIndexOf(".")).toLowerCase();

  const newEdges: ReturnType<typeof makeEdge>[] = [];
  for (const lwc of lwcs) {
    const src = String(lwc.qualifiedName);
    const context = contextOf(lwc);
    const bound = new Set(
      store
        .listEdgesFrom(orgId, lwc.qualifiedName, REL_TYPES.LWC_BINDS_FIELD)
        .filter((e) => (e.attributes as Record<string, unknown>).via !== "object-key")
        .map((e) => String(e.dstQualifiedName).toLowerCase()),
    );
    for (const k of (lwc.attributes as Record<string, unknown>).recordFieldKeys as unknown[]) {
      if (typeof k !== "string" || !k) continue;
      result.scanned += 1;
      const all = byName.get(k.toLowerCase()) ?? [];
      const inContext = all.filter((qn) => context.has(objectOf(qn)));
      const hits = inContext.length > 0 ? inContext : all;
      if (hits.length === 0) {
        result.missing += 1;
        continue;
      }
      if (hits.length > 1) {
        result.ambiguous += 1;
        continue;
      }
      const dst = hits[0] as string;
      if (bound.has(dst.toLowerCase())) {
        result.existing += 1;
        continue;
      }
      newEdges.push({
        ...makeEdge(ctx, src, REL_TYPES.LWC_BINDS_FIELD, dst, {
          inferred: true,
          via: "object-key",
          resolvedBy: OWNER,
        }),
        orgId,
        firstSeenAt: lwc.firstSeenAt,
      });
      result.resolved += 1;
    }
  }
  pruneStaleResolverEdges(store, orgId, OWNER, previous, newEdges);
  if (newEdges.length > 0) store.mergeEdges(newEdges);
  return result;
}
