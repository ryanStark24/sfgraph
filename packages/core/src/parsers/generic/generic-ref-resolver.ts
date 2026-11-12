import { type OrgId, asOrgId, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { type EdgeFact, type NodeFact, REL_TYPES, type RelType } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";
import type { GenericRefCandidate, GenericRefKind } from "./ref-scanner.js";

/**
 * Post-merge resolver for the generic reference scanner. Reads the bounded
 * `genericRefs` candidate list the opaque parser left on a node, checks each
 * candidate against the real node index, and emits an edge only when a node
 * matches. Candidates that match nothing are dropped: no dangling edges.
 *
 * Edge kinds (one per target kind; edge tables are created on first use, so
 * no storage schema change):
 *   GENERIC_REFERENCES_APEX   -> ApexClass:<n> | ApexInterface:<n>
 *   GENERIC_REFERENCES_FLOW   -> Flow:<n>
 *   GENERIC_REFERENCES_OBJECT -> CustomObject:<n>
 *   GENERIC_REFERENCES_FIELD  -> CustomField:<Obj>.<Field>
 * Attributes: `via` (element path), `confidence: 'heuristic'`,
 * `source: 'generic-scan'`, `targetKind`.
 *
 * Idempotent and self-reconciling: a source's edges are re-derived from its
 * candidates every run and any generic edge it no longer earns (the target was
 * removed, the candidate went away) is deleted, so a delta ingest can run it at
 * full scope and match what a rebuild would produce.
 */

export const GENERIC_REL_TYPES: readonly RelType[] = [
  REL_TYPES.GENERIC_REFERENCES_APEX,
  REL_TYPES.GENERIC_REFERENCES_FLOW,
  REL_TYPES.GENERIC_REFERENCES_OBJECT,
  REL_TYPES.GENERIC_REFERENCES_FIELD,
];

export const GENERIC_EDGE_SOURCE = "generic-scan";
/** Node attribute holding the scanner's candidates. */
export const GENERIC_REFS_ATTR = "genericRefs";

type TargetKind = "apex" | "flow" | "object" | "field";

const REL_FOR: Record<TargetKind, RelType> = {
  apex: REL_TYPES.GENERIC_REFERENCES_APEX,
  flow: REL_TYPES.GENERIC_REFERENCES_FLOW,
  object: REL_TYPES.GENERIC_REFERENCES_OBJECT,
  field: REL_TYPES.GENERIC_REFERENCES_FIELD,
};

/** Node-label prefixes a candidate of each kind can resolve to, in priority order. */
const PREFIXES: Record<TargetKind, readonly string[]> = {
  apex: ["ApexClass", "ApexInterface"],
  flow: ["Flow"],
  object: ["CustomObject"],
  field: ["CustomField"],
};

const KIND_TARGETS: Record<GenericRefKind, readonly TargetKind[]> = {
  apex: ["apex"],
  flow: ["flow"],
  object: ["object"],
  field: ["field"],
  name: ["apex", "flow", "object"],
};

export interface GenericRefResolveOpts {
  orgId: OrgId | string;
  ctx: ParseContext;
  /** Delete generic edges a source no longer earns (default true). */
  reconcile?: boolean;
  /** Cap on edges per source (default 200, the candidate cap). */
  maxEdgesPerSource?: number;
}

export interface GenericRefResolveResult {
  /** Sources (nodes carrying candidates) examined. */
  scanned: number;
  edgesEmitted: number;
  /** Candidates that matched no node and were dropped. */
  dropped: number;
  /** Stale generic edges removed. */
  removed: number;
  /** Per source label (= metadata type): how many sources got at least one edge. */
  withEdgesByLabel: Record<string, number>;
}

type MaybeProbeStore = GraphStore & {
  findNodesMentioning?(orgId: OrgId, needles: readonly string[]): Set<string>;
  existingQnamesNocase?(orgId: OrgId, qnames: Iterable<string>): Set<string>;
};

function readCandidates(node: NodeFact): GenericRefCandidate[] {
  const raw = (node.attributes as Record<string, unknown>)[GENERIC_REFS_ATTR];
  if (!Array.isArray(raw)) return [];
  const out: GenericRefCandidate[] = [];
  for (const c of raw) {
    const r = c as Partial<GenericRefCandidate> | null;
    if (r && typeof r.k === "string" && typeof r.n === "string" && r.n) {
      out.push({ k: r.k as GenericRefKind, n: r.n, p: typeof r.p === "string" ? r.p : "" });
    }
  }
  return out;
}

/** Sources: nodes that carry candidates. SQL probe when the store has one. */
function* sourceNodes(store: MaybeProbeStore, orgId: OrgId): Generator<NodeFact> {
  if (typeof store.findNodesMentioning === "function") {
    for (const q of store.findNodesMentioning(orgId, [GENERIC_REFS_ATTR])) {
      const n = store.getNode(orgId, asQualifiedName(q));
      if (n && Array.isArray((n.attributes as Record<string, unknown>)[GENERIC_REFS_ATTR])) {
        yield n;
      }
    }
    return;
  }
  for (const label of store.listAllLabels()) {
    for (const n of store.listNodesByLabel(orgId, label)) {
      if (Array.isArray((n.attributes as Record<string, unknown>)[GENERIC_REFS_ATTR])) yield n;
    }
  }
}

export function resolveGenericReferences(
  store: GraphStore,
  opts: GenericRefResolveOpts,
): GenericRefResolveResult {
  const s = store as MaybeProbeStore;
  const orgId = typeof opts.orgId === "string" ? asOrgId(opts.orgId) : opts.orgId;
  const reconcile = opts.reconcile !== false;
  const cap = Math.max(1, opts.maxEdgesPerSource ?? 200);
  const result: GenericRefResolveResult = {
    scanned: 0,
    edgesEmitted: 0,
    dropped: 0,
    removed: 0,
    withEdgesByLabel: {},
  };

  /** lower-cased qname -> stored spelling, or null when no such node. */
  const known = new Map<string, string | null>();
  const resolveQnames = (qnames: string[]): void => {
    const need = [...new Set(qnames)].filter((q) => !known.has(q.toLowerCase()));
    if (need.length === 0) return;
    if (typeof s.existingQnamesNocase === "function") {
      const found = s.existingQnamesNocase(orgId, need);
      for (const f of found) known.set(f.toLowerCase(), f);
      for (const q of need) if (!known.has(q.toLowerCase())) known.set(q.toLowerCase(), null);
      return;
    }
    for (const q of need) {
      const n = store.getNode(orgId, asQualifiedName(q));
      known.set(q.toLowerCase(), n ? String(n.qualifiedName) : null);
    }
  };

  store.transaction(() => {
    // Lazy: one node (<= ~30 KB of candidates) in memory at a time.
    for (const node of sourceNodes(s, orgId)) {
      result.scanned += 1;
      const src = String(node.qualifiedName);
      const cands = readCandidates(node);

      // Every qname any candidate could resolve to, checked in one batch.
      const want: string[] = [];
      for (const c of cands) {
        for (const tk of KIND_TARGETS[c.k] ?? []) {
          for (const pre of PREFIXES[tk]) want.push(`${pre}:${c.n}`);
        }
      }
      resolveQnames(want);

      const edges: EdgeFact[] = [];
      const emitted = new Set<string>();
      for (const c of cands) {
        let matched = false;
        for (const tk of KIND_TARGETS[c.k] ?? []) {
          for (const pre of PREFIXES[tk]) {
            const dst = known.get(`${pre}:${c.n}`.toLowerCase());
            if (!dst) continue;
            matched = true;
            if (dst.toLowerCase() === src.toLowerCase()) break;
            const key = `${REL_FOR[tk]}|${dst.toLowerCase()}`;
            if (emitted.has(key) || edges.length >= cap) break;
            emitted.add(key);
            const e = makeEdge(opts.ctx, src, REL_FOR[tk], dst, {
              via: c.p,
              confidence: "heuristic",
              source: GENERIC_EDGE_SOURCE,
              targetKind: tk,
            });
            edges.push({ ...e, orgId });
            break; // first label that exists wins (ApexClass before ApexInterface)
          }
        }
        if (!matched) result.dropped += 1;
      }

      if (reconcile) {
        for (const rel of GENERIC_REL_TYPES) {
          for (const old of store.listEdgesFrom(orgId, node.qualifiedName, rel)) {
            if (!emitted.has(`${rel}|${String(old.dstQualifiedName).toLowerCase()}`)) {
              store.deleteEdge(orgId, node.qualifiedName, old.dstQualifiedName, rel);
              result.removed += 1;
            }
          }
        }
      }
      if (edges.length > 0) {
        store.mergeEdges(edges);
        result.edgesEmitted += edges.length;
        result.withEdgesByLabel[node.label] = (result.withEdgesByLabel[node.label] ?? 0) + 1;
      }
    }
  });
  return result;
}
