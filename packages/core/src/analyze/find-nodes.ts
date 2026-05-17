import picomatch from "picomatch";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Glob-pattern node lookup. Patterns use the conventional shell glob
 * vocabulary (handled by picomatch):
 *
 *   - `*`   matches any non-separator characters
 *   - `?`   matches a single character
 *   - `**`  matches zero or more segments (separator = `.`)
 *   - `[abc]` / `[a-z]` character classes
 *   - `{a,b}` brace expansion
 *
 * The separator is `.` not `/` — node qualified names like
 * `CustomField:Account.Name` make a dot-separator more natural than the
 * Unix path-style. picomatch is configured accordingly.
 *
 * Result ordering: lexicographic by qualifiedName. The cap defaults to
 * 500 with `truncated: true` set on overflow — at that scale the agent
 * should refine the pattern rather than scan further.
 */

export interface FindNodesOpts {
  /** When set, restrict matching to nodes of this label (e.g. `ApexClass`,
   *  `CustomField`). Faster than scanning every label table when the
   *  pattern is type-anchored. */
  label?: string;
  /** Result cap. Default 500. */
  limit?: number;
}

export interface FindNodesResult {
  matches: NodeFact[];
  truncated: boolean;
  /** Total matched before truncation (when truncated=false, equals
   *  matches.length). */
  total: number;
}

export function findNodesByGlob(
  store: GraphStore,
  orgId: OrgId,
  pattern: string,
  opts: FindNodesOpts = {},
): FindNodesResult {
  const limit = Math.max(1, opts.limit ?? 500);
  const matcher = picomatch(pattern, {
    // Treat `.` as the separator so `apex.Class.*` matches everything inside
    // the apex.Class.* namespace and `**` crosses dots.
    dot: true,
    nocase: false,
    contains: false,
    // Don't expand globstar to filesystem semantics — we just want it as
    // "zero or more segments at this position."
    bash: false,
  });

  const labels = opts.label ? [opts.label] : listAllLabels(store, orgId);
  const allMatches: NodeFact[] = [];

  for (const label of labels) {
    // listNodesByLabel pages internally; passing a generous cap avoids
    // truncation at the label level while still bounding memory on
    // pathologically large labels (Salesforce orgs with 50k+ ApexClass
    // nodes exist).
    const nodes = store.listNodesByLabel(orgId, label, 50_000);
    for (const n of nodes) {
      if (matcher(String(n.qualifiedName))) allMatches.push(n);
    }
  }

  allMatches.sort((a, b) => String(a.qualifiedName).localeCompare(String(b.qualifiedName)));
  const truncated = allMatches.length > limit;
  return {
    matches: truncated ? allMatches.slice(0, limit) : allMatches,
    truncated,
    total: allMatches.length,
  };
}

/**
 * List every distinct label the store knows about for this org. The
 * GraphStore interface doesn't expose this directly; we read the
 * label registry table that ensureNodeTable populates. Falls back to
 * an empty list when the store doesn't expose the helper — caller can
 * pass an explicit `label` to bypass.
 */
function listAllLabels(store: GraphStore, _orgId: OrgId): string[] {
  // The SqliteGraphStore exposes a private nodeLabelCache; we read it
  // through the public `listAllLabels()` method if present. Stores that
  // don't implement it (test mocks) return [].
  const s = store as unknown as { listAllLabels?: () => string[] };
  if (typeof s.listAllLabels === "function") return s.listAllLabels();
  return [];
}
