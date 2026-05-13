import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY, type MetadataCategory } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery } from "../rate-limit.js";

const BATCH = 10;
const xml = new XMLBuilder({ ignoreAttributes: false, format: false, suppressEmptyNode: true });

const TYPE_TO_CATEGORY: Record<string, MetadataCategory> = {
  NamedCredential: METADATA_CATEGORY.NAMED_CREDENTIAL,
  ExternalServiceRegistration: METADATA_CATEGORY.EXTERNAL_SERVICE_REGISTRATION,
};

async function* iterType(conn: any, type: string): AsyncIterable<RawMember> {
  const list = (await scheduleQuery(() => conn.metadata.list([{ type }]))) as Array<{
    fullName: string;
    lastModifiedDate?: string;
    namespacePrefix?: string;
  }> | null;
  const items = Array.isArray(list) ? list : [];
  const category = TYPE_TO_CATEGORY[type] ?? METADATA_CATEGORY.INTEGRATION;
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

export async function* iterIntegration(conn: any): AsyncIterable<RawMember> {
  for (const t of ["NamedCredential", "ExternalServiceRegistration"]) {
    yield* iterType(conn, t);
  }
}
