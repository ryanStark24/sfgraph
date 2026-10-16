import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
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
const xml = new XMLBuilder({
  ignoreAttributes: false,
  format: false,
  suppressEmptyNode: true,
});

interface MdListItem {
  fullName: string;
  lastModifiedDate?: string;
  namespacePrefix?: string;
}

/**
 * Streams Flow metadata reads through a sliding-window. Each batch yields
 * records as soon as it returns instead of waiting for all batches — keeps
 * failSoft's inactivity timer happy on orgs with many flows where the
 * full-collect pattern was breaching the 180s no-yield ceiling.
 */
export async function* iterFlow(conn: any, retryOpts: RetryOptions = {}): AsyncIterable<RawMember> {
  // Flows the adaptive reader gave up on; re-thrown at the end so failSoft
  // records a `flow` skip naming them (previously dropped silently).
  const failures: FetchFailure[] = [];
  const onFailed = (names: string[], error: unknown) => {
    for (const name of names) failures.push({ name, error });
  };
  const list = (await withRetry(
    () =>
      scheduleMetadata(() =>
        withTimeout(
          conn.metadata.list([{ type: "Flow" }]),
          METADATA_LIST_TIMEOUT_MS,
          "metadata.list Flow",
        ),
      ),
    retryOpts,
  )) as MdListItem[] | null;
  const items = Array.isArray(list) ? list : [];
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
      records: await readMetadataBatchAdaptive(conn, "Flow", batch, 0, onFailed),
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
      if (obj === null) continue;
      const content = xml.build({ Flow: obj });
      yield {
        ref: {
          category: METADATA_CATEGORY.FLOW,
          memberType: "Flow",
          memberName: meta.fullName,
          lastModifiedAt: meta.lastModifiedDate ?? null,
          sourceUri: `sf://metadata/Flow/${meta.fullName}`,
          namespace: meta.namespacePrefix ?? null,
        },
        content: typeof content === "string" ? content : String(content),
      };
    }
  }
  throwIfIncomplete("flow", failures);
}
