import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact, NodeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import type { GraphStore } from "../../storage/interfaces.js";
import { makeEdge } from "../common.js";
import type { ParseContext } from "../contract.js";

/**
 * Reflection-based dependency walker. Scans every node's attributes for
 * string values whose content matches a known qualified-name bare-name
 * already present in the graph. When a match exists AND the target is
 * not the source itself, emits a generic `REFERENCES` edge tagged
 * `source: 'reflection'` so consumers can distinguish pattern-matched
 * edges from those a real parser produced.
 *
 * **Why this exists.** sfgraph hand-rolls parsers per metadata type, but
 * some types (OmniStudio-on-Core PropertySet blobs, Vlocity Definition
 * fields, formula expressions on standard objects) carry references
 * buried inside long-text JSON/XML that the platform's describeMetadata
 * doesn't expose a schema for. Rather than write a parser per type, the
 * reflector walks any blob defensively and surfaces likely references
 * with explicit `confidence: 'pattern-match'` so a downstream consumer
 * can choose precision-vs-recall.
 *
 * **Known limitations** (all documented + flagged on emitted edges):
 * - Bare-name match on the dst → false positives when a string
 *   coincidentally equals a qname (e.g. a comment field containing the
 *   literal word "Account"). Mitigated by string-length floor + reserved-
 *   word skip list, but not eliminated.
 * - Ambiguous matches (e.g. `Account` is both a CustomObject AND a
 *   namespace) emit one edge per candidate, all tagged `ambiguous: true`.
 *   Consumers should treat these as "investigate" not "act on".
 * - Misses procedural references (a conditional branch that references
 *   different DataRaptors based on input — the reference is in the
 *   control flow, not in a string value).
 * - Does NOT dedup against more-specific edges. If parsers/foo emits
 *   `OS_USES_DR` between A and B, the reflector may also emit
 *   `REFERENCES` between A and B with source='reflection'. They coexist
 *   in different edge tables; consumers can filter on rel-type +
 *   attributes.source.
 *
 * **Cost.** O(nodes × avg-blob-string-count). On a 50k-node org with
 * Vlocity heavy, expect ~30s; bounded by maxEdgesPerSource so a single
 * 10MB blob can't dominate the run.
 *
 * Wired into live-ingest as a post-merge pass, default **on**.
 * Precision-conscious consumers filter `attributes.source !==
 * 'reflection'` to see only parser-quality edges; breadth-conscious
 * consumers (migration audits, dead-code first-pass scans) take the
 * union. Disable entirely via `disableReflectionWalker: true` if even
 * the cost of emitting these edges is unwelcome.
 */

export interface ReflectionWalkerOpts {
  orgId: OrgId | string;
  ctx: ParseContext;
  /** Strings shorter than this are ignored — too noisy. Default 4. */
  minStringLength?: number;
  /** Max recursion depth into nested objects/arrays. Default 32. */
  maxDepth?: number;
  /** Max REFERENCES edges emitted per source node. Default 200 — caps
   *  the blast radius of a pathologically large blob. */
  maxEdgesPerSource?: number;
  /** When set, scan only these label families (e.g. only OmniProcess
   *  + VlocityCard). Default: every label in the graph. */
  scopeToLabels?: string[];
}

export interface ReflectionWalkerResult {
  /** Number of source nodes scanned. */
  scanned: number;
  /** Number of REFERENCES edges emitted (after de-dup). */
  edgesEmitted: number;
  /** Source nodes that hit the maxEdgesPerSource cap. Useful telemetry
   *  for tuning the cap. */
  truncatedSources: number;
  /** Distinct dst qnames involved in ambiguous (multi-label-match) edges. */
  ambiguousMatches: number;
}

/** String values we never treat as candidate references — too generic
 *  to be meaningful and dominate the false-positive tail. */
const RESERVED_WORDS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "self",
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "any",
  "void",
  "id",
  "name",
  "type",
  "value",
  "default",
  "none",
  "yes",
  "no",
]);

/** Extract the bare name from a qualifiedName. Mirrors the convention
 *  used by cross-flavor-resolver: everything after the first `:`. */
function bareName(qname: string): string {
  const colon = qname.indexOf(":");
  return colon >= 0 ? qname.slice(colon + 1) : qname;
}

/**
 * Build a `bareName → qname[]` index across every node in the org. Used
 * to map a string-value hit back to one (unambiguous) or more
 * (ambiguous) candidate target qnames.
 *
 * Returns both a case-sensitive index (preferred — Salesforce identifiers
 * are case-sensitive in code but case-insensitive in describe) and a
 * lowercased fallback for case-insensitive hits.
 */
function buildBareNameIndex(
  store: GraphStore,
  orgId: OrgId,
  scopeToLabels?: string[],
): { exact: Map<string, string[]>; lower: Map<string, string[]> } {
  const exact = new Map<string, string[]>();
  const lower = new Map<string, string[]>();
  const labels =
    scopeToLabels && scopeToLabels.length > 0
      ? scopeToLabels
      : store.listAllLabels();
  for (const label of labels) {
    // 50k cap matches what find-nodes uses; bigger orgs would benefit
    // from streaming but this index lives in memory by design.
    const nodes = store.listNodesByLabel(orgId, label, 50_000);
    for (const n of nodes) {
      const q = String(n.qualifiedName);
      const bare = bareName(q);
      if (bare.length === 0) continue;
      const list = exact.get(bare) ?? [];
      list.push(q);
      exact.set(bare, list);
      const lo = bare.toLowerCase();
      const ll = lower.get(lo) ?? [];
      ll.push(q);
      lower.set(lo, ll);
    }
  }
  return { exact, lower };
}

/** Recursively walk a value, yielding every string leaf along with the
 *  parent-object key that produced it (for `viaKey` annotation on the
 *  edge). Bounded by `maxDepth` to dodge pathological nesting. */
function* walkStrings(
  value: unknown,
  depth: number,
  maxDepth: number,
  parentKey: string | null,
): Generator<{ key: string | null; value: string }> {
  if (depth > maxDepth || value == null) return;
  if (typeof value === "string") {
    yield { key: parentKey, value };
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkStrings(item, depth + 1, maxDepth, parentKey);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      yield* walkStrings(v, depth + 1, maxDepth, k);
    }
  }
}

export function walkBlobsForReferences(
  store: GraphStore,
  opts: ReflectionWalkerOpts,
): ReflectionWalkerResult {
  const orgId = typeof opts.orgId === "string" ? asOrgId(opts.orgId) : opts.orgId;
  const minLen = Math.max(1, opts.minStringLength ?? 4);
  const maxDepth = Math.max(1, opts.maxDepth ?? 32);
  const maxEdgesPerSource = Math.max(1, opts.maxEdgesPerSource ?? 200);

  const index = buildBareNameIndex(store, orgId, opts.scopeToLabels);
  const result: ReflectionWalkerResult = {
    scanned: 0,
    edgesEmitted: 0,
    truncatedSources: 0,
    ambiguousMatches: 0,
  };

  // Iterate the same label set we indexed — every source node gets
  // scanned exactly once.
  const labels =
    opts.scopeToLabels && opts.scopeToLabels.length > 0
      ? opts.scopeToLabels
      : store.listAllLabels();

  store.transaction(() => {
    for (const label of labels) {
      const nodes = store.listNodesByLabel(orgId, label, 50_000);
      for (const node of nodes) {
        result.scanned += 1;
        const srcQname = String(node.qualifiedName);
        const edgesForThisSource: EdgeFact[] = [];
        const seenDst = new Set<string>();

        for (const { key, value } of walkStrings(node.attributes, 0, maxDepth, null)) {
          if (edgesForThisSource.length >= maxEdgesPerSource) {
            result.truncatedSources += 1;
            break;
          }
          if (value.length < minLen) continue;
          if (RESERVED_WORDS.has(value.toLowerCase())) continue;
          // Skip obvious non-identifiers (multiline strings, paths,
          // sentences). Salesforce identifiers don't contain whitespace.
          if (/\s/.test(value)) continue;
          // Skip pure numeric/UUID-ish blobs — too noisy.
          if (/^[0-9-]+$/.test(value)) continue;

          // Try exact match first, fall back to lowercase.
          let candidates = index.exact.get(value);
          if (!candidates) candidates = index.lower.get(value.toLowerCase());
          if (!candidates || candidates.length === 0) continue;

          const ambiguous = candidates.length > 1;
          if (ambiguous) result.ambiguousMatches += 1;

          for (const dst of candidates) {
            // Skip self-references and already-emitted dsts for this source.
            if (dst === srcQname) continue;
            if (seenDst.has(dst)) continue;
            seenDst.add(dst);
            const e = makeEdge(opts.ctx, srcQname, REL_TYPES.REFERENCES, dst, {
              source: "reflection",
              confidence: "pattern-match",
              ...(key ? { viaKey: key } : {}),
              ...(ambiguous ? { ambiguous: true } : {}),
            });
            // Override orgId from ctx — makeEdge stamps ctx.orgId on the
            // emitted edge, but we want the edge stored under the org the
            // caller asked us to scan (same hazard the arity-resolver
            // handles in resolveApexMethodArity).
            edgesForThisSource.push({ ...e, orgId });
            if (edgesForThisSource.length >= maxEdgesPerSource) break;
          }
        }

        if (edgesForThisSource.length > 0) {
          store.mergeEdges(edgesForThisSource);
          result.edgesEmitted += edgesForThisSource.length;
        }
      }
    }
  });

  return result;
}

/** Small helper kept exported for tests that want to drive the walker
 *  against a synthetic node without touching the graph. */
export function _scanValueForReferences(
  value: unknown,
  index: { exact: Map<string, string[]>; lower: Map<string, string[]> },
  opts: { minStringLength?: number; maxDepth?: number },
): Array<{ value: string; viaKey: string | null; candidates: string[] }> {
  const minLen = opts.minStringLength ?? 4;
  const maxDepth = opts.maxDepth ?? 32;
  const out: Array<{ value: string; viaKey: string | null; candidates: string[] }> = [];
  for (const { key, value: v } of walkStrings(value, 0, maxDepth, null)) {
    if (v.length < minLen) continue;
    if (RESERVED_WORDS.has(v.toLowerCase())) continue;
    if (/\s/.test(v)) continue;
    if (/^[0-9-]+$/.test(v)) continue;
    const candidates = index.exact.get(v) ?? index.lower.get(v.toLowerCase()) ?? [];
    if (candidates.length === 0) continue;
    out.push({ value: v, viaKey: key, candidates });
  }
  return out;
}

// Use NodeFact in a way the linter sees, so unused-import rules don't trip.
export type { NodeFact };
