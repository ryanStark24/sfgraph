import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

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

export async function* iterApex(conn: any): AsyncIterable<RawMember> {
  // Fire both Tooling queries in parallel — allSettled so one rejection
  // doesn't poison the other's promise into an unhandled rejection (which
  // crashes node 24+).
  const [classesS, triggersS] = await Promise.allSettled([
    scheduleQuery(() => conn.tooling.query(APEX_CLASS_SOQL)) as Promise<{
      records?: ToolingClassRow[];
    } | null>,
    scheduleQuery(() => conn.tooling.query(APEX_TRIGGER_SOQL)) as Promise<{
      records?: ToolingTriggerRow[];
    } | null>,
  ]);
  const classes = classesS.status === "fulfilled" ? classesS.value : null;
  const triggers = triggersS.status === "fulfilled" ? triggersS.value : null;
  // For managed-package Apex, Body comes back as the literal string
  // "(hidden)" — parsing it produces nothing useful. We still emit the
  // node (so calling code's edges resolve to a real target) but skip
  // the body. Set SFGRAPH_INCLUDE_MANAGED=1 to keep the redacted Body.
  const includeManaged = process.env.SFGRAPH_INCLUDE_MANAGED === "1";
  const stubBody = (r: ToolingClassRow): string =>
    r.NamespacePrefix && !includeManaged ? "" : (r.Body ?? "");
  for (const r of classes?.records ?? []) {
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
  for (const r of triggers?.records ?? []) {
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
}

/** Re-fetch a single Apex member by name (used for incremental updates). */
export async function iterOne(conn: any, name: string): Promise<RawMember | null> {
  const escaped = name.replace(/'/g, "\\'");
  const tryQuery = async (soql: string, type: "ApexClass" | "ApexTrigger") => {
    const res = (await scheduleQuery(() => conn.tooling.query(soql))) as {
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
