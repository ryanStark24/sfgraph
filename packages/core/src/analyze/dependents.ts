import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact } from "../domain/index.js";
import { REL_TYPES } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";
import {
  type TraversalContainmentRule,
  isMemberContainmentEdge,
  traversalContainmentRule,
  traversalMembers,
  traversalOwner,
} from "./containment.js";
import {
  type EdgeFilterOpts,
  STRUCTURE_LEAF_LABELS,
  keepEdge,
  labelOfQname,
} from "./edge-filters.js";

/** One node reached by a traversal, recorded at its first (minimum) hop. */
export interface ReachedEntry {
  qualifiedName: string;
  /** Node label, or the qname prefix when no node row exists. */
  label: string;
  /** Hop count at which the node was first reached (1 = direct neighbour). */
  hop: number;
  /** Relationship of the edge that first reached it. */
  relType: string;
  /** False when the edge target/source has no node row (dangling). */
  hasNode: boolean;
  /**
   * How the node was reached when not by a direct edge to a frontier node:
   * `class-rollup` = Apex class roll-up (downstream, the method's class and
   * siblings); `member` = an edge to one of the frontier node's members
   * (upstream, e.g. a caller of one of the class's methods); `owner` = an
   * edge to the frontier member's owner itself (upstream, e.g. a type usage
   * of the class a method seed belongs to); `contained` = zero-cost
   * containment (a Flow's FlowVersion, an LWC's bundle; containment.ts).
   */
  via?: "class-rollup" | "member" | "owner" | "contained";
  /**
   * `root-member`: one of the traced root's own members (an ApexClass root's
   * methods, a Flow root's FlowVersion), listed at hop 0. It is part of the
   * root, not something the root depends on. `entry`: the flow-map entry.
   * `standard-field`: a reached standard field (no `__<suffix>`, e.g. `__c`, `__pc`, `__s`;
   * field-scope.ts), listed apart from the custom components and not counted.
   */
  role?: "root-member" | "entry" | "standard-field";
  /** Containment partners folded into this row (containment.ts `row`). */
  folded?: string[];
}

export interface TraversalResult {
  nodes: NodeFact[];
  edges: EdgeFact[];
  /** Set when the traversal hit `NODE_CAP` before exhausting the graph. */
  truncated?: boolean;
  /** Edges dropped by the relType/security/reflection filter — surfaced so
   *  the tool can tell the user "N security/inferred edges hidden". */
  filtered?: number;
  /** Every reached qname (including dangling ones with no node row), in
   *  BFS order with min hop and the rel it was reached by. */
  reached?: ReachedEntry[];
  /** Containment edges not followed because of `leafStructure`. */
  structural?: number;
  /** `edges` (plus containment links) between listed rows only, endpoints
   *  remapped to the row standing for them: what a diagram should draw. */
  rowEdges?: RowEdge[];
  /** False when the seed qname has no node row and no edges at all (likely a
   *  typo): the empty result means "unknown", not "nothing depends on it". */
  found?: boolean;
}

export type TraversalOpts = EdgeFilterOpts;

export interface DependentTraversalOpts extends TraversalOpts {
  /**
   * Containment is not a dependency (mirrors downstream `leafStructure`): an
   * object reached from its own field / validation rule / record type
   * (reverse DEFINES_FIELD, HAS_VALIDATION_RULE, HAS_RECORD_TYPE, CONTAINS)
   * is listed as a leaf and not expanded into every querier of the object.
   * Default true.
   */
  leafStructure?: boolean;
  /**
   * Opt-in component-level Apex hops: a reached (non-seed) ApexMethod's next
   * hop also expands the dependents of its class's other methods. Default
   * false (T15 I-3): a reached method's dependents are its own callers plus
   * references to its class itself (class-level references), never callers
   * of unrelated sibling methods.
   */
  componentHops?: boolean;
}

/** Reverse structural edges whose source is a leaf upstream. */
const UPSTREAM_STRUCTURAL_RELTYPES: ReadonlySet<string> = new Set([
  REL_TYPES.DEFINES_FIELD,
  REL_TYPES.HAS_VALIDATION_RULE,
  REL_TYPES.HAS_RECORD_TYPE,
  REL_TYPES.CONTAINS,
]);

/** True when `e` is a structural (containment) edge out of an object-like node. */
export function isUpstreamStructuralEdge(e: EdgeFact): boolean {
  return (
    UPSTREAM_STRUCTURAL_RELTYPES.has(e.relType) &&
    STRUCTURE_LEAF_LABELS.has(labelOfQname(e.srcQualifiedName))
  );
}

/** Containment of `rule` survives the caller's rel-type filter. */
export function containmentAllowed(rule: TraversalContainmentRule, opts: EdgeFilterOpts): boolean {
  if (opts.includeRelTypes && !opts.includeRelTypes.has(rule.relType)) return false;
  return !opts.excludeRelTypes?.has(rule.relType);
}

/** An edge between two listed rows (for diagrams; see `rowEdges`). */
export interface RowEdge {
  srcQualifiedName: string;
  dstQualifiedName: string;
  relType: string;
}

/**
 * Apply containment folds: drop folded rows, record them (sorted) on the row
 * standing for them, and list node facts for the remaining rows only. A row
 * reached only by containment takes the hop / rel / via of the member it
 * folds when that member was reached by a real edge (a Flow listed for the
 * FlowVersion that calls the target). Rules never chain (containment.ts), so
 * one step resolves a fold.
 *
 * `rowEdges`: `edges` plus the containment `links`, with each endpoint
 * remapped to the row listed for it (a folded member to its row; an unlisted
 * traversal target such as a sibling method to the row it was expanded
 * through, `displayAs`), deduped, self-loops dropped. Diagrams draw these so
 * no listed box is left disconnected.
 */
export function foldRows(
  reached: ReachedEntry[],
  rowAt: ReadonlyMap<string, number>,
  foldInto: ReadonlyMap<string, string>,
  nodeOf: ReadonlyMap<string, NodeFact>,
  edges: ReadonlyArray<EdgeFact> = [],
  links: ReadonlyArray<RowEdge> = [],
  displayAs: ReadonlyMap<string, string> = new Map(),
): { rows: ReachedEntry[]; nodes: NodeFact[]; rowEdges: RowEdge[] } {
  for (const [f, into] of foldInto) {
    const fi = rowAt.get(f);
    const ii = rowAt.get(into);
    if (fi === undefined || ii === undefined) continue;
    const row = reached[ii];
    const gone = reached[fi];
    if (!row || !gone) continue;
    const folded = [...(row.folded ?? []), f].sort();
    const adopt =
      gone.hop < row.hop ||
      (row.via === "contained" && gone.via !== "contained" && gone.hop <= row.hop);
    if (adopt) {
      const { via: _via, ...rest } = row;
      reached[ii] = {
        ...rest,
        hop: gone.hop,
        relType: gone.relType,
        ...(gone.via ? { via: gone.via } : {}),
        folded,
      };
    } else {
      row.folded = folded;
    }
  }
  const rows = reached.filter(
    (r) => !(foldInto.has(r.qualifiedName) && rowAt.has(foldInto.get(r.qualifiedName) ?? "")),
  );
  const nodes: NodeFact[] = [];
  for (const r of rows) {
    const n = nodeOf.get(r.qualifiedName);
    if (n) nodes.push(n);
  }
  const listed = new Set(rows.map((r) => r.qualifiedName));
  const resolve = (q: string): string => {
    let cur = q;
    for (let i = 0; i < 4; i++) {
      if (listed.has(cur)) return cur;
      const f = foldInto.get(cur);
      if (f !== undefined && listed.has(f)) return f;
      const d = displayAs.get(cur);
      if (d === undefined) return cur;
      cur = d;
    }
    return cur;
  };
  const rowEdges: RowEdge[] = [];
  const seen = new Set<string>();
  for (const e of [...edges, ...links]) {
    const a = resolve(e.srcQualifiedName);
    const b = resolve(e.dstQualifiedName);
    if (a === b) continue;
    const k = `${a}\u0000${e.relType}\u0000${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rowEdges.push({ srcQualifiedName: a, dstQualifiedName: b, relType: String(e.relType) });
  }
  return { rows, nodes, rowEdges };
}

/**
 * Hard ceiling on visited nodes per traversal. Prevents an agent — or a
 * crafted call — from blowing memory by asking for depth=5 on a hub like
 * `CustomObject:Account` or a heavily-referenced custom field.
 *
 * Override via `TRAVERSAL_NODE_CAP` env var if you really need more.
 */
export const TRAVERSAL_NODE_CAP_DEFAULT = 500;
function nodeCap(): number {
  const raw = process.env.SFGRAPH_TRAVERSAL_NODE_CAP;
  if (!raw) return TRAVERSAL_NODE_CAP_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : TRAVERSAL_NODE_CAP_DEFAULT;
}

/**
 * Upstream BFS: who references `qname`, transitively.
 *
 * A reference to a member is a reference to its owner (see containment.ts):
 * expanding an owner such as an ApexClass also follows the incoming edges of
 * its members (CONTAINS_METHOD children), so an LWC importing
 * `ApexMethod:Svc.search(1)` is a dependent of `ApexClass:Svc`. Expanding a
 * member *seed* follows its own incoming edges plus those of its owner itself,
 * never those of its sibling members, so a method seed stays method-scoped.
 * A reached ApexMethod dependent is expanded the same way (its own callers
 * plus references to its class itself); `componentHops: true` widens it to
 * the class's other methods. Edges from the owner or its own
 * members (internal calls) and containment edges are not dependents.
 *
 * Containment costs no hop and is listed as one row: a reached FlowVersion
 * folds into its Flow (whose subflow callers are the next hop), an LWCBundle
 * into its LWC. An object reached from its own field is a leaf
 * (`leafStructure`).
 */
export function findDependents(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
  depth = 3,
  opts: DependentTraversalOpts = {},
): TraversalResult {
  const cap = nodeCap();
  const leafStructure = opts.leafStructure !== false;
  const componentHops = opts.componentHops === true;
  const visited = new Set<string>();
  /** Targets whose incoming edges were already listed (owner or member). */
  const expanded = new Set<string>();
  /** Reached nodes kept as structural leaves (not expanded). */
  const leaves = new Set<string>();
  const nodeOf = new Map<string, NodeFact>();
  const edges: EdgeFact[] = [];
  const reached: ReachedEntry[] = [];
  const rowAt = new Map<string, number>();
  const foldInto = new Map<string, string>();
  /** Containment links between reached nodes (for `rowEdges`). */
  const links: RowEdge[] = [];
  /** Unlisted traversal target -> the node it was expanded through. */
  const displayAs = new Map<string, string>();
  let frontier: QualifiedName[] = [qname];
  visited.add(qname);
  let truncated = false;
  let filtered = 0;
  let structural = 0;
  // Containment lookups, memoised per traversal: every reached method of a
  // class would otherwise re-list the class's members (review M4).
  const membersMemo = new Map<string, ReturnType<typeof traversalMembers>>();
  const ownerMemo = new Map<string, ReturnType<typeof traversalOwner>>();
  const membersOf = (q: QualifiedName): ReturnType<typeof traversalMembers> => {
    let v = membersMemo.get(q);
    if (!v) {
      v = traversalMembers(store, orgId, q);
      membersMemo.set(q, v);
    }
    return v;
  };
  const ownerOfMember = (q: QualifiedName): ReturnType<typeof traversalOwner> => {
    if (!ownerMemo.has(q)) ownerMemo.set(q, traversalOwner(store, orgId, q));
    return ownerMemo.get(q) ?? null;
  };
  // A member seed's owner: its other members stay member-scoped at every hop
  // (a sibling calling the seed is a dependent; callers of unrelated
  // siblings are not; review I1).
  const seedOwn = ownerOfMember(qname);
  const seedOwner = seedOwn?.rule.memberScoped ? seedOwn.owner : null;

  /** Record `q` reached; returns false when the node cap is hit. */
  const reach = (
    q: QualifiedName,
    hop: number,
    relType: string,
    next: QualifiedName[],
    via?: ReachedEntry["via"],
  ): boolean => {
    visited.add(q);
    const n = store.getNode(orgId, q);
    if (n) nodeOf.set(q, n);
    rowAt.set(q, reached.length);
    reached.push({
      qualifiedName: q,
      label: n?.label ?? labelOfQname(q),
      hop,
      relType,
      hasNode: n !== null,
      ...(via ? { via } : {}),
    });
    next.push(q);
    return visited.size < cap;
  };

  /** Zero-cost, folded containment around a newly reached dependent. */
  const contain = (q: QualifiedName, hop: number, next: QualifiedName[]): boolean => {
    const { members, rule } = membersOf(q);
    if (rule && rule.row !== "both" && containmentAllowed(rule, opts)) {
      for (const m of members) {
        if (rule.row === "owner") foldInto.set(m, q);
        else if (!foldInto.has(q)) foldInto.set(q, m);
        links.push({ srcQualifiedName: q, dstQualifiedName: m, relType: rule.relType });
        if (visited.has(m)) continue;
        if (!reach(m, hop, rule.relType, next, "contained")) return false;
      }
    }
    const own = ownerOfMember(q);
    if (!own || own.rule.row === "both" || !containmentAllowed(own.rule, opts)) return true;
    if (own.rule.row === "owner") foldInto.set(q, own.owner);
    else foldInto.set(own.owner, q);
    links.push({ srcQualifiedName: own.owner, dstQualifiedName: q, relType: own.rule.relType });
    if (visited.has(own.owner)) return true;
    if (!reach(own.owner, hop, own.rule.relType, next, "contained")) return false;
    return contain(own.owner, hop, next);
  };

  bfs: for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: QualifiedName[] = [];
    for (const cur of frontier) {
      if (leaves.has(cur)) continue;
      // (target, how a hit through it is reported, the target's own family
      // whose edges into it are internal, not dependents)
      const targets: Array<[QualifiedName, ReachedEntry["via"], Set<string>]> = [];
      const { members } = membersOf(cur);
      if (members.length > 0) {
        // An owner: references to any member are references to it (rule 1).
        const family = new Set<string>([cur, ...members]);
        targets.push([cur, undefined, family]);
        for (const m of members) targets.push([m, "member", family]);
      } else {
        const own = ownerOfMember(cur);
        if (!own) {
          targets.push([cur, undefined, new Set([cur])]);
        } else {
          const owner = own.owner;
          const siblings = membersOf(owner).members;
          const family = new Set<string>([owner, ...siblings, cur]);
          if (own.rule.memberScoped && (d === 0 || !componentHops || owner === seedOwner)) {
            // A member seed (or a member of the seed's own owner): also
            // references to its owner itself, but not to the owner's other
            // members (rule 3).
            targets.push([cur, undefined, new Set([cur])]);
            targets.push([owner, "owner", family]);
          } else {
            // A reached member (or a single-member container): the whole
            // component, so the next hop is component-level.
            targets.push([cur, undefined, family]);
            targets.push([owner, "owner", family]);
            for (const m of siblings) if (m !== cur) targets.push([m, "member", family]);
          }
        }
      }
      for (const [target, via, self] of targets) {
        if (expanded.has(target)) continue;
        expanded.add(target);
        if (target !== cur && !displayAs.has(target)) displayAs.set(target, cur);
        for (const e of store.listEdgesTo(orgId, target)) {
          // Containment is structure (rule 2); the owner's own internal
          // calls are not dependents.
          if (
            isMemberContainmentEdge(e) ||
            traversalContainmentRule(e) !== null ||
            self.has(e.srcQualifiedName)
          ) {
            continue;
          }
          // Filter noise (security grants / reflection inferences) before the
          // edge contributes a node — otherwise a hub like a class granted to
          // 100+ profiles blows the node cap on grant edges alone and the real
          // dependency frontier never gets explored.
          if (!keepEdge(e, opts)) {
            filtered += 1;
            continue;
          }
          edges.push(e);
          const src = e.srcQualifiedName;
          if (visited.has(src)) continue;
          if (!reach(src, d + 1, e.relType, next, via)) {
            truncated = true;
            break bfs;
          }
          if (leafStructure && isUpstreamStructuralEdge(e)) {
            leaves.add(src);
            structural += 1;
            continue;
          }
          if (!contain(src, d + 1, next)) {
            truncated = true;
            break bfs;
          }
        }
      }
    }
    frontier = next;
  }
  const { rows, nodes, rowEdges } = foldRows(
    reached,
    rowAt,
    foldInto,
    nodeOf,
    edges,
    links,
    displayAs,
  );
  const found = store.getNode(orgId, qname) !== null || edges.length > 0 || filtered > 0;
  return { nodes, edges, truncated, filtered, reached: rows, structural, found, rowEdges };
}
