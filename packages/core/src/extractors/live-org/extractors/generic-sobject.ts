import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleData } from "../rate-limit.js";

/**
 * Generic SOQL iterator for SObject-backed types (CMDT records, etc.).
 * Errors are silent — caller may have routed an SObject that doesn't exist.
 */
export async function* iterGenericSObject(
  conn: any,
  orgId: string,
  sobject: string,
  fields: string[] = ["Id", "Name", "LastModifiedDate"],
): AsyncIterable<RawMember> {
  const soql = `SELECT ${fields.join(", ")} FROM ${sobject}`;
  let result: { records?: any[] } | null = null;
  try {
    result = (await scheduleData(() => conn.query(soql))) as { records?: any[] } | null;
  } catch {
    return;
  }
  const records: any[] = result?.records ?? [];
  for (const r of records) {
    const name = String(r?.Name ?? r?.Id ?? "");
    yield {
      ref: {
        category: METADATA_CATEGORY.OPAQUE,
        memberType: sobject,
        memberName: name,
        lastModifiedAt: r?.LastModifiedDate ? String(r.LastModifiedDate) : null,
        sourceUri: `sf://${orgId}/${sobject}/${name}`,
      },
      content: JSON.stringify(r),
    };
  }
}
