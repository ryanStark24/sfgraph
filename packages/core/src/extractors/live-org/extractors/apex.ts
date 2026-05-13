import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

interface ToolingClassRow {
  Id: string;
  Name: string;
  Body?: string | null;
  NamespacePrefix?: string | null;
  LastModifiedDate?: string | null;
}

interface ToolingTriggerRow extends ToolingClassRow {
  TableEnumOrId?: string | null;
}

const APEX_CLASS_SOQL = "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate FROM ApexClass";
const APEX_TRIGGER_SOQL =
  "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, TableEnumOrId FROM ApexTrigger";

export async function* iterApex(conn: any): AsyncIterable<RawMember> {
  const classes = (await scheduleQuery(() => conn.tooling.query(APEX_CLASS_SOQL))) as {
    records?: ToolingClassRow[];
  } | null;
  for (const r of classes?.records ?? []) {
    yield {
      ref: {
        category: METADATA_CATEGORY.APEX_CLASS,
        memberType: "ApexClass",
        memberName: r.Name,
        lastModifiedAt: r.LastModifiedDate ?? null,
        sourceUri: `sf://tooling/ApexClass/${r.Name}`,
        namespace: r.NamespacePrefix ?? null,
      },
      content: r.Body ?? "",
    };
  }
  const triggers = (await scheduleQuery(() => conn.tooling.query(APEX_TRIGGER_SOQL))) as {
    records?: ToolingTriggerRow[];
  } | null;
  for (const r of triggers?.records ?? []) {
    yield {
      ref: {
        category: METADATA_CATEGORY.APEX_TRIGGER,
        memberType: "ApexTrigger",
        memberName: r.Name,
        lastModifiedAt: r.LastModifiedDate ?? null,
        sourceUri: `sf://tooling/ApexTrigger/${r.Name}`,
        namespace: r.NamespacePrefix ?? null,
      },
      content: r.Body ?? "",
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
