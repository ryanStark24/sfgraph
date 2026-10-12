import { METADATA_CATEGORY, type MetadataCategory } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleData } from "../rate-limit.js";
import {
  type FetchFailure,
  type RetryOptions,
  isOrgRejection,
  querySoqlAll,
  throwIfIncomplete,
} from "../retry.js";

/** Child-fetch outcome: rows grouped by parent Id, plus the parent Ids whose
 *  child chunk could not be fetched after retries. */
interface ChildFetch<T> {
  byParent: Map<string, T[]>;
  failedParents: Map<string, unknown>;
}

interface ORow {
  Id?: string;
  Name?: string;
  DeveloperName?: string;
  LastModifiedDate?: string;
  [k: string]: unknown;
}

interface OElementRow {
  Id?: string;
  Name?: string;
  Type?: string | null;
  PropertySet?: string | null; // long-text JSON
  ParentElementId?: string | null;
  ElementsLevel?: number | null;
  OmniProcessId?: string;
}

interface OQuery {
  memberType: string;
  category: MetadataCategory;
  soql: string;
  /** Whether this type has an element-graph child query against
   *  OmniProcessElement. Without this, the parser walk() finds zero
   *  inner nodes and emits zero edges. */
  fetchElements?: boolean;
  /** Whether this type has a field-mapping child query against
   *  OmniDataTransformItem. Without this, the DataTransform parser has
   *  no mapping rows to read and emits zero field edges. */
  fetchItems?: boolean;
}

// Minimal universal fields — Id, Name, LastModifiedDate exist on every
// OmniStudio SObject across versions. Type discriminators (OmniProcessType,
// OmniDataTransformType) were dropped because field-name drift across
// versions silently broke the queries. The parser layer determines kind
// from the payload separately.
const QUERIES: OQuery[] = [
  {
    memberType: "OmniProcess",
    category: METADATA_CATEGORY.OMNI_PROCESS,
    soql: "SELECT Id, Name, LastModifiedDate FROM OmniProcess",
    fetchElements: true,
  },
  {
    memberType: "OmniDataTransform",
    category: METADATA_CATEGORY.OMNI_DATA_TRANSFORM,
    soql: "SELECT Id, Name, LastModifiedDate FROM OmniDataTransform",
    fetchItems: true,
  },
  {
    memberType: "OmniUiCard",
    category: METADATA_CATEGORY.OMNI_UI_CARD,
    soql: "SELECT Id, Name, LastModifiedDate FROM OmniUiCard",
  },
];

/**
 * Fetch every OmniProcessElement for the given parent Ids in one paged
 * query, then group by OmniProcessId. The PropertySet field is a long-text
 * JSON blob — parse it server-side so downstream parsers can walk a real
 * object tree instead of a string.
 */
async function fetchElementsByProcess(
  conn: any,
  processIds: string[],
  retryOpts: RetryOptions,
): Promise<ChildFetch<{ Type: string; propertySet: unknown; name: string | null }>> {
  const byProcess = new Map<
    string,
    Array<{ Type: string; propertySet: unknown; name: string | null }>
  >();
  const failedParents = new Map<string, unknown>();
  if (processIds.length === 0) return { byParent: byProcess, failedParents };
  // SOQL IN() has a 4000-item ceiling; chunk defensively.
  const CHUNK = 200;
  for (let i = 0; i < processIds.length; i += CHUNK) {
    const slice = processIds.slice(i, i + CHUNK);
    const idList = slice.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
    const soql = `SELECT Id, Name, Type, PropertySet, OmniProcessId, ParentElementId, ElementsLevel FROM OmniProcessElement WHERE OmniProcessId IN (${idList})`;
    // OmniProcessElement is a standard SObject in OmniStudio-on-Core, not
    // a Tooling object. Route via conn.query (regular SOQL) on the data pool.
    // 200 parents can carry far more than one 2000-row page of elements:
    // drain every page (a plain conn.query returns only the first batch).
    let records: OElementRow[] = [];
    try {
      records = await querySoqlAll<OElementRow>(
        conn,
        soql,
        "data OmniProcessElement",
        scheduleData,
        retryOpts,
      );
    } catch (e) {
      // Don't emit these parents with a missing/partial element graph;
      // the caller surfaces them as not fetched.
      for (const id of slice) failedParents.set(id, e);
      continue;
    }
    for (const r of records) {
      if (!r.OmniProcessId) continue;
      let propertySet: unknown = {};
      if (typeof r.PropertySet === "string" && r.PropertySet.length > 0) {
        try {
          propertySet = JSON.parse(r.PropertySet);
        } catch {
          propertySet = { _raw: r.PropertySet };
        }
      }
      const arr = byProcess.get(r.OmniProcessId) ?? [];
      arr.push({
        Type: String(r.Type ?? ""),
        propertySet,
        name: r.Name ?? null,
      });
      byProcess.set(r.OmniProcessId, arr);
    }
  }
  return { byParent: byProcess, failedParents };
}

/**
 * Fetch every OmniDataTransformItem mapping row for the given transform Ids,
 * grouped by OmniDataTransformationId. These rows carry the structured
 * field mappings (InputObjectName/InputFieldName, Output*, Lookup*) that
 * the OmniDataTransform parser turns into DR_READS_FIELD / DR_WRITES_FIELD
 * edges. Wrapped in its own try/catch per chunk so field-name drift on a
 * newer org version degrades to "no items" with a breadcrumb; any other
 * failure (after retries) marks the chunk's parents as not fetched.
 */
async function fetchItemsByTransform(
  conn: any,
  transformIds: string[],
  retryOpts: RetryOptions,
): Promise<ChildFetch<Record<string, unknown>>> {
  const byTransform = new Map<string, Array<Record<string, unknown>>>();
  const failedParents = new Map<string, unknown>();
  if (transformIds.length === 0) return { byParent: byTransform, failedParents };
  const CHUNK = 200;
  for (let i = 0; i < transformIds.length; i += CHUNK) {
    const slice = transformIds.slice(i, i + CHUNK);
    const idList = slice.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
    const ITEM_FIELDS =
      "Id, Name, InputObjectName, InputFieldName, OutputObjectName, OutputFieldName, LookupObjectName, LookupByFieldName, FilterValue, FilterOperator, OmniDataTransformationId";
    const soql = `SELECT ${ITEM_FIELDS} FROM OmniDataTransformItem WHERE OmniDataTransformationId IN (${idList})`;
    let records: Array<Record<string, unknown>> = [];
    try {
      records = await querySoqlAll<Record<string, unknown>>(
        conn,
        soql,
        "data OmniDataTransformItem",
        scheduleData,
        retryOpts,
      );
    } catch (e) {
      if (!isOrgRejection(e)) {
        for (const id of slice) failedParents.set(id, e);
        continue;
      }
      console.log(
        `ingest:   omnistudio item query failed for OmniDataTransformItem: ${(e as Error).message?.slice(0, 200) ?? String(e)}`,
      );
      // Schema drift is permanent: no items for any chunk.
      return { byParent: byTransform, failedParents };
    }
    for (const r of records) {
      const parentId = String(r.OmniDataTransformationId ?? "");
      if (!parentId) continue;
      const arr = byTransform.get(parentId) ?? [];
      arr.push(r);
      byTransform.set(parentId, arr);
    }
  }
  return { byParent: byTransform, failedParents };
}

export interface IterOmnistudioOpts {
  /** Member types to skip on the SOQL path. Used by bulk-retrieve to avoid
   *  double-ingesting types the Metadata-API retrieve path already covers
   *  with higher fidelity (OmniDataTransform, OmniUiCard) when
   *  enableOmnistudioRetrieve is on. */
  skipTypes?: Set<string>;
  /** Retry/backoff for every query (tests pass retryBackoffMs: 0). */
  retry?: RetryOptions;
}

export async function* iterOmnistudio(
  conn: any,
  opts: IterOmnistudioOpts = {},
): AsyncIterable<RawMember> {
  // Fire all 4 Tooling SOQL queries in parallel — they're independent and
  // the Tooling pool throttles concurrency.
  // Each mapped task wraps scheduleQuery in try/catch so allSettled is
  // belt-and-braces here, but using it anyway for consistency with the
  // other extractors and to guarantee no orphan rejection ever escapes.
  // OmniStudio-on-Core's OmniProcess / OmniDataTransform / OmniUiCard are
  // standard SObjects (visible to `conn.sobject(...).describe()` — which is
  // how capabilities.ts detects them). They are NOT Tooling objects, so
  // routing through `conn.tooling.query` silently returned zero rows on
  // orgs that actually had data. Use regular SOQL via the data pool.
  const retryOpts = opts.retry ?? {};
  const failures: FetchFailure[] = [];
  const activeQueries = QUERIES.filter((q) => !opts.skipTypes?.has(q.memberType));
  const settled = await Promise.allSettled(
    activeQueries.map(async (q) => {
      try {
        // Drain every page: a plain conn.query returns only the first batch.
        const records = await querySoqlAll<ORow>(
          conn,
          q.soql,
          `data ${q.memberType}`,
          scheduleData,
          retryOpts,
        );
        const res = { records } as { records?: ORow[] } | null;
        return { q, res, err: null as Error | null };
      } catch (e) {
        return { q, res: null, err: e as Error };
      }
    }),
  );
  const results = settled
    .map((s) => (s.status === "fulfilled" ? s.value : null))
    .filter(
      (v): v is { q: OQuery; res: { records?: ORow[] } | null; err: Error | null } => v !== null,
    );

  // Surface per-query failures so silent-zero stops looking the same as
  // genuinely-empty. The most common cause is a renamed field on a newer
  // org version (e.g. OmniProcessType -> Type) — without this line we
  // returned `✓ 0 records` and the user had no breadcrumb.
  for (const { q, err } of results) {
    if (err && !isOrgRejection(err)) {
      // Transient (timeout / connection loss): lost data, surface it.
      failures.push({ name: q.memberType, error: err });
    } else if (err) {
      console.log(
        `ingest:   omnistudio query failed for ${q.memberType}: ${err.message?.slice(0, 200) ?? String(err)}`,
      );
    }
  }

  // Second pass: for every type with fetchElements:true, batch-query
  // OmniProcessElement for ALL parent Ids across types in a single grouped
  // fetch. The parsers walk `metadata.elements[].propertySet` looking for
  // dataTransformName / integrationProcedureKey / cardName — without this
  // pass those edges never get emitted (parent-only rows have no nested
  // configuration to walk).
  const parentIds: string[] = [];
  const transformIds: string[] = [];
  for (const { q, res } of results) {
    if (!q.fetchElements && !q.fetchItems) continue;
    for (const r of res?.records ?? []) {
      if (!r.Id) continue;
      if (q.fetchElements) parentIds.push(String(r.Id));
      if (q.fetchItems) transformIds.push(String(r.Id));
    }
  }
  const [elementFetch, itemFetch] = await Promise.all([
    fetchElementsByProcess(conn, parentIds, retryOpts),
    fetchItemsByTransform(conn, transformIds, retryOpts),
  ]);
  const elementsByProcess = elementFetch.byParent;
  const itemsByTransform = itemFetch.byParent;

  for (const { q, res } of results) {
    for (const r of res?.records ?? []) {
      const name = String(r.DeveloperName ?? r.Name ?? r.Id ?? "");
      const id = r.Id ? String(r.Id) : "";
      const childErr =
        (q.fetchElements && elementFetch.failedParents.get(id)) ||
        (q.fetchItems && itemFetch.failedParents.get(id));
      if (childErr) {
        // Emitting the parent without its children would replace a good
        // node with an edgeless one; leave it for --retry-skipped.
        failures.push({ name: `${q.memberType}:${name}`, error: childErr });
        continue;
      }
      const elements = q.fetchElements && r.Id ? (elementsByProcess.get(String(r.Id)) ?? []) : [];
      const items = q.fetchItems && r.Id ? (itemsByTransform.get(String(r.Id)) ?? []) : [];
      let enriched: Record<string, unknown> = r;
      if (elements.length > 0) enriched = { ...enriched, elements };
      if (items.length > 0) enriched = { ...enriched, items };
      yield {
        ref: {
          category: q.category,
          memberType: q.memberType,
          memberName: name,
          lastModifiedAt: r.LastModifiedDate ?? null,
          sourceUri: `sf://omnistudio/${q.memberType}/${name}`,
          namespace: null,
        },
        content: JSON.stringify(enriched),
      };
    }
  }
  throwIfIncomplete("omnistudio", failures);
}
