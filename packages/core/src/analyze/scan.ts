import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * How much of the graph an audit scan looked at. `complete` is true only when
 * every node in scope (the labels and name filter the scan was asked for) was
 * examined. A result that is not complete says "no findings in the `scanned`
 * of `total` inspected", never "no findings".
 */
export interface ScanCoverage {
  /** Nodes examined. */
  scanned: number;
  /** Nodes in scope (selected labels, name filter applied). */
  total: number;
  complete: boolean;
}

export const COMPLETE_EMPTY: ScanCoverage = { scanned: 0, total: 0, complete: true };

/** Rows read per page. Memory stays bounded by this, not by the size of the graph. */
export const SCAN_PAGE_SIZE = 500;

/**
 * Safety limits of the audit scans. The scans page to completion, so these
 * only stop a runaway: past `maxNodesPerLabel` nodes of one label the scan
 * stops and reports itself incomplete (scanned < total). Exposed so a test can
 * lower it; production code does not change it.
 */
export const scanLimits: { maxNodesPerLabel: number } = { maxNodesPerLabel: 5_000_000 };

export function sumCoverage(parts: readonly ScanCoverage[]): ScanCoverage {
  let scanned = 0;
  let total = 0;
  let complete = true;
  for (const p of parts) {
    scanned += p.scanned;
    total += p.total;
    if (!p.complete) complete = false;
  }
  return { scanned, total, complete };
}

/**
 * Turn a user name filter into a SQL LIKE pattern (`\` escapes): a plain
 * string is a prefix, `*` and `?` are the glob wildcards (whole-string match).
 * The result is a superset filter for the store (ASCII case-insensitive); the
 * caller's exact matcher still runs on what comes back.
 */
export function nameLikePattern(pattern: string): string {
  const esc = (c: string): string => (c === "%" || c === "_" || c === "\\" ? `\\${c}` : c);
  const glob = /[*?]/.test(pattern);
  let out = "";
  for (const c of pattern) out += c === "*" ? "%" : c === "?" && glob ? "_" : esc(c);
  return glob ? out : `${out}%`;
}

/**
 * Every node of `label` (matching `nameLike` when given), one page at a time
 * by keyset pagination over the store's insertion order, so memory is bounded
 * by the page size. `coverage()` is read after the iteration: scanned, total
 * and whether the safety limit cut it short.
 */
export function scanLabel(
  store: GraphStore,
  orgId: OrgId,
  label: string,
  opts: { nameLike?: string; pageSize?: number } = {},
): { pages: Generator<NodeFact[]>; coverage: () => ScanCoverage } {
  const pageSize = opts.pageSize ?? SCAN_PAGE_SIZE;
  const cap = scanLimits.maxNodesPerLabel;
  let scanned = 0;
  let done = false;
  const total = (): number => {
    if (done && scanned < cap) return scanned;
    if (store.countNodesLike) return store.countNodesLike(orgId, label, opts.nameLike);
    return store.countNodesByLabel(orgId, label);
  };
  function* pages(): Generator<NodeFact[]> {
    if (store.listNodesPage) {
      let after: number | undefined;
      while (scanned < cap) {
        const page = store.listNodesPage(orgId, label, {
          ...(after !== undefined ? { afterRowid: after } : {}),
          limit: Math.min(pageSize, cap - scanned),
          ...(opts.nameLike !== undefined ? { nameLike: opts.nameLike } : {}),
        });
        if (page.nodes.length === 0 || page.lastRowid === null) {
          done = true;
          return;
        }
        after = page.lastRowid;
        scanned += page.nodes.length;
        yield page.nodes;
      }
      // Stopped at the cap: complete only if nothing is left after it.
      const rest = store.listNodesPage(orgId, label, {
        ...(after !== undefined ? { afterRowid: after } : {}),
        limit: 1,
        ...(opts.nameLike !== undefined ? { nameLike: opts.nameLike } : {}),
      });
      done = rest.nodes.length === 0;
      return;
    }
    // A store without keyset pages: one read, bounded by the safety limit. The
    // name filter is the caller's (it re-applies its exact matcher).
    const all = store.listNodesByLabel(orgId, label, cap + 1);
    done = all.length <= cap;
    const nodes = all.slice(0, cap);
    scanned = nodes.length;
    for (let i = 0; i < nodes.length; i += pageSize) yield nodes.slice(i, i + pageSize);
  }
  return {
    pages: pages(),
    coverage: () => {
      const t = total();
      return { scanned, total: Math.max(t, scanned), complete: done && scanned >= t };
    },
  };
}

/**
 * `*` / `?` glob match in O(len(pattern) * len(text)) worst case with no
 * regex backtracking (audit sec-01: `.*`-per-star regexes went polynomial
 * on patterns like `*?*?*?*?!`). Inputs are already lower-cased.
 */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const pc = pattern[p];
    if (pc !== undefined && pc !== "*" && (pc === "?" || pc === text[t])) {
      p++;
      t++;
    } else if (pc === "*") {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Case-insensitive matcher: a glob (`*`, `?`) must match the whole string;
 *  a plain string is a prefix. */
export function globMatcher(glob: string): (s: string) => boolean {
  const g = glob.toLowerCase();
  if (!/[*?]/.test(g)) return (s) => s.toLowerCase().startsWith(g);
  return (s) => wildcardMatch(g, s.toLowerCase());
}

/** A scan filter: node label (case-insensitive) and name pattern (prefix or glob). */
export interface ScanFilter {
  label?: string | undefined;
  pattern?: string | undefined;
}

/**
 * Does `qname` pass the filter: its label equals `label`, and the pattern
 * matches the whole qname or the part after `Label:`.
 */
export function makeScanFilter(filter: ScanFilter): (qname: string) => boolean {
  const label = filter.label?.toLowerCase();
  const match = filter.pattern ? globMatcher(filter.pattern) : undefined;
  return (qname: string): boolean => {
    const i = qname.indexOf(":");
    if (label && (i > 0 ? qname.slice(0, i) : "").toLowerCase() !== label) return false;
    if (match && !match(qname) && !match(i >= 0 ? qname.slice(i + 1) : qname)) return false;
    return true;
  };
}
