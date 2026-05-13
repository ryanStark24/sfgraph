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

export async function* iterObject(conn: any): AsyncIterable<RawMember> {
  const res = (await scheduleQuery(() =>
    conn.tooling.query(
      "SELECT QualifiedApiName, NamespacePrefix, LastModifiedDate FROM EntityDefinition WHERE IsCustomSetting=false AND IsCustomizable=true",
    ),
  )) as { records?: EntityRow[] } | null;
  const rows = res?.records ?? [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const names = slice.map((s) => s.QualifiedApiName);
    const reads = (await scheduleQuery(() => conn.metadata.read("CustomObject", names))) as any;
    const arr = Array.isArray(reads) ? reads : [reads];
    for (let j = 0; j < slice.length; j += 1) {
      const meta = slice[j];
      if (!meta) continue;
      const obj = arr[j] ?? {};
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
