import { asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import { REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";

/**
 * Post-merge: a formula's second hop (`Region__r.Area_Lead__r.Email`) names a
 * relationship on another object, whose fields the object parser does not
 * see, so it emits the convention guess `CustomField:Region__c.Area_Lead__c`
 * tagged `hopRelationship: "Area_Lead__r"`. A custom relationship name can
 * differ from its field's API name, so when a CustomField node on the target
 * object declares that `relationshipName`, move the edge onto that field
 * (attrs kept, plus `hopResolvedFrom`). Without a declaring field the guess
 * stays.
 *
 * Like the interface retarget, the moved edge carries no `resolvedBy`: it
 * stays owned by its formula's member, so reconcile drops it when the formula
 * changes, and a re-parse re-emits the guess, which the next run moves again.
 * Each move (delete + merge) is one transaction. Idempotent.
 *
 * Two fields on one object declaring the same relationshipName (the platform
 * forbids it; a half-deployed project can still carry both) make the hop
 * ambiguous: the guess stays. `sources` limits the scan to those formula /
 * validation-rule qnames (delta ingest re-resolves only the re-parsed ones).
 */
export interface FormulaHopResolveOpts {
  sources?: ReadonlySet<string>;
}

export interface FormulaHopResolveResult {
  /** Tagged guessed-hop edges examined. */
  scanned: number;
  /** Edges moved onto the declaring field. */
  moved: number;
}

const SOURCE_LABELS = ["CustomField", "ValidationRule"] as const;

export function resolveFormulaRelationshipHops(
  store: GraphStore,
  orgIdIn: OrgId | string,
  opts: FormulaHopResolveOpts = {},
): FormulaHopResolveResult {
  const orgId = typeof orgIdIn === "string" ? asOrgId(orgIdIn) : orgIdIn;
  const result: FormulaHopResolveResult = { scanned: 0, moved: 0 };

  // `object|relationship` (lower-cased, no `__r`) -> declaring field qname.
  // null: two declaring fields (ambiguous).
  const byRel = new Map<string, string | null>();
  const fields = store.listNodesByLabel(orgId, "CustomField");
  for (const f of fields) {
    const attrs = f.attributes as Record<string, unknown>;
    const rel = typeof attrs.relationshipName === "string" ? attrs.relationshipName : "";
    if (!rel) continue;
    const qn = String(f.qualifiedName);
    const obj =
      typeof attrs.object === "string" && attrs.object
        ? attrs.object
        : qn.slice("CustomField:".length, qn.lastIndexOf("."));
    const key = `${obj}|${rel.replace(/__r$/i, "")}`.toLowerCase();
    const prev = byRel.get(key);
    byRel.set(
      key,
      prev === undefined || (prev !== null && prev.toLowerCase() === qn.toLowerCase()) ? qn : null,
    );
  }
  if (byRel.size === 0) return result;

  const only = opts.sources;
  for (const label of SOURCE_LABELS) {
    const sources = label === "CustomField" ? fields : store.listNodesByLabel(orgId, label);
    for (const n of sources) {
      if (only && !only.has(String(n.qualifiedName))) continue;
      if (label === "CustomField" && !(n.attributes as Record<string, unknown>).formula) continue;
      for (const e of store.listEdgesFrom(orgId, n.qualifiedName, REL_TYPES.READS_FIELD)) {
        const rel = (e.attributes as Record<string, unknown>).hopRelationship;
        if (typeof rel !== "string" || !rel) continue;
        result.scanned += 1;
        const dst = String(e.dstQualifiedName);
        const obj = dst.slice("CustomField:".length, dst.lastIndexOf("."));
        const declared = byRel.get(`${obj}|${rel.replace(/__r$/i, "")}`.toLowerCase());
        if (!declared || declared.toLowerCase() === dst.toLowerCase()) continue;
        store.transaction(() => {
          store.deleteEdge(orgId, e.srcQualifiedName, e.dstQualifiedName, e.relType);
          store.mergeEdges([
            {
              ...e,
              dstQualifiedName: asQualifiedName(declared),
              attributes: { ...e.attributes, hopResolvedFrom: dst },
            },
          ]);
        });
        result.moved += 1;
      }
    }
  }
  return result;
}
