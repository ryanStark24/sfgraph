import { asOrgId } from "@ryanstark24/sfgraph-shared";
import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { EdgeFact } from "../../../domain/index.js";
import { REL_TYPES } from "../../../domain/index.js";
import { makeEdge, stripNs } from "../../../parsers/common.js";
import type { ParseContext } from "../../../parsers/contract.js";
import { scheduleQuery, soqlWithTimeout } from "../rate-limit.js";

/**
 * Fast-path baseline coverage for long-tail metadata via the Tooling
 * `MetadataComponentDependency` SObject (MCD). The platform pre-computes
 * dependency edges for ~50 component types; sfgraph hand-rolls parsers for
 * ~20 of them. For the rest (Layouts, FieldSets, EmailTemplates, Tabs,
 * Groups, Queues to start) MCD is the path of least resistance — one
 * Tooling SOQL per type-direction, zero parser code, edges immediately
 * available.
 *
 * Coexistence with parsed edges: every MCD-sourced edge uses relType
 * `REFERENCES` with `attributes.source: 'mcd'`. Real parsers emit more
 * specific relTypes (READS_FIELD, INVOKES_FLOW, etc.) which live in
 * different edge tables — so parsed and MCD edges coexist rather than
 * compete. Consumers wanting MCD-only coverage filter on the source
 * attribute; consumers wanting "all known dependencies" union both.
 *
 * Known caveats (from Pitfalls research):
 * - MCD enforces a 2,000-row hard cap per query with no OFFSET — we
 *   paginate via `MetadataComponentId > '<lastId>'` ordered ascending.
 * - MCD has async-refresh lag (minutes between metadata change and MCD
 *   reflecting it). Three documented gap classes (lookup-field → object,
 *   picklist → GlobalValueSet, dependent-picklist → controlling-field)
 *   are missing entirely; those are W2-04's job, not this baseline.
 * - Some types (e.g. CustomLabels) show no rows on certain orgs even
 *   when usage exists — this is a platform issue, surfaced as zero
 *   edges rather than an error.
 */

/** Long-tail metadata types covered by the baseline. Each gets one query
 *  in each direction (component-as-source, component-as-target) so any
 *  edge involving a long-tail type lands in the graph. */
export const MCD_LONG_TAIL_TYPES = [
  "Layout",
  "FieldSet",
  "EmailTemplate",
  "CustomTab",
  "Group",
  "Queue",
] as const;

interface McdRow {
  Id: string;
  MetadataComponentId: string;
  MetadataComponentType: string;
  MetadataComponentName: string;
  MetadataComponentNamespace: string | null;
  RefMetadataComponentId: string;
  RefMetadataComponentType: string;
  RefMetadataComponentName: string;
  RefMetadataComponentNamespace: string | null;
}

export interface McdBaselineOpts {
  orgId: OrgId | string;
  ctx: ParseContext;
  /** Types to query. Defaults to MCD_LONG_TAIL_TYPES. */
  types?: readonly string[];
  /** Override the per-query LIMIT cap. Defaults to 2000 (platform-enforced
   *  ceiling). Lower values are useful for tests. */
  pageSize?: number;
  /** Maximum pages per (type, direction) pair to fetch before bailing
   *  out — defensive bound against an over-broad org with millions of
   *  rows. Default 50 pages → 100k edges per direction. */
  maxPagesPerDirection?: number;
  /** Called on each non-fatal failure (per-type query error). Mirrors
   *  the vlocity-runner onError contract added in W1-01. */
  onError?: (label: string, err: Error) => void;
}

export interface McdBaselineResult {
  edges: EdgeFact[];
  /** Per-(type, direction) row counts for visibility. */
  byType: Record<string, { asSource: number; asTarget: number }>;
}

function qname(type: string, name: string, ns: string | null, ctxNs: string | null): string {
  const stripped = stripNs(name, ns ?? ctxNs);
  return `${type}:${stripped}`;
}

async function fetchPaginated(
  conn: any,
  baseWhereClause: string,
  label: string,
  pageSize: number,
  maxPages: number,
  onError?: (label: string, err: Error) => void,
): Promise<McdRow[]> {
  const rows: McdRow[] = [];
  let lastId = "";
  for (let page = 0; page < maxPages; page += 1) {
    const idFilter = lastId ? ` AND Id > '${lastId.replace(/'/g, "\\'")}'` : "";
    const soql =
      "SELECT Id, MetadataComponentId, MetadataComponentType, MetadataComponentName, MetadataComponentNamespace, " +
      "RefMetadataComponentId, RefMetadataComponentType, RefMetadataComponentName, RefMetadataComponentNamespace " +
      `FROM MetadataComponentDependency WHERE ${baseWhereClause}${idFilter} ` +
      `ORDER BY Id ASC LIMIT ${pageSize}`;
    let res: { records?: McdRow[] } | null = null;
    try {
      res = (await scheduleQuery(() =>
        soqlWithTimeout(conn.tooling.query(soql), label),
      )) as { records?: McdRow[] } | null;
    } catch (e) {
      onError?.(label, e as Error);
      break;
    }
    const page_rows = res?.records ?? [];
    if (page_rows.length === 0) break;
    rows.push(...page_rows);
    if (page_rows.length < pageSize) break; // last page
    const tail = page_rows[page_rows.length - 1];
    if (!tail || tail.Id === lastId) break; // defensive: no progress
    lastId = tail.Id;
  }
  return rows;
}

export async function runMcdBaseline(
  conn: any,
  opts: McdBaselineOpts,
): Promise<McdBaselineResult> {
  const orgId = typeof opts.orgId === "string" ? asOrgId(opts.orgId) : opts.orgId;
  const types = opts.types ?? MCD_LONG_TAIL_TYPES;
  const pageSize = opts.pageSize ?? 2000;
  const maxPages = opts.maxPagesPerDirection ?? 50;
  const ctxNs = opts.ctx.namespace ?? null;

  const edges: EdgeFact[] = [];
  const byType: Record<string, { asSource: number; asTarget: number }> = {};
  // Dedupe across the two query directions — when both A and B are long-tail
  // types and A→B exists, both queries surface it; we want to emit one edge.
  const seen = new Set<string>();

  for (const type of types) {
    byType[type] = { asSource: 0, asTarget: 0 };

    // Direction 1: component-as-source ("what does this Layout reference?")
    const asSourceRows = await fetchPaginated(
      conn,
      `MetadataComponentType = '${type}'`,
      `mcd-baseline:${type}:as-source`,
      pageSize,
      maxPages,
      opts.onError,
    );
    byType[type].asSource = asSourceRows.length;

    // Direction 2: component-as-target ("what references this Layout?")
    const asTargetRows = await fetchPaginated(
      conn,
      `RefMetadataComponentType = '${type}'`,
      `mcd-baseline:${type}:as-target`,
      pageSize,
      maxPages,
      opts.onError,
    );
    byType[type].asTarget = asTargetRows.length;

    for (const row of [...asSourceRows, ...asTargetRows]) {
      const src = qname(
        row.MetadataComponentType,
        row.MetadataComponentName,
        row.MetadataComponentNamespace ?? null,
        ctxNs,
      );
      const dst = qname(
        row.RefMetadataComponentType,
        row.RefMetadataComponentName,
        row.RefMetadataComponentNamespace ?? null,
        ctxNs,
      );
      const key = `${src}|${dst}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // `isDynamicReference` heuristic (W2-04 will deepen this) — when an
      // MCD row's MetadataComponentId equals MetadataComponentName, the
      // platform recorded a literal Id reference (e.g. `'003xxx...'` in
      // Apex source) rather than a name-resolved one. Flag the edge so
      // consumers can distinguish.
      const dynamic =
        row.MetadataComponentId === row.MetadataComponentName ||
        row.RefMetadataComponentId === row.RefMetadataComponentName;
      edges.push(
        makeEdge(opts.ctx, src, REL_TYPES.REFERENCES, dst, {
          source: "mcd",
          mcdSrcType: row.MetadataComponentType,
          mcdDstType: row.RefMetadataComponentType,
          ...(dynamic ? { dynamic: true } : {}),
        }),
      );
    }
  }

  return { edges, byType };
}
