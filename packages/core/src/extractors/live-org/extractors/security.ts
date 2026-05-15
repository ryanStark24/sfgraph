import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY, type MetadataCategory } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { mergeAsyncIterablesParallel } from "../bulk-retrieve.js";
import {
  METADATA_LIST_TIMEOUT_MS,
  readMetadataBatchAdaptive,
  scheduleMetadata,
  withTimeout,
} from "../rate-limit.js";

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

/**
 * Stream one metadata type. Sliding-window of batch reads through the
 * Metadata pool — each batch yields its records as soon as it returns,
 * instead of waiting for every batch to finish before any yield. Critical
 * for failSoft's inactivity timer: the previous `await Promise.allSettled`
 * could park here for minutes with zero yields, getting the source killed
 * by the 180s inactivity timeout on slow orgs.
 */
async function* iterType(conn: any, type: string): AsyncIterable<RawMember> {
  const list = (await scheduleMetadata(() =>
    withTimeout(conn.metadata.list([{ type }]), METADATA_LIST_TIMEOUT_MS, `metadata.list ${type}`),
  )) as MdListItem[] | null;
  const items = Array.isArray(list) ? list : [];
  const category = TYPE_TO_CATEGORY[type] ?? METADATA_CATEGORY.SECURITY;
  const batches: MdListItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const BATCH_WINDOW = 4;
  type Settled = { idx: number; batch: MdListItem[]; records: (unknown | null)[] };
  const inFlight = new Map<number, Promise<Settled>>();
  let nextBatch = 0;
  const launch = (idx: number): void => {
    const batch = batches[idx];
    if (!batch) return;
    const p = (async (): Promise<Settled> => ({
      idx,
      batch,
      records: await readMetadataBatchAdaptive(conn, type, batch),
    }))();
    inFlight.set(idx, p);
  };
  while (inFlight.size < BATCH_WINDOW && nextBatch < batches.length) launch(nextBatch++);
  while (inFlight.size > 0) {
    const { idx, batch, records } = await Promise.race(inFlight.values());
    inFlight.delete(idx);
    if (nextBatch < batches.length) launch(nextBatch++);
    for (let j = 0; j < batch.length; j += 1) {
      const meta = batch[j];
      if (!meta) continue;
      const obj = records[j];
      if (obj === null) continue; // adaptive helper exhausted retries for this item
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
  // Run all three types in parallel — they all schedule through the same
  // Metadata pool, but the pool's 5-wide budget is now actually utilised
  // (previously: Profile finished entirely before PermissionSet started).
  yield* mergeAsyncIterablesParallel(
    iterType(conn, "Profile"),
    iterType(conn, "PermissionSet"),
    iterType(conn, "SharingRules"),
  );
}
