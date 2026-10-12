import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { REL_TYPES, type RelType } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Member containment: an owner node contains member nodes that are only
 * addressable parts of it (an ApexClass contains its ApexMethods via
 * `CONTAINS_METHOD`). Every analysis applies these rules:
 *
 *  1. A reference to a member is a reference to its owner. An LWC that
 *     imports `ApexMethod:Svc.search(1)` depends on `ApexClass:Svc`, and keeps
 *     the class alive in the dead-code audit.
 *  2. The containment edge itself (owner -> member) is structure, not usage.
 *  3. Rule 1 does not run backwards: a member depends on its own callers and
 *     on references to its owner itself (type usage, `new Svc()`, static refs
 *     to the class), never on the callers of its sibling members.
 *
 * Lookups query only the containment rel tables, never every edge table.
 */
export const MEMBER_CONTAINMENT_RELTYPES: ReadonlyArray<RelType> = [REL_TYPES.CONTAINS_METHOD];

const CONTAINMENT_SET: ReadonlySet<string> = new Set(MEMBER_CONTAINMENT_RELTYPES);

/** True for an owner -> member containment edge. */
export function isMemberContainmentEdge(e: { relType: unknown }): boolean {
  return CONTAINMENT_SET.has(String(e.relType));
}

/** Members `owner` contains (destinations of its member-containment edges). */
export function listMembers(
  store: GraphStore,
  orgId: OrgId,
  owner: QualifiedName,
): QualifiedName[] {
  const out: QualifiedName[] = [];
  for (const rel of MEMBER_CONTAINMENT_RELTYPES) {
    for (const e of store.listEdgesFrom(orgId, owner, rel)) {
      if (e.dstQualifiedName !== owner) out.push(e.dstQualifiedName);
    }
  }
  return out;
}

/** The owner containing `member`, or null when it is not a member. */
export function ownerOf(
  store: GraphStore,
  orgId: OrgId,
  member: QualifiedName,
): QualifiedName | null {
  for (const rel of MEMBER_CONTAINMENT_RELTYPES) {
    for (const e of store.listEdgesTo(orgId, member, rel)) {
      if (e.srcQualifiedName !== member) return e.srcQualifiedName;
    }
  }
  return null;
}

/**
 * Traversal containment (trace_*, wip_impact, flow map): an owner and its
 * members are one component, so following containment costs no hop and the
 * pair is listed as one row. Keyed on rel type AND both labels, so e.g.
 * `Workflow -CONTAINS-> WorkflowAlert` is not folded.
 *
 * `row` says which side stands for the pair in a listing:
 *  - `both`: owner and members are listed (Apex: the class plus its methods,
 *    method rows being the class roll-up);
 *  - `owner`: members fold into the owner row (a Flow and every FlowVersion
 *    the graph holds for it; there is no active-version or status check, so
 *    a stale version the graph still holds is folded and traversed too);
 *  - `member`: the owner folds into the member row (an LWCBundle into its LWC).
 *
 * `memberScoped`: a member *seed* stays member-scoped upstream (rule 3 above);
 * only ApexMethod has siblings to keep apart.
 *
 * `sameName`: the pair only counts when owner and member have the same name
 * (an LWCBundle and its own LWC; mirrors dead-code `isOwnBundleEdge`).
 *
 * Rules never chain: no label is the member of one rule and the owner of
 * another, so a fold is always one step.
 */
export interface TraversalContainmentRule {
  relType: RelType;
  ownerLabel: string;
  memberLabel: string;
  row: "both" | "owner" | "member";
  memberScoped: boolean;
  sameName?: boolean;
}

export const TRAVERSAL_CONTAINMENT_RULES: ReadonlyArray<TraversalContainmentRule> = [
  {
    relType: REL_TYPES.CONTAINS_METHOD,
    ownerLabel: "ApexClass",
    memberLabel: "ApexMethod",
    row: "both",
    memberScoped: true,
  },
  {
    relType: REL_TYPES.CONTAINS,
    ownerLabel: "Flow",
    memberLabel: "FlowVersion",
    row: "owner",
    memberScoped: false,
  },
  {
    relType: REL_TYPES.CONTAINS_COMPONENT,
    ownerLabel: "LWCBundle",
    memberLabel: "LWC",
    row: "member",
    memberScoped: false,
    sameName: true,
  },
];

const labelOf = (q: string): string => {
  const i = q.indexOf(":");
  return i > 0 ? q.slice(0, i) : "";
};
const nameOfQ = (q: string): string => q.slice(q.indexOf(":") + 1);
const namesMatch = (r: TraversalContainmentRule, owner: string, member: string): boolean =>
  !r.sameName || nameOfQ(owner) === nameOfQ(member);

/** The traversal containment rule `e` is an instance of, or null. */
export function traversalContainmentRule(e: {
  relType: unknown;
  srcQualifiedName: string;
  dstQualifiedName: string;
}): TraversalContainmentRule | null {
  const rel = String(e.relType);
  const src = labelOf(e.srcQualifiedName);
  const dst = labelOf(e.dstQualifiedName);
  for (const r of TRAVERSAL_CONTAINMENT_RULES) {
    if (
      r.relType === rel &&
      r.ownerLabel === src &&
      r.memberLabel === dst &&
      namesMatch(r, e.srcQualifiedName, e.dstQualifiedName)
    ) {
      return r;
    }
  }
  return null;
}

/** Members of `owner` under the traversal rules (one indexed query at most). */
export function traversalMembers(
  store: GraphStore,
  orgId: OrgId,
  owner: QualifiedName,
): { members: QualifiedName[]; rule: TraversalContainmentRule | null } {
  const label = labelOf(owner);
  for (const r of TRAVERSAL_CONTAINMENT_RULES) {
    if (r.ownerLabel !== label) continue;
    const members: QualifiedName[] = [];
    for (const e of store.listEdgesFrom(orgId, owner, r.relType)) {
      if (
        e.dstQualifiedName !== owner &&
        labelOf(e.dstQualifiedName) === r.memberLabel &&
        namesMatch(r, owner, e.dstQualifiedName)
      ) {
        members.push(e.dstQualifiedName);
      }
    }
    // Sorted: edge listings have no ORDER BY (review M7).
    members.sort();
    return { members, rule: r };
  }
  return { members: [], rule: null };
}

/** The owner of `member` under the traversal rules, or null. */
export function traversalOwner(
  store: GraphStore,
  orgId: OrgId,
  member: QualifiedName,
): { owner: QualifiedName; rule: TraversalContainmentRule } | null {
  const label = labelOf(member);
  for (const r of TRAVERSAL_CONTAINMENT_RULES) {
    if (r.memberLabel !== label) continue;
    let owner: QualifiedName | null = null;
    for (const e of store.listEdgesTo(orgId, member, r.relType)) {
      if (
        e.srcQualifiedName !== member &&
        labelOf(e.srcQualifiedName) === r.ownerLabel &&
        namesMatch(r, e.srcQualifiedName, member) &&
        (owner === null || e.srcQualifiedName < owner)
      ) {
        owner = e.srcQualifiedName;
      }
    }
    return owner === null ? null : { owner, rule: r };
  }
  return null;
}

/**
 * The component a qname belongs to, for component-level listings and
 * coverage: a member folds into its owner (an ApexMethod into its ApexClass,
 * a FlowVersion into its Flow) unless its rule lists the member as the row
 * (`row: "member"`, an LWCBundle's LWC). Falls back to plain member
 * containment for owners outside the traversal rules; else `qname` itself.
 */
export function componentOf(store: GraphStore, orgId: OrgId, qname: QualifiedName): QualifiedName {
  const t = traversalOwner(store, orgId, qname);
  if (t) return t.rule.row === "member" ? qname : t.owner;
  return ownerOf(store, orgId, qname) ?? qname;
}
