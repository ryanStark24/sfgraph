import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleMetadata } from "../rate-limit.js";

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
    const raw = await scheduleMetadata(() => conn.metadata.list([{ type }]));
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
  // Fan out batch reads in parallel; the Metadata pool throttles concurrency.
  // Per-batch errors are swallowed (some metadata types are list-able but
  // not read-able with the running user's permissions).
  const batches: any[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      const names = batch.map((b) => String(b.fullName));
      try {
        const raw = await scheduleMetadata(() => conn.metadata.read(type, names));
        return Array.isArray(raw) ? raw : raw ? [raw] : [];
      } catch {
        return null; // skip this batch entirely
      }
    }),
  );
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const records = batchResults[b];
    if (!batch || !records) continue;
    const names = batch.map((b2) => String(b2.fullName));
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
