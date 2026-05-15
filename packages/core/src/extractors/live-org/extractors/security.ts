import { XMLBuilder } from "fast-xml-parser";
import { METADATA_CATEGORY, type MetadataCategory } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { mergeAsyncIterablesParallel } from "../bulk-retrieve.js";
import { scheduleMetadata } from "../rate-limit.js";

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
 * Stream one metadata type. All read-batches are fired concurrently through
 * the Metadata pool — Bottleneck throttles concurrency to the pool's
 * maxConcurrent (default 5), so memory stays bounded but we no longer
 * serialise batches behind a single in-flight call.
 *
 * Previously this used scheduleQuery (the Tooling pool) for Metadata API
 * calls — which routed Profile/PermSet/SharingRules through the wrong
 * budget, made `--metadata-pool` a no-op for them, and made them compete
 * with Apex/LWC SOQL.
 */
async function* iterType(conn: any, type: string): AsyncIterable<RawMember> {
  const list = (await scheduleMetadata(() =>
    conn.metadata.list([{ type }]),
  )) as MdListItem[] | null;
  const items = Array.isArray(list) ? list : [];
  const category = TYPE_TO_CATEGORY[type] ?? METADATA_CATEGORY.SECURITY;
  // Build batch boundaries first, then fire every batch's read in parallel.
  // The Metadata pool gates concurrency; the await on Promise.all means we
  // hold one batch's worth of XML per inflight job (typically <2 MB total).
  const batches: MdListItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  // allSettled, not all: if one batch's metadata.read rejects (perm error,
  // transient SF hiccup), the other in-flight batches must still resolve
  // cleanly — otherwise their rejections become unhandled and crash the
  // node process under Node 24's default rejection policy.
  const batchResults = await Promise.allSettled(
    batches.map((slice) =>
      scheduleMetadata(() =>
        conn.metadata.read(
          type,
          slice.map((s) => s.fullName),
        ),
      ),
    ),
  );
  for (let b = 0; b < batches.length; b++) {
    const slice = batches[b];
    if (!slice) continue;
    const settled = batchResults[b];
    if (!settled || settled.status === "rejected") continue;
    const reads = settled.value;
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
  // Run all three types in parallel — they all schedule through the same
  // Metadata pool, but the pool's 5-wide budget is now actually utilised
  // (previously: Profile finished entirely before PermissionSet started).
  yield* mergeAsyncIterablesParallel(
    iterType(conn, "Profile"),
    iterType(conn, "PermissionSet"),
    iterType(conn, "SharingRules"),
  );
}
