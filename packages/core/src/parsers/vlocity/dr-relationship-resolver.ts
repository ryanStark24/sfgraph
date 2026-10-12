import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import { REL_TYPES, STANDARD_SOBJECT_WHITELIST } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";
import { pruneStaleResolverEdges } from "../resolver-prune.js";
import type { DrRelationshipPath } from "./data-raptor.js";

/**
 * Resolve the `Rel__r.Field` paths DataRaptor rows read (recorded by the
 * parser on the DataRaptor node as `drRelationshipPaths`) through the lookup
 * fields' `referenceTo` in the graph. Each hop's lookup field is a real read
 * and is emitted too. A hop that can't be resolved to exactly one target
 * object (unknown field, polymorphic lookup, `Owner`/`CreatedBy`-style
 * names) stops the walk: nothing is emitted past it, never a guess.
 *
 * Standard relationships without a field node fall back to the naming
 * convention only when the relationship name is itself a standard SObject
 * (`Account.Name` → `Account`, `RecordType.Name` → `RecordType`).
 *
 * Edges merge by key, so re-running is idempotent; earlier output the run no
 * longer derives is pruned.
 */
export interface DrRelationshipResolveResult {
  scanned: number;
  resolved: number;
  unresolved: number;
  edgesEmitted: number;
}

function hasReferenceTo(n: NodeFact): boolean {
  const ref = (n.attributes as Record<string, unknown>).referenceTo;
  return Array.isArray(ref) && ref.length > 0;
}

const RESOLVER = "dr-relationship-resolver";

const STANDARD_BY_LOWER = new Map(
  [...STANDARD_SOBJECT_WHITELIST].map((n) => [n.toLowerCase(), n] as const),
);

export function resolveDataRaptorRelationships(
  store: GraphStore,
  orgIdIn: OrgId | string,
  ctx: ParseContext,
): DrRelationshipResolveResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const result: DrRelationshipResolveResult = {
    scanned: 0,
    resolved: 0,
    unresolved: 0,
    edgesEmitted: 0,
  };

  // Per-object field index (lower-cased API name and relationship name).
  const fieldIndex = new Map<
    string,
    { byName: Map<string, NodeFact>; byRel: Map<string, NodeFact[]> }
  >();
  const fieldsOf = (obj: string) => {
    const key = obj.toLowerCase();
    let idx = fieldIndex.get(key);
    if (idx) return idx;
    idx = { byName: new Map(), byRel: new Map() };
    for (const e of store.listEdgesFrom(
      orgId,
      asQualifiedName(`CustomObject:${obj}`),
      REL_TYPES.DEFINES_FIELD,
    )) {
      const n = store.getNode(orgId, e.dstQualifiedName);
      if (!n) continue;
      const qn = String(n.qualifiedName);
      idx.byName.set(qn.slice(qn.indexOf(".") + 1).toLowerCase(), n);
      const rn = (n.attributes as Record<string, unknown>).relationshipName;
      if (typeof rn === "string" && rn) {
        const b = idx.byRel.get(rn.toLowerCase()) ?? [];
        b.push(n);
        idx.byRel.set(rn.toLowerCase(), b);
      }
    }
    fieldIndex.set(key, idx);
    return idx;
  };
  const fieldNode = (obj: string, field: string): NodeFact | null =>
    store.getNode(orgId, asQualifiedName(`CustomField:${obj}.${field}`)) ??
    fieldsOf(obj).byName.get(field.toLowerCase()) ??
    null;

  /** One hop: the lookup field node on `obj` for relationship `seg`, and
   *  its single target object; nulls when unknown. */
  const hop = (obj: string, seg: string): { field: NodeFact | null; target: string | null } => {
    let field: NodeFact | null = null;
    if (seg.endsWith("__r")) {
      // `X__c` only counts when it is a lookup (has referenceTo); otherwise
      // the unique field whose relationshipName is `X` wins.
      const base = seg.slice(0, -3);
      const named = fieldNode(obj, `${base}__c`);
      const byRel = fieldsOf(obj).byRel.get(base.toLowerCase()) ?? [];
      const relMatch = byRel.length === 1 ? (byRel[0] ?? null) : null;
      field = named && hasReferenceTo(named) ? named : (relMatch ?? named);
    } else {
      field = fieldNode(obj, `${seg}Id`);
    }
    const ref = field ? (field.attributes as Record<string, unknown>).referenceTo : undefined;
    const targets = Array.isArray(ref) ? ref.map(String).filter(Boolean) : [];
    if (targets.length === 1) return { field, target: targets[0] ?? null };
    if (targets.length > 1) return { field, target: null }; // polymorphic
    // Standard relationship convention (no lookup metadata in the source).
    if (!seg.endsWith("__r")) {
      const std = STANDARD_BY_LOWER.get(seg.toLowerCase());
      if (std) return { field, target: std };
    }
    return { field, target: null };
  };

  const newEdges: EdgeFact[] = [];
  const previous: EdgeFact[] = [];
  const DR_RELS = [REL_TYPES.DR_READS_FIELD, REL_TYPES.DR_WRITES_FIELD] as const;
  for (const dr of store.listNodesByLabel(orgId, "DataRaptor")) {
    const mine: EdgeFact[] = [];
    for (const rel of DR_RELS) mine.push(...store.listEdgesFrom(orgId, dr.qualifiedName, rel));
    previous.push(...mine);
    // Keys another producer owns (the DataRaptor parser's direct reads): never taken over,
    // so pruning this resolver's stale output can never drop them (as in ref-resolver).
    const foreign = new Set<string>();
    for (const e of mine) {
      const a = (e.attributes ?? {}) as Record<string, unknown>;
      if (a.resolvedBy === RESOLVER || a.source === "reflection") continue;
      foreign.add(`${e.relType}|${String(e.dstQualifiedName)}`);
    }
    const paths = (dr.attributes as Record<string, unknown>).drRelationshipPaths;
    if (!Array.isArray(paths)) continue;
    const src = String(dr.qualifiedName);
    const push = (rel: RelType, dst: string, path: string) => {
      if (foreign.has(`${rel}|${dst}`)) return;
      newEdges.push({
        ...makeEdge(ctx, src, rel, dst, { resolvedBy: RESOLVER, path }),
        orgId,
        firstSeenAt: dr.firstSeenAt,
      });
    };
    for (const p of paths as DrRelationshipPath[]) {
      if (!p || typeof p.object !== "string" || typeof p.path !== "string") continue;
      result.scanned += 1;
      const rel = (p.rel as RelType) ?? REL_TYPES.DR_READS_FIELD;
      const segs = p.path.split(".");
      const last = segs.pop() ?? "";
      let cur: string | null = p.object;
      for (const seg of segs) {
        if (!cur) break;
        const h = hop(cur, seg);
        if (h.field) push(rel, String(h.field.qualifiedName), p.path);
        cur = h.target;
      }
      if (!cur || !last) {
        result.unresolved += 1;
        continue;
      }
      const fin = fieldNode(cur, last);
      push(rel, fin ? String(fin.qualifiedName) : `CustomField:${cur}.${last}`, p.path);
      result.resolved += 1;
    }
  }

  pruneStaleResolverEdges(store, orgId, RESOLVER, previous, newEdges);
  if (newEdges.length > 0) store.mergeEdges(newEdges);
  result.edgesEmitted = newEdges.length;
  return result;
}
