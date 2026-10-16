import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";
import { type TraversalContainmentRule, traversalMembers, traversalOwner } from "./containment.js";
import {
  type ReachedEntry,
  type RowEdge,
  TRAVERSAL_NODE_CAP_DEFAULT,
  type TraversalOpts,
  type TraversalResult,
  containmentAllowed,
  foldRows,
} from "./dependents.js";
import { isStructuralEdge, keepEdge, labelOfQname } from "./edge-filters.js";

function nodeCap(): number {
  const raw = process.env.SFGRAPH_TRAVERSAL_NODE_CAP;
  if (!raw) return TRAVERSAL_NODE_CAP_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : TRAVERSAL_NODE_CAP_DEFAULT;
}

export interface DependencyTraversalOpts extends TraversalOpts {
  /**
   * Containment is not a dependency: do not expand a reached (non-root)
   * CustomObject / CustomField / ValidationRule / RecordType / NamedCredential
   * along structural edges (DEFINES_FIELD, HAS_VALIDATION_RULE,
   * HAS_RECORD_TYPE, field -> field READS_FIELD, ...). The node itself is
   * kept as a leaf. Default false (full expansion, legacy behaviour).
   */
  leafStructure?: boolean;
  /**
   * Apex counts at class granularity: when an ApexMethod is reached, its
   * owning ApexClass (via CONTAINS_METHOD) and the class's other methods are
   * reached at the same hop, and traversal continues from them. Default false.
   * (With it a reached class also reaches its methods at the same hop; the
   * root's own members are always hop-0 root members, and Flow / LWCBundle
   * containment is always zero-cost; see containment.ts.)
   */
  rollupApexClass?: boolean;
}

export function findDependencies(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
  depth = 3,
  opts: DependencyTraversalOpts = {},
): TraversalResult {
  const cap = nodeCap();
  const visited = new Set<string>();
  const nodeOf = new Map<string, NodeFact>();
  const edges: EdgeFact[] = [];
  const reached: ReachedEntry[] = [];
  const rowAt = new Map<string, number>();
  /** Folded qname -> the qname whose row stands for it (containment.ts `row`). */
  const foldInto = new Map<string, string>();
  /** Containment links (owner -> member) for `rowEdges`. */
  const links: RowEdge[] = [];
  visited.add(qname);
  let truncated = false;
  let filtered = 0;
  let structural = 0;

  /** Mark `q` reached at `hop`; returns false when the node cap is hit. */
  const visit = (
    q: QualifiedName,
    hop: number,
    relType: string,
    next: QualifiedName[],
    via?: ReachedEntry["via"],
    role?: ReachedEntry["role"],
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
      ...(role ? { role } : {}),
    });
    next.push(q);
    return visited.size < cap;
  };

  const viaFor = (rule: TraversalContainmentRule): ReachedEntry["via"] =>
    rule.row === "both" ? "class-rollup" : "contained";

  /**
   * Containment costs no hop (containment.ts): a newly visited owner reaches
   * its members at the same hop, and a newly visited member reaches its owner
   * (Apex only with `rollupApexClass`) and the owner's other members. The
   * root's own members are hop-0 `root-member` rows; the root's owner is not
   * followed (a method seed is not its class).
   */
  const contain = (
    q: QualifiedName,
    hop: number,
    next: QualifiedName[],
    isRoot: boolean,
  ): boolean => {
    const { members, rule } = traversalMembers(store, orgId, q);
    // Apex class granularity is opt-in (`rollupApexClass`): without it a
    // reached (non-root) class does not pull in its methods (review M5);
    // Flow / LWC containment always folds.
    const expandMembers = isRoot || rule?.row !== "both" || opts.rollupApexClass === true;
    if (rule && expandMembers && containmentAllowed(rule, opts)) {
      for (const m of members) {
        links.push({ srcQualifiedName: q, dstQualifiedName: m, relType: rule.relType });
        if (visited.has(m)) continue;
        if (isRoot) {
          if (!visit(m, 0, rule.relType, next, undefined, "root-member")) return false;
          continue;
        }
        if (!visit(m, hop, rule.relType, next, viaFor(rule))) return false;
        if (rule.row === "owner") foldInto.set(m, q);
        else if (rule.row === "member" && !foldInto.has(q)) foldInto.set(q, m);
      }
    }
    if (isRoot) return true;
    const own = traversalOwner(store, orgId, q);
    if (!own || !containmentAllowed(own.rule, opts)) return true;
    if (own.rule.row === "both" && !opts.rollupApexClass) return true;
    const o = own.owner;
    links.push({ srcQualifiedName: o, dstQualifiedName: q, relType: own.rule.relType });
    if (own.rule.row === "owner" && rowAt.has(o)) foldInto.set(q, o);
    if (visited.has(o)) return true;
    if (!visit(o, hop, own.rule.relType, next, viaFor(own.rule))) return false;
    if (own.rule.row === "owner") foldInto.set(q, o);
    else if (own.rule.row === "member") foldInto.set(o, q);
    return contain(o, hop, next, false);
  };

  let frontier: QualifiedName[] = [qname];
  if (!contain(qname, 0, frontier, true)) truncated = true;

  bfs: for (let d = 0; d < depth && frontier.length > 0 && !truncated; d++) {
    const next: QualifiedName[] = [];
    for (const cur of frontier) {
      const outgoing = store.listEdgesFrom(orgId, cur);
      for (const e of outgoing) {
        if (!keepEdge(e, opts)) {
          filtered += 1;
          continue;
        }
        if (opts.leafStructure && d > 0 && isStructuralEdge(e)) {
          structural += 1;
          continue;
        }
        edges.push(e);
        if (!visited.has(e.dstQualifiedName)) {
          const dst = e.dstQualifiedName;
          if (!visit(dst, d + 1, e.relType, next) || !contain(dst, d + 1, next, false)) {
            truncated = true;
            break bfs;
          }
        }
      }
    }
    frontier = next;
  }
  const { rows, nodes, rowEdges } = foldRows(reached, rowAt, foldInto, nodeOf, edges, links);
  const found = store.getNode(orgId, qname) !== null || edges.length > 0 || filtered > 0;
  return { nodes, edges, truncated, filtered, reached: rows, structural, found, rowEdges };
}
