import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery, soqlWithTimeout } from "../rate-limit.js";

interface ToolingClassRow {
  Id: string;
  Name: string;
  Body?: string | null;
  NamespacePrefix?: string | null;
  LastModifiedDate?: string | null;
  ApiVersion?: number | string | null;
  Status?: string | null;
}

interface ToolingTriggerRow extends ToolingClassRow {
  TableEnumOrId?: string | null;
}

const APEX_CLASS_SOQL =
  "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, ApiVersion, Status FROM ApexClass";
const APEX_TRIGGER_SOQL =
  "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, ApiVersion, Status, TableEnumOrId FROM ApexTrigger";

/**
 * Build the minimal `<*MetaXml>` envelope the parser would otherwise get
 * from `force-app/.../<Name>.cls-meta.xml`. Keeps apiVersion + Status from
 * the Tooling row available to the parser via the standard metaXml input
 * channel — without this, live-ingested Apex nodes always had
 * apiVersion: null, while filesystem-ingested ones had the real value.
 */
function buildApexMetaXml(
  outerTag: "ApexClass" | "ApexTrigger",
  row: ToolingClassRow,
): string | undefined {
  const av = row.ApiVersion;
  const status = row.Status;
  if (av == null && !status) return undefined;
  const parts: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<${outerTag}>`];
  if (av != null) parts.push(`  <apiVersion>${String(av)}</apiVersion>`);
  if (status) parts.push(`  <status>${status}</status>`);
  parts.push(`</${outerTag}>`);
  return parts.join("\n");
}

/**
 * Drain a Tooling SOQL query across ALL pages. `conn.tooling.query` returns at
 * most one page (200 rows); without following `nextRecordsUrl` via `queryMore`
 * the extractor silently capped Apex at the first 200 members — on a large org
 * (7k+ classes) that dropped ~97% of the source, and that first page is
 * dominated by managed-package classes whose body is stubbed, so almost
 * nothing parsed. Streams rows so we never hold the whole (body-heavy) result
 * set in memory at once.
 */
async function* drainToolingQuery<T>(conn: any, soql: string, label: string): AsyncIterable<T> {
  let result: any = await scheduleQuery(() => soqlWithTimeout(conn.tooling.query(soql), label));
  while (result) {
    for (const r of (result.records ?? []) as T[]) yield r;
    if (result.done || !result.nextRecordsUrl || typeof conn.tooling.queryMore !== "function") {
      break;
    }
    result = await scheduleQuery(() =>
      soqlWithTimeout(conn.tooling.queryMore(result.nextRecordsUrl), `${label} more`),
    );
  }
}

export async function* iterApex(conn: any): AsyncIterable<RawMember> {
  // For managed-package Apex, Body comes back redacted (empty / "(hidden)") —
  // parsing it produces nothing useful. We still emit the node (so calling
  // code's edges resolve to a real target) with an empty body, which the
  // parser turns into a bare node. Set SFGRAPH_INCLUDE_MANAGED=1 to keep the
  // redacted Body instead.
  const includeManaged = process.env.SFGRAPH_INCLUDE_MANAGED === "1";
  const stubBody = (r: ToolingClassRow): string =>
    r.NamespacePrefix && !includeManaged ? "" : (r.Body ?? "");

  // Classes and triggers are drained independently and fail-soft: a failure
  // fetching one must not drop the other (an unhandled jsforce rejection also
  // crashes node 24+, hence the per-stream try/catch).
  try {
    for await (const r of drainToolingQuery<ToolingClassRow>(
      conn,
      APEX_CLASS_SOQL,
      "tooling ApexClass",
    )) {
      const metaXml = buildApexMetaXml("ApexClass", r);
      yield {
        ref: {
          category: METADATA_CATEGORY.APEX_CLASS,
          memberType: "ApexClass",
          memberName: r.Name,
          lastModifiedAt: r.LastModifiedDate ?? null,
          sourceUri: `sf://tooling/ApexClass/${r.Name}`,
          namespace: r.NamespacePrefix ?? null,
        },
        // JSON envelope so adaptParserInput can forward metaXml (containing
        // apiVersion + Status) alongside the body. Plain-body content from
        // the filesystem path still parses correctly via the adapter's
        // shape detection.
        content: JSON.stringify({
          body: stubBody(r),
          metaXml,
          ...(r.NamespacePrefix && !includeManaged ? { managed: true } : {}),
        }),
      };
    }
  } catch {
    /* fail-soft: skip ApexClass on fetch failure, still try triggers */
  }

  try {
    for await (const r of drainToolingQuery<ToolingTriggerRow>(
      conn,
      APEX_TRIGGER_SOQL,
      "tooling ApexTrigger",
    )) {
      const metaXml = buildApexMetaXml("ApexTrigger", r);
      yield {
        ref: {
          category: METADATA_CATEGORY.APEX_TRIGGER,
          memberType: "ApexTrigger",
          memberName: r.Name,
          lastModifiedAt: r.LastModifiedDate ?? null,
          sourceUri: `sf://tooling/ApexTrigger/${r.Name}`,
          namespace: r.NamespacePrefix ?? null,
        },
        content: JSON.stringify({
          body: stubBody(r),
          metaXml,
          ...(r.NamespacePrefix && !includeManaged ? { managed: true } : {}),
        }),
      };
    }
  } catch {
    /* fail-soft: skip ApexTrigger on fetch failure */
  }
}

/** Re-fetch a single Apex member by name (used for incremental updates). */
export async function iterOne(conn: any, name: string): Promise<RawMember | null> {
  const escaped = name.replace(/'/g, "\\'");
  const tryQuery = async (soql: string, type: "ApexClass" | "ApexTrigger") => {
    const res = (await scheduleQuery(() =>
      soqlWithTimeout(conn.tooling.query(soql), `tooling ${type} ${name}`),
    )) as {
      records?: ToolingClassRow[];
    } | null;
    const r = res?.records?.[0];
    if (!r) return null;
    return {
      ref: {
        category:
          type === "ApexClass" ? METADATA_CATEGORY.APEX_CLASS : METADATA_CATEGORY.APEX_TRIGGER,
        memberType: type,
        memberName: r.Name,
        lastModifiedAt: r.LastModifiedDate ?? null,
        sourceUri: `sf://tooling/${type}/${r.Name}`,
        namespace: r.NamespacePrefix ?? null,
      },
      content: r.Body ?? "",
    } satisfies RawMember;
  };
  return (
    (await tryQuery(`${APEX_CLASS_SOQL} WHERE Name = '${escaped}' LIMIT 1`, "ApexClass")) ??
    (await tryQuery(`${APEX_TRIGGER_SOQL} WHERE Name = '${escaped}' LIMIT 1`, "ApexTrigger"))
  );
}
