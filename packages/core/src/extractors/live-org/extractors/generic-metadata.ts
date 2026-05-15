import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import {
  METADATA_LIST_TIMEOUT_MS,
  readMetadataBatchAdaptive,
  scheduleMetadata,
  withTimeout,
} from "../rate-limit.js";

const BATCH = 10;

/**
 * Generic metadata.list + metadata.read iterator for any type that doesn't
 * have a dedicated extractor. Failures are silent (type may simply not be
 * retrievable in this org).
 *
 * **Managed-package handling**. metadata.list returns items with a
 * `namespacePrefix` field. For managed-package items, Salesforce returns
 * `<hidden>` / `(hidden)` content on metadata.read — but the read call
 * itself often takes 5-15 seconds per call (Salesforce has to process and
 * redact the response for every file). For an org with hundreds of
 * managed metadata items, that adds tens of minutes to ingest for content
 * that's unusable anyway. We split items into user-namespace (read
 * normally) and managed (emit metadata-only stub, skip read) — same
 * pattern as the LWC extractor's managed-package handling.
 *
 * Override: SFGRAPH_INCLUDE_MANAGED=1 (global) reads managed items too.
 */
export async function* iterGenericMetadata(
  conn: any,
  orgId: string,
  type: string,
): AsyncIterable<RawMember> {
  let list: any[] = [];
  try {
    const raw = await scheduleMetadata(() =>
      withTimeout(conn.metadata.list([{ type }]), METADATA_LIST_TIMEOUT_MS, `metadata.list ${type}`),
    );
    list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  } catch {
    return;
  }
  const allItems = list.filter((l) => l?.fullName);
  const includeManaged = process.env.SFGRAPH_INCLUDE_MANAGED === "1";
  // Split into managed (skip read, emit stub) vs user-namespace (read normally).
  const managed: any[] = [];
  const items: any[] = [];
  for (const item of allItems) {
    if (item?.namespacePrefix && !includeManaged) {
      managed.push(item);
    } else {
      items.push(item);
    }
  }
  // Emit metadata-only stubs for managed-package items first — preserves
  // inventory signal (these still appear in list_orgs / cross_org_diff)
  // without the multi-second-per-call metadata.read on redacted content.
  for (const item of managed) {
    yield {
      ref: {
        category: METADATA_CATEGORY.OPAQUE,
        memberType: type,
        memberName: String(item.fullName),
        lastModifiedAt: item.lastModifiedDate ? String(item.lastModifiedDate) : null,
        sourceUri: `sf://${orgId}/${type}/${item.fullName}`,
        namespace: item.namespacePrefix ?? null,
      },
      content: JSON.stringify({ fullName: item.fullName, managed: true }),
    };
  }
  // Stream batches as they complete, with per-batch timeout and bounded
  // concurrency. Previous implementation used Promise.all over ALL batches
  // before yielding anything — one hung batch (very common for Layout /
  // Workflow / CustomLabel against a managed-package-heavy org) parked the
  // entire source forever with zero observable progress. Now: at most
  // BATCH_WINDOW batches in flight, each with a 45s timeout, results
  // yielded as each batch returns.
  const batches: any[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const BATCH_WINDOW = 4;
  type Settled = { idx: number; batch: any[]; records: (unknown | null)[] };
  const inFlight = new Map<number, Promise<Settled>>();
  let nextBatch = 0;
  const launchBatch = (idx: number): void => {
    const batch = batches[idx];
    if (!batch) return;
    const p = (async (): Promise<Settled> => ({
      idx,
      batch,
      records: await readMetadataBatchAdaptive(conn, type, batch),
    }))();
    inFlight.set(idx, p);
  };
  while (inFlight.size < BATCH_WINDOW && nextBatch < batches.length) {
    launchBatch(nextBatch++);
  }
  while (inFlight.size > 0) {
    const { idx, batch, records } = await Promise.race(inFlight.values());
    inFlight.delete(idx);
    if (nextBatch < batches.length) launchBatch(nextBatch++);
    for (let j = 0; j < batch.length; j++) {
      const r = records[j];
      if (r === null) continue;
      const meta = batch[j];
      const rec = r as { fullName?: string };
      const name = rec?.fullName ?? meta?.fullName;
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
