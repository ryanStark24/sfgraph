import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import { REL_TYPES, STANDARD_SOBJECT_WHITELIST } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";
import { pruneStaleResolverEdges } from "../resolver-prune.js";
import type { FlowRelationshipPath } from "./parser.js";

/**
 * Resolve the relationship paths a Flow reads or writes (recorded by the
 * parser on the Flow node as `flowRelationshipPaths`, e.g. `Account.Region__c`
 * from `{!$Record.Account.Region__c}` on Order) through lookup metadata in the
 * graph. Each hop's lookup field on the object it leaves is a read and is
 * emitted (`Order.AccountId`), then the final field (`Account.Region__c`) with
 * the path's own rel (READS_FIELD, or WRITES_FIELD for a related-record update).
 *
 * A hop resolves as the Apex resolver's does: `X__r` → the `X__c` lookup's
 * single `referenceTo`, else the unique field whose `relationshipName` is X;
 * a standard name → the `<Name>Id` field's single `referenceTo`. Without
 * metadata only the platform's standard names are used: `Owner` / `CreatedBy`
 * / `LastModifiedBy` → User, `Parent` on the hierarchical standard objects →
 * the same object, and a name that is itself a standard SObject (`Account`);
 * their lookup field is `<Name>Id`. Anything else (polymorphic, unknown
 * custom relationship) stops the walk: nothing is emitted for the unresolved
 * tail, never a guess. A final segment that is itself a relationship maps to
 * its lookup field when the graph knows it, else nothing.
 *
 * Edges a Flow's parser already emitted are left to it; earlier output this
 * run no longer derives is pruned. Idempotent.
 */
export const FLOW_RELATIONSHIP_RESOLVER = "flow-relationship-resolver";

export interface FlowRelationshipResolveResult {
  scanned: number;
  resolved: number;
  unresolved: number;
  edgesEmitted: number;
}

const USER_RELS = new Set(["owner", "createdby", "lastmodifiedby"]);
/** Standard objects whose `Parent` relationship is a self-lookup. */
const SELF_PARENT = new Set(["account", "asset", "campaign", "case"]);
const STANDARD_BY_LOWER = new Map(
  [...STANDARD_SOBJECT_WHITELIST].map((n) => [n.toLowerCase(), n] as const),
);

const keyOf = (rel: string, src: string, dst: string) => `${rel}|${src}|${dst}`.toLowerCase();

export function resolveFlowRelationshipPaths(
  store: GraphStore,
  orgIdIn: OrgId | string,
  ctx: ParseContext,
): FlowRelationshipResolveResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const result: FlowRelationshipResolveResult = {
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
        const b = idx.byRel.get(rn.toLowerCase().replace(/__r$/, "")) ?? [];
        b.push(n);
        idx.byRel.set(rn.toLowerCase().replace(/__r$/, ""), b);
      }
    }
    fieldIndex.set(key, idx);
    return idx;
  };
  const fieldNode = (obj: string, field: string): NodeFact | null =>
    store.getNode(orgId, asQualifiedName(`CustomField:${obj}.${field}`)) ??
    fieldsOf(obj).byName.get(field.toLowerCase()) ??
    null;
  const targetsOf = (n: NodeFact | null): string[] => {
    const ref = n ? (n.attributes as Record<string, unknown>).referenceTo : undefined;
    return Array.isArray(ref) ? ref.map(String).filter(Boolean) : [];
  };
  /** The lookup field behind custom relationship `X__r` on `obj`, or null. */
  const customLookup = (obj: string, seg: string): NodeFact | null => {
    const base = seg.slice(0, -3);
    const named = fieldNode(obj, `${base}__c`);
    if (named && targetsOf(named).length > 0) return named;
    const byRel = fieldsOf(obj).byRel.get(base.toLowerCase()) ?? [];
    if (byRel.length === 1) return byRel[0] ?? null;
    return byRel.length === 0 ? named : null;
  };

  /** One hop: the lookup field qname on `obj` for relationship `seg` and its
   *  single target object (each null when unknown). */
  const hop = (obj: string, seg: string): { field: string | null; target: string | null } => {
    const lower = seg.toLowerCase();
    if (lower.endsWith("__r")) {
      const f = customLookup(obj, seg);
      const t = targetsOf(f);
      return {
        field: f && t.length > 0 ? String(f.qualifiedName) : null,
        target: t.length === 1 ? (t[0] ?? null) : null,
      };
    }
    const idField = fieldNode(obj, `${seg}Id`);
    const t = targetsOf(idField);
    let target: string | null = null;
    if (t.length === 1) target = t[0] ?? null;
    else if (USER_RELS.has(lower)) target = "User";
    else if (t.length > 1)
      target = null; // polymorphic
    else if (lower === "parent") target = SELF_PARENT.has(obj.toLowerCase()) ? obj : null;
    else target = STANDARD_BY_LOWER.get(lower) ?? null;
    // Only a known relationship has a lookup field to read (`<seg>Id`).
    if (t.length === 0 && !target) return { field: null, target: null };
    const field = idField ? String(idField.qualifiedName) : `CustomField:${obj}.${seg}Id`;
    return { field, target };
  };

  /** The final field qname, or null to skip (a relationship whose lookup is unknown). */
  const leaf = (obj: string, seg: string): string | null => {
    const lower = seg.toLowerCase();
    if (lower.endsWith("__r")) {
      const f = customLookup(obj, seg);
      return f ? String(f.qualifiedName) : null;
    }
    const direct = fieldNode(obj, seg);
    if (direct) return String(direct.qualifiedName);
    const idField = fieldNode(obj, `${seg}Id`);
    if (idField && targetsOf(idField).length > 0) return String(idField.qualifiedName);
    if (USER_RELS.has(lower) || lower === "parent" || STANDARD_BY_LOWER.has(lower)) return null;
    return `CustomField:${obj}.${seg}`;
  };

  const newEdges: EdgeFact[] = [];
  const previous: EdgeFact[] = [];
  for (const flow of store.listNodesByLabel(orgId, "Flow")) {
    const mine: EdgeFact[] = [
      ...store.listEdgesFrom(orgId, flow.qualifiedName, REL_TYPES.READS_FIELD),
      ...store.listEdgesFrom(orgId, flow.qualifiedName, REL_TYPES.WRITES_FIELD),
    ];
    previous.push(...mine);
    const paths = (flow.attributes as Record<string, unknown>).flowRelationshipPaths;
    if (!Array.isArray(paths)) continue;
    const src = String(flow.qualifiedName);
    // Keys the Flow parser already emitted: left to it, so pruning this
    // resolver's stale output never drops them.
    const foreign = new Set<string>();
    for (const e of mine) {
      if ((e.attributes as Record<string, unknown>)?.resolvedBy === FLOW_RELATIONSHIP_RESOLVER)
        continue;
      foreign.add(keyOf(e.relType, src, String(e.dstQualifiedName)));
    }
    const emitted = new Set<string>();
    const push = (rel: RelType, dst: string, path: string) => {
      const k = keyOf(rel, src, dst);
      if (foreign.has(k) || emitted.has(k)) return;
      emitted.add(k);
      newEdges.push({
        ...makeEdge(ctx, src, rel, dst, {
          resolvedBy: FLOW_RELATIONSHIP_RESOLVER,
          via: "relationship-path",
          path,
        }),
        orgId,
        firstSeenAt: flow.firstSeenAt,
      });
    };
    for (const p of paths as FlowRelationshipPath[]) {
      if (!p || typeof p.object !== "string" || typeof p.path !== "string") continue;
      result.scanned += 1;
      const rel = p.rel === REL_TYPES.WRITES_FIELD ? REL_TYPES.WRITES_FIELD : REL_TYPES.READS_FIELD;
      const segs = p.path.split(".");
      const last = segs.pop() ?? "";
      let cur: string | null = p.object;
      for (const seg of segs) {
        if (!cur) break;
        const h = hop(cur, seg);
        // Following a lookup reads it, whatever the path then does at its end.
        if (h.field) push(REL_TYPES.READS_FIELD, h.field, p.path);
        cur = h.target;
      }
      const fin = cur && last ? leaf(cur, last) : null;
      if (!fin) {
        result.unresolved += 1;
        continue;
      }
      push(rel, fin, p.path);
      result.resolved += 1;
    }
  }

  pruneStaleResolverEdges(store, orgId, FLOW_RELATIONSHIP_RESOLVER, previous, newEdges);
  if (newEdges.length > 0) store.mergeEdges(newEdges);
  result.edgesEmitted = newEdges.length;
  return result;
}
