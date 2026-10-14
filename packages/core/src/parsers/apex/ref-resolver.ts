import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import { REL_TYPES, STANDARD_SOBJECT_WHITELIST } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";
import { pruneStaleResolverEdges } from "../resolver-prune.js";
import type {
  ApexChildRelationship,
  ApexFieldNameLiteral,
  ApexRelationshipPath,
} from "./class.js";

/**
 * Post-merge resolution of two things the Apex parsers can only record,
 * because they need the rest of the graph:
 *
 *  1. `apexRelationshipPaths` (method / class / trigger nodes): relationship
 *     traversals such as `[SELECT Account.Name FROM Contact]` or
 *     `acr.Account.Segment__c`. Each hop is resolved through lookup metadata
 *     (`X__r` → the `X__c` field's `referenceTo`, else the unique field whose
 *     `relationshipName` is `X`; a standard name → the `<Name>Id` field's
 *     single `referenceTo`). Without metadata only the platform's standard
 *     relationship names are used: `Owner` / `CreatedBy` / `LastModifiedBy`
 *     → User, `Parent` on the hierarchical standard objects → the same
 *     object, and a name that is itself a standard SObject (`Account`,
 *     `Product2`). Anything else (polymorphic, unknown) stops the walk and is
 *     counted, never guessed. Output: READS_FIELD / WRITES_FIELD to the final
 *     field, REFERENCES to every related object traversed. A final segment
 *     that is itself a relationship maps to its lookup field when the graph
 *     knows it, and is otherwise skipped and counted.
 *  2. `apexChildRelationships`: child-relationship subqueries
 *     (`(SELECT Status__c FROM Requests__r)` in a query on Account). The child
 *     object is the one with a lookup to the parent whose source-format
 *     `relationshipName` (the child relationship name) matches, without
 *     `__r`; it must be unique. Without metadata a plural of a standard object
 *     (`Contacts`, `Opportunities`) is that object. Output: REFERENCES to the
 *     child object (`via: "child-relationship"`) and READS_FIELD to each
 *     subquery field. Anything else is counted, never guessed.
 *  3. `apexFieldNameLiterals` (method nodes): a string literal that is exactly a
 *     custom field name (`setFieldIfNull(acc, 'Tier__c', v)`). READS_FIELD
 *     `{via: "field-name-literal"}` when exactly one sObject type the method
 *     declares defines that field; none or several is counted, never guessed.
 *  4. `testTargetCandidates` (test ApexClass nodes): lowercase-initial names a
 *     test instantiates or calls; IS_TEST_FOR to the ApexClass whose name
 *     matches case-insensitively. No naming-convention fallback.
 *
 * An edge whose key another producer already emitted (the parser's own
 * member-access read, say) is left to that producer. Earlier output this run
 * no longer derives is pruned.
 */
export const APEX_REF_RESOLVER = "apex-ref-resolver";

export interface ApexRefResolveResult {
  pathsResolved: number;
  pathsUnresolved: number;
  childRelationshipsResolved: number;
  childRelationshipsUnresolved: number;
  testTargetsResolved: number;
  testTargetsUnresolved: number;
  fieldLiteralsResolved: number;
  fieldLiteralsUnresolved: number;
  /** Parse stat, summed from the nodes: dynamic SOQL clause fields not
   *  attributed because the query's FROM is computed. */
  dynamicSoqlFieldsSkipped: number;
  edgesEmitted: number;
}

const PATH_LABELS = ["ApexMethod", "TestMethod", "ApexClass", "ApexTrigger"] as const;
/** Field metadata types that are relationships (a `<Seg>Id` leaf of one is a read of it). */
const LOOKUP_TYPES = new Set([
  "Lookup",
  "MasterDetail",
  "Hierarchy",
  "ExternalLookup",
  "IndirectLookup",
  "MetadataRelationship",
]);
const USER_RELS = new Set(["owner", "createdby", "lastmodifiedby"]);
/** Standard objects whose `Parent` relationship is a self-lookup. */
const SELF_PARENT = new Set(["account", "asset", "campaign", "case"]);
const STANDARD_BY_LOWER = new Map(
  [...STANDARD_SOBJECT_WHITELIST].map((n) => [n.toLowerCase(), n] as const),
);

const keyOf = (rel: string, src: string, dst: string) => `${rel}|${src}|${dst}`.toLowerCase();

export function resolveApexReferences(
  store: GraphStore,
  orgIdIn: OrgId | string,
  ctx: ParseContext,
): ApexRefResolveResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const result: ApexRefResolveResult = {
    pathsResolved: 0,
    pathsUnresolved: 0,
    childRelationshipsResolved: 0,
    childRelationshipsUnresolved: 0,
    testTargetsResolved: 0,
    testTargetsUnresolved: 0,
    fieldLiteralsResolved: 0,
    fieldLiteralsUnresolved: 0,
    dynamicSoqlFieldsSkipped: 0,
    edgesEmitted: 0,
  };

  const previous: EdgeFact[] = [
    ...store.listEdgesByDstLike(orgId, "CustomField:%", REL_TYPES.READS_FIELD),
    ...store.listEdgesByDstLike(orgId, "CustomField:%", REL_TYPES.WRITES_FIELD),
    ...store.listEdgesByDstLike(orgId, "CustomObject:%", REL_TYPES.REFERENCES),
    ...store.listEdgesByDstLike(orgId, "ApexClass:%", REL_TYPES.IS_TEST_FOR),
  ];
  // Keys another producer owns (parser edges): never overwritten.
  const foreign = new Set<string>();
  for (const e of previous) {
    const a = (e.attributes ?? {}) as Record<string, unknown>;
    if (a.resolvedBy === APEX_REF_RESOLVER || a.source === "reflection") continue;
    foreign.add(keyOf(e.relType, String(e.srcQualifiedName), String(e.dstQualifiedName)));
  }

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
  const targetsOf = (n: NodeFact | null): string[] => {
    const ref = n ? (n.attributes as Record<string, unknown>).referenceTo : undefined;
    return Array.isArray(ref) ? ref.map(String).filter(Boolean) : [];
  };
  const isLookupField = (n: NodeFact): boolean => {
    const t = (n.attributes as Record<string, unknown>).type;
    return targetsOf(n).length > 0 || (typeof t === "string" && LOOKUP_TYPES.has(t));
  };

  /** The single object relationship `seg` on `obj` leads to, or null. */
  const hop = (obj: string, seg: string): string | null => {
    const lower = seg.toLowerCase();
    if (lower.endsWith("__r")) {
      const base = seg.slice(0, -3);
      const named = fieldNode(obj, `${base}__c`);
      if (named && targetsOf(named).length > 0) {
        const t = targetsOf(named);
        return t.length === 1 ? (t[0] ?? null) : null;
      }
      const byRel = fieldsOf(obj).byRel.get(base.toLowerCase()) ?? [];
      if (byRel.length !== 1) return null;
      const t = targetsOf(byRel[0] ?? null);
      return t.length === 1 ? (t[0] ?? null) : null;
    }
    const idField = fieldNode(obj, `${seg}Id`);
    const t = targetsOf(idField);
    if (t.length === 1) return t[0] ?? null;
    if (t.length > 1 && !USER_RELS.has(lower)) return null; // polymorphic
    if (USER_RELS.has(lower)) return "User";
    if (lower === "parent") return SELF_PARENT.has(obj.toLowerCase()) ? obj : null;
    return STANDARD_BY_LOWER.get(lower) ?? null;
  };

  /**
   * When the last segment is itself a relationship (`X__r`, or a standard one such as
   * `RecordType` / `Owner` with no field of that name), the read is of its lookup field:
   * `X__c` (or the unique field whose relationshipName is X) / `<seg>Id`, if the graph knows it.
   * Returns that field, `null` when it is a relationship whose lookup field is unknown (skip),
   * or `undefined` when the segment is a plain field.
   */
  const leafField = (obj: string, seg: string): NodeFact | null | undefined => {
    const lower = seg.toLowerCase();
    if (lower.endsWith("__r")) {
      const base = seg.slice(0, -3);
      const named = fieldNode(obj, `${base}__c`);
      if (named) return named;
      const byRel = fieldsOf(obj).byRel.get(base.toLowerCase()) ?? [];
      return byRel.length === 1 ? (byRel[0] ?? null) : null;
    }
    if (fieldNode(obj, seg)) return undefined;
    // `<seg>Id` is the relationship's lookup only when it is one (T15): it has a
    // referenceTo, or its metadata type is a lookup / master-detail (standard
    // field metadata often omits referenceTo). A plain `FooId` is not `Foo`.
    const idField = fieldNode(obj, `${seg}Id`);
    if (idField && isLookupField(idField)) return idField;
    if (USER_RELS.has(lower) || lower === "parent" || STANDARD_BY_LOWER.has(lower)) return null;
    return undefined;
  };

  const newEdges: EdgeFact[] = [];
  const emitted = new Set<string>();
  const push = (src: NodeFact, rel: RelType, dst: string, attrs: Record<string, unknown>) => {
    const s = String(src.qualifiedName);
    const k = keyOf(rel, s, dst);
    if (foreign.has(k) || emitted.has(k)) return;
    emitted.add(k);
    newEdges.push({
      ...makeEdge(ctx, s, rel, dst, { resolvedBy: APEX_REF_RESOLVER, ...attrs }),
      orgId,
      firstSeenAt: src.firstSeenAt,
    });
  };

  for (const label of PATH_LABELS) {
    for (const n of store.listNodesByLabel(orgId, label)) {
      const skipped = (n.attributes as Record<string, unknown>).dynamicSoqlFieldsSkipped;
      if (typeof skipped === "number" && skipped > 0) result.dynamicSoqlFieldsSkipped += skipped;
      const paths = (n.attributes as Record<string, unknown>).apexRelationshipPaths;
      if (!Array.isArray(paths)) continue;
      for (const p of paths as ApexRelationshipPath[]) {
        if (!p || typeof p.object !== "string" || typeof p.path !== "string") continue;
        const rel =
          p.rel === REL_TYPES.WRITES_FIELD ? REL_TYPES.WRITES_FIELD : REL_TYPES.READS_FIELD;
        const segs = p.path.split(".");
        const last = segs.pop() ?? "";
        let cur: string | null = p.object;
        const via: string[] = [];
        for (const seg of segs) {
          cur = hop(cur, seg);
          if (!cur) break;
          via.push(cur);
        }
        if (!cur || !last) {
          result.pathsUnresolved += 1;
          continue;
        }
        const leaf = leafField(cur, last);
        if (leaf === null) {
          result.pathsUnresolved += 1;
          continue;
        }
        result.pathsResolved += 1;
        const fin = leaf ?? fieldNode(cur, last);
        push(n, rel, fin ? String(fin.qualifiedName) : `CustomField:${cur}.${last}`, {
          path: p.path,
        });
        for (const o of via)
          push(n, REL_TYPES.REFERENCES, `CustomObject:${o}`, {
            via: "relationship-path",
            path: p.path,
          });
      }
    }
  }

  // Child-relationship subqueries → the child object. Lookups by parent,
  // built on first use: lower-cased parent → child relationship name → children.
  let childIndex: Map<string, Map<string, Set<string>>> | null = null;
  const childOf = (parent: string, relationship: string): string | null => {
    if (!childIndex) {
      childIndex = new Map();
      for (const f of store.listNodesByLabel(orgId, "CustomField")) {
        const rn = (f.attributes as Record<string, unknown>).relationshipName;
        if (typeof rn !== "string" || !rn) continue;
        const qn = String(f.qualifiedName);
        const child = qn.slice(qn.indexOf(":") + 1, qn.indexOf("."));
        for (const t of targetsOf(f)) {
          const byName = childIndex.get(t.toLowerCase()) ?? new Map<string, Set<string>>();
          const key = rn.toLowerCase().replace(/__r$/, "");
          const set = byName.get(key) ?? new Set<string>();
          set.add(child);
          byName.set(key, set);
          childIndex.set(t.toLowerCase(), byName);
        }
      }
    }
    const lower = relationship.toLowerCase();
    const hits = childIndex.get(parent.toLowerCase())?.get(lower.replace(/__r$/, ""));
    if (hits) return hits.size === 1 ? ([...hits][0] ?? null) : null;
    if (lower.endsWith("__r")) return null;
    const single = lower.endsWith("ies") ? `${lower.slice(0, -3)}y` : lower.replace(/s$/, "");
    return single !== lower ? (STANDARD_BY_LOWER.get(single) ?? null) : null;
  };
  for (const label of PATH_LABELS) {
    for (const n of store.listNodesByLabel(orgId, label)) {
      const rels = (n.attributes as Record<string, unknown>).apexChildRelationships;
      if (!Array.isArray(rels)) continue;
      for (const r of rels as ApexChildRelationship[]) {
        if (!r || typeof r.object !== "string" || typeof r.relationship !== "string") continue;
        const child = childOf(r.object, r.relationship);
        if (!child) {
          result.childRelationshipsUnresolved += 1;
          continue;
        }
        result.childRelationshipsResolved += 1;
        const attrs = { via: "child-relationship", relationship: r.relationship };
        push(n, REL_TYPES.REFERENCES, `CustomObject:${child}`, attrs);
        for (const f of Array.isArray(r.fields) ? r.fields : []) {
          if (typeof f !== "string" || !f) continue;
          const fin = fieldNode(child, f);
          push(
            n,
            REL_TYPES.READS_FIELD,
            fin ? String(fin.qualifiedName) : `CustomField:${child}.${f}`,
            attrs,
          );
        }
      }
    }
  }

  // Field names passed as text → the one declared sObject that defines the field.
  for (const label of ["ApexMethod", "TestMethod"] as const) {
    for (const n of store.listNodesByLabel(orgId, label)) {
      const lits = (n.attributes as Record<string, unknown>).apexFieldNameLiterals;
      if (!Array.isArray(lits)) continue;
      for (const l of lits as ApexFieldNameLiteral[]) {
        if (!l || typeof l.field !== "string" || !Array.isArray(l.objects)) continue;
        const hits = new Map<string, NodeFact>();
        for (const o of l.objects) {
          if (typeof o !== "string") continue;
          const f = fieldNode(o, l.field);
          if (f) hits.set(String(f.qualifiedName).toLowerCase(), f);
        }
        const only = hits.size === 1 ? [...hits.values()][0] : undefined;
        if (!only) {
          result.fieldLiteralsUnresolved += 1;
          continue;
        }
        result.fieldLiteralsResolved += 1;
        push(n, REL_TYPES.READS_FIELD, String(only.qualifiedName), { via: "field-name-literal" });
      }
    }
  }

  // Lowercase-initial test targets → existing ApexClass nodes.
  const classes = store.listNodesByLabel(orgId, "ApexClass");
  const byLower = new Map<string, string>();
  for (const c of classes)
    byLower.set(String(c.qualifiedName).toLowerCase(), String(c.qualifiedName));
  for (const c of classes) {
    const cands = (c.attributes as Record<string, unknown>).testTargetCandidates;
    if (!Array.isArray(cands)) continue;
    const self = String(c.qualifiedName).toLowerCase();
    for (const raw of cands) {
      if (typeof raw !== "string" || !raw) continue;
      const hit = byLower.get(`apexclass:${raw.toLowerCase()}`);
      if (!hit || hit.toLowerCase() === self) {
        result.testTargetsUnresolved += 1;
        continue;
      }
      result.testTargetsResolved += 1;
      push(c, REL_TYPES.IS_TEST_FOR, hit, {});
    }
  }

  pruneStaleResolverEdges(store, orgId, APEX_REF_RESOLVER, previous, newEdges);
  if (newEdges.length > 0) store.mergeEdges(newEdges);
  result.edgesEmitted = newEdges.length;
  return result;
}
