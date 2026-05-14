import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

const BATCH = 10;
const xml = new XMLBuilder({ ignoreAttributes: false, format: false, suppressEmptyNode: true });

interface EntityRow {
  QualifiedApiName: string;
  NamespacePrefix?: string | null;
  LastModifiedDate?: string | null;
}

/** Names we never try metadata.read('CustomObject') on. These are platform
 *  entities that show up in EntityDefinition but the Metadata API doesn't
 *  expose them as CustomObjects — and trying causes INSUFFICIENT_ACCESS
 *  even for System Administrators. Curated from a real org scan. */
const SYSTEM_ENTITY_DENYLIST = new Set([
  "User",
  "Group",
  "Profile",
  "PermissionSet",
  "UserRole",
  "Organization",
  "Folder",
  "QueueSobject",
  "GroupMember",
  "UserPermissionAccess",
  "PermissionSetAssignment",
  "SetupEntityAccess",
  "AppMenuItem",
  "ApexClass",
  "ApexTrigger",
  "ApexPage",
  "ApexComponent",
  "StaticResource",
]);

function shouldRead(row: EntityRow): boolean {
  const name = row.QualifiedApiName;
  if (!name) return false;
  if (SYSTEM_ENTITY_DENYLIST.has(name)) return false;
  // Skip platform entities that aren't first-class metadata. Heuristic:
  // CustomObjects always end in __c, Big Objects in __b, External in __x.
  // Standard non-__c objects that DO have CustomObject metadata (Account,
  // Contact, Opportunity, Lead, Case, etc.) are allowed back in via the
  // !IsCustom branch — we explicitly want their CustomObject XML for
  // recordTypes, validationRules, custom fields, etc.
  return true;
}

export async function* iterObject(conn: any): AsyncIterable<RawMember> {
  const res = (await scheduleQuery(() =>
    conn.tooling.query(
      "SELECT QualifiedApiName, NamespacePrefix, LastModifiedDate FROM EntityDefinition WHERE IsCustomSetting=false AND IsCustomizable=true",
    ),
  )) as { records?: EntityRow[] } | null;
  const allRows = res?.records ?? [];
  const rows = allRows.filter(shouldRead);

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const names = slice.map((s) => s.QualifiedApiName);

    // Try the whole batch in one metadata.read call. If it throws (e.g. one
    // entity in the batch is unreadable for the current user), fall back to
    // per-name reads so the bad apple doesn't take the rest down with it.
    let arr: any[] = [];
    try {
      const reads = (await scheduleQuery(() =>
        conn.metadata.read("CustomObject", names),
      )) as unknown;
      arr = Array.isArray(reads) ? (reads as any[]) : [reads];
    } catch {
      arr = [];
      for (const name of names) {
        try {
          const single = (await scheduleQuery(() =>
            conn.metadata.read("CustomObject", [name]),
          )) as unknown;
          const unwrapped = Array.isArray(single) ? (single as any[])[0] : single;
          arr.push(unwrapped);
        } catch {
          // One-off failure — push undefined so index alignment with `slice`
          // is preserved and the row is yielded with empty content (parser
          // will treat as not-present rather than crashing the run).
          arr.push(undefined);
        }
      }
    }

    for (let j = 0; j < slice.length; j += 1) {
      const meta = slice[j];
      if (!meta) continue;
      const obj = arr[j];
      if (obj === undefined) continue; // skip rows we couldn't read
      const content = xml.build({ CustomObject: obj });
      yield {
        ref: {
          category: METADATA_CATEGORY.OBJECT,
          memberType: "CustomObject",
          memberName: meta.QualifiedApiName,
          lastModifiedAt: meta.LastModifiedDate ?? null,
          sourceUri: `sf://metadata/CustomObject/${meta.QualifiedApiName}`,
          namespace: meta.NamespacePrefix ?? null,
        },
        content: typeof content === "string" ? content : String(content),
      };
    }
  }
}
