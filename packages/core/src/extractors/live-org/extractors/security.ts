import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY, type MetadataCategory } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

const BATCH = 10;
const xml = new XMLBuilder({ ignoreAttributes: false, format: false, suppressEmptyNode: true });

interface MdListItem {
  fullName: string;
  lastModifiedDate?: string;
  namespacePrefix?: string;
}

const TYPE_TO_CATEGORY: Record<string, MetadataCategory> = {
  Profile: METADATA_CATEGORY.PROFILE,
  PermissionSet: METADATA_CATEGORY.PERMISSION_SET,
  SharingRules: METADATA_CATEGORY.SHARING_RULE,
};

async function* iterType(conn: any, type: string): AsyncIterable<RawMember> {
  const list = (await scheduleQuery(() => conn.metadata.list([{ type }]))) as MdListItem[] | null;
  const items = Array.isArray(list) ? list : [];
  const category = TYPE_TO_CATEGORY[type] ?? METADATA_CATEGORY.SECURITY;
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const reads = (await scheduleQuery(() =>
      conn.metadata.read(
        type,
        slice.map((s) => s.fullName),
      ),
    )) as any;
    const arr = Array.isArray(reads) ? reads : [reads];
    for (let j = 0; j < slice.length; j += 1) {
      const meta = slice[j];
      if (!meta) continue;
      const obj = arr[j] ?? {};
      const content = xml.build({ [type]: obj });
      yield {
        ref: {
          category,
          memberType: type,
          memberName: meta.fullName,
          lastModifiedAt: meta.lastModifiedDate ?? null,
          sourceUri: `sf://metadata/${type}/${meta.fullName}`,
          namespace: meta.namespacePrefix ?? null,
        },
        content: typeof content === "string" ? content : String(content),
      };
    }
  }
}

export async function* iterSecurity(conn: any): AsyncIterable<RawMember> {
  for (const t of ["Profile", "PermissionSet", "SharingRules"]) {
    yield* iterType(conn, t);
  }
}
