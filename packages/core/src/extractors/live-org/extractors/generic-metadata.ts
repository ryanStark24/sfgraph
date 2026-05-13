import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleMetadata } from "../rate-limit.js";

const BATCH = 10;

/**
 * Generic metadata.list + metadata.read iterator for any type that doesn't
 * have a dedicated extractor. Failures are silent (type may simply not be
 * retrievable in this org).
 */
export async function* iterGenericMetadata(
  conn: any,
  orgId: string,
  type: string,
): AsyncIterable<RawMember> {
  let list: any[] = [];
  try {
    const raw = await scheduleMetadata(() => conn.metadata.list([{ type }]));
    list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  } catch {
    return;
  }
  const items = list.filter((l) => l?.fullName);
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const names = batch.map((b) => String(b.fullName));
    let records: any[] = [];
    try {
      const raw = await scheduleMetadata(() => conn.metadata.read(type, names));
      records = Array.isArray(raw) ? raw : raw ? [raw] : [];
    } catch {
      continue;
    }
    for (let j = 0; j < records.length; j++) {
      const r = records[j];
      const meta = batch[j];
      const name = r?.fullName ?? meta?.fullName ?? names[j];
      const lastMod = meta?.lastModifiedDate ?? "";
      const namespace = meta?.namespacePrefix ?? null;
      yield {
        ref: {
          category: METADATA_CATEGORY.OPAQUE,
          memberType: type,
          memberName: String(name),
          lastModifiedAt: lastMod ? String(lastMod) : null,
          sourceUri: `sf://${orgId}/${type}/${name}`,
          namespace,
        },
        content: JSON.stringify(r ?? {}),
      };
    }
  }
}
