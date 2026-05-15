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
  NamedCredential: METADATA_CATEGORY.NAMED_CREDENTIAL,
  ExternalServiceRegistration: METADATA_CATEGORY.EXTERNAL_SERVICE_REGISTRATION,
};

async function* iterType(conn: any, type: string): AsyncIterable<RawMember> {
  const list = (await scheduleMetadata(() =>
    withTimeout(conn.metadata.list([{ type }]), METADATA_LIST_TIMEOUT_MS, `metadata.list ${type}`),
  )) as MdListItem[] | null;
  const items = Array.isArray(list) ? list : [];
  const category = TYPE_TO_CATEGORY[type] ?? METADATA_CATEGORY.INTEGRATION;
  const batches: MdListItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  // Streaming sliding-window — see security.ts iterType for rationale.
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
      if (obj === null) continue;
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
  yield* mergeAsyncIterablesParallel(
    iterType(conn, "NamedCredential"),
    iterType(conn, "ExternalServiceRegistration"),
  );
}
