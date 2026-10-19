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
import {
  type FetchFailure,
  type RetryOptions,
  catchInto,
  throwIfIncomplete,
  withRetry,
} from "../retry.js";

const BATCH = 10;

/**
 * Members per `metadata.read` call, by type (default BATCH). Profiles are read
 * one per call (cycle 2 T2): on a large live org each of the 109 Profiles is about
 * 2.9 MB of XML. A 10-Profile call took 78 s and raised the main heap by
 * about 170 MB while jsforce parsed the SOAP body; with 4 such calls in
 * flight the live-org ingest peaked at 2.35-2.45 GB RSS. The same 10 Profiles
 * read one per call, 4 at a time, took 32 s, and only 4 Profiles are in
 * flight at once.
 */
export const SECURITY_READ_BATCH: Readonly<Record<string, number>> = { Profile: 1 };
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
async function* iterType(
  conn: any,
  type: string,
  failures: FetchFailure[],
  retryOpts: RetryOptions,
): AsyncIterable<RawMember> {
  const onFailed = (names: string[], error: unknown) => {
    for (const name of names) failures.push({ name: `${type}:${name}`, error });
  };
  const list = (await withRetry(
    () =>
      scheduleMetadata(() =>
        withTimeout(
          conn.metadata.list([{ type }]),
          METADATA_LIST_TIMEOUT_MS,
          `metadata.list ${type}`,
        ),
      ),
    retryOpts,
  )) as MdListItem[] | null;
  const items = Array.isArray(list) ? list : [];
  const category = TYPE_TO_CATEGORY[type] ?? METADATA_CATEGORY.SECURITY;
  const batches: MdListItem[][] = [];
  const size = SECURITY_READ_BATCH[type] ?? BATCH;
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
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
      records: await readMetadataBatchAdaptive(conn, type, batch, 0, onFailed),
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

export async function* iterSecurity(
  conn: any,
  retryOpts: RetryOptions = {},
): AsyncIterable<RawMember> {
  // Run all three types in parallel — they all schedule through the same
  // Metadata pool, but the pool's 5-wide budget is now actually utilised
  // (previously: Profile finished entirely before PermissionSet started).
  // mergeAsyncIterablesParallel treats a rejected sub-stream as silently
  // done, so each type is wrapped with catchInto and every loss (failed
  // list, unreadable members) is re-thrown once all three types finished.
  const failures: FetchFailure[] = [];
  const types = ["Profile", "PermissionSet", "SharingRules"];
  yield* mergeAsyncIterablesParallel(
    ...types.map((t) => catchInto(t, iterType(conn, t, failures, retryOpts), failures)),
  );
  throwIfIncomplete("security", failures);
}
