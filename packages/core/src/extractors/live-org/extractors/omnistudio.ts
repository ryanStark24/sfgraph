import { METADATA_CATEGORY, type MetadataCategory } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

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
}

const QUERIES: OQuery[] = [
  {
    memberType: "OmniProcess",
    category: METADATA_CATEGORY.OMNI_PROCESS,
    soql: "SELECT Id, Name, OmniProcessType, LastModifiedDate FROM OmniProcess",
    fetchElements: true,
  },
  {
    memberType: "OmniDataTransform",
    category: METADATA_CATEGORY.OMNI_DATA_TRANSFORM,
    soql: "SELECT Id, Name, OmniDataTransformType, LastModifiedDate FROM OmniDataTransform",
  },
  {
    memberType: "OmniUiCard",
    category: METADATA_CATEGORY.OMNI_UI_CARD,
    soql: "SELECT Id, DeveloperName, LastModifiedDate FROM OmniUiCard",
  },
  {
    memberType: "OmniIntegrationProcedure",
    category: METADATA_CATEGORY.OMNI_INTEGRATION_PROCEDURE,
    soql: "SELECT Id, Name, LastModifiedDate FROM OmniProcess WHERE OmniProcessType = 'Integration Procedure'",
    fetchElements: true,
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
): Promise<Map<string, Array<{ Type: string; propertySet: unknown; name: string | null }>>> {
  const byProcess = new Map<string, Array<{ Type: string; propertySet: unknown; name: string | null }>>();
  if (processIds.length === 0) return byProcess;
  // SOQL IN() has a 4000-item ceiling; chunk defensively.
  const CHUNK = 200;
  for (let i = 0; i < processIds.length; i += CHUNK) {
    const slice = processIds.slice(i, i + CHUNK);
    const idList = slice.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
    const soql = `SELECT Id, Name, Type, PropertySet, OmniProcessId, ParentElementId, ElementsLevel FROM OmniProcessElement WHERE OmniProcessId IN (${idList})`;
    let res: { records?: OElementRow[] } | null = null;
    try {
      res = (await scheduleQuery(() => conn.tooling.query(soql))) as {
        records?: OElementRow[];
      } | null;
    } catch {
      continue;
    }
    for (const r of res?.records ?? []) {
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
  return byProcess;
}

export async function* iterOmnistudio(conn: any): AsyncIterable<RawMember> {
  // Fire all 4 Tooling SOQL queries in parallel — they're independent and
  // the Tooling pool throttles concurrency.
  const results = await Promise.all(
    QUERIES.map(async (q) => {
      try {
        return {
          q,
          res: (await scheduleQuery(() => conn.tooling.query(q.soql))) as {
            records?: ORow[];
          } | null,
        };
      } catch {
        return { q, res: null };
      }
    }),
  );

  // Second pass: for every type with fetchElements:true, batch-query
  // OmniProcessElement for ALL parent Ids across types in a single grouped
  // fetch. The parsers walk `metadata.elements[].propertySet` looking for
  // dataTransformName / integrationProcedureKey / cardName — without this
  // pass those edges never get emitted (parent-only rows have no nested
  // configuration to walk).
  const parentIds: string[] = [];
  for (const { q, res } of results) {
    if (!q.fetchElements) continue;
    for (const r of res?.records ?? []) {
      if (r.Id) parentIds.push(String(r.Id));
    }
  }
  const elementsByProcess = await fetchElementsByProcess(conn, parentIds);

  for (const { q, res } of results) {
    for (const r of res?.records ?? []) {
      const name = String(r.DeveloperName ?? r.Name ?? r.Id ?? "");
      const elements = q.fetchElements && r.Id ? (elementsByProcess.get(String(r.Id)) ?? []) : [];
      const enriched = elements.length > 0 ? { ...r, elements } : r;
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
}
