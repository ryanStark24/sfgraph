import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import type { RelType } from "./rel-types.js";

/**
 * Optional source-location citation attached to an edge. When set, downstream
 * consumers can answer "why does X depend on Y" by pointing at a specific
 * file (and line/column when the parser walked an AST with positions).
 *
 * Stored inside `attributes` rather than as top-level columns so adding
 * provenance doesn't require a schema migration on existing edge tables.
 * Mirrors how nodes carry `attributes.sourceUri` via makeNode in
 * `parsers/common.ts`. See EdgeProvenance type for the read shape.
 */
export interface EdgeProvenance {
  /** Absolute URI / path of the source artifact the edge was parsed from. */
  sourceUri?: string;
  /** 1-indexed line of the producing token, when the parser had AST positions. */
  line?: number;
  /** 1-indexed column of the producing token. */
  column?: number;
}

export interface EdgeFact {
  orgId: OrgId;
  srcQualifiedName: QualifiedName;
  dstQualifiedName: QualifiedName;
  relType: RelType;
  /**
   * Edge attributes. Provenance fields `sourceUri`, `line`, `column` may be
   * populated automatically by `makeEdge` (from ParseContext.sourceUri); the
   * EdgeProvenance type documents that subset. Parsers can also write
   * relation-specific attributes (e.g. `dynamic: true`, `signaturesMatch:
   * false`, `source: 'mcd'`).
   */
  attributes: Record<string, unknown>;
  firstSeenAt: number;
  lastSeenAt: number;
}
