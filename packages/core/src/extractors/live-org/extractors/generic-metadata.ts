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
  IncompleteSourceError,
  type RetryOptions,
  TypeUnreadableError,
  UNREADABLE_EARLY_STOP,
  classifyFinalError,
  isOrgRejection,
  isPlatformRefusal,
  throwIfIncomplete,
  unreadableSignature,
  withRetry,
} from "../retry.js";

const BATCH = 10;

/**
 * The Metadata API type to pass to metadata.read for a listed member.
 * `Settings` is list-only: listMetadata(`Settings`) returns one member per
 * settings type (`Account`, `Chatter`, ...), but readMetadata(`Settings`)
 * fails with "type is not a valid metadata type for reading" — each member
 * must be read as `<fullName>Settings` (`AccountSettings`/`Account`).
 */
export function readTypeFor(listType: string, fullName: string): string {
  return listType === "Settings" ? `${fullName}Settings` : listType;
}

/**
 * Generic metadata.list + metadata.read iterator for any type that doesn't
 * have a dedicated extractor. A type the org rejects outright
 * (INVALID_TYPE / not supported) ends quietly; any other list or read
 * failure is retried and then surfaced as an IncompleteSourceError so the
 * `generic:<Type>` source becomes a skip (and `--retry-skipped` re-runs it)
 * instead of logging ✓ with members missing. Members (or a listing) the org
 * refuses identically on every attempt carry a PlatformRefusalError, which
 * the skip report files as `unreadable` (listed, never auto-retried).
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
export interface GenericMetadataOpts {
  /** Stop reading a type whose first members are all refused identically
   *  (default on). Off when the run explicitly names the label
   *  (--retry-skipped / --only): an explicit re-run reads every member. */
  earlyStop?: boolean;
}

export async function* iterGenericMetadata(
  conn: any,
  orgId: string,
  type: string,
  retryOpts: RetryOptions = {},
  opts: GenericMetadataOpts = {},
): AsyncIterable<RawMember> {
  const earlyStop = opts.earlyStop ?? true;
  let list: any[] = [];
  const listAttempts: unknown[] = [];
  try {
    const raw = await withRetry(
      () =>
        scheduleMetadata(() =>
          withTimeout(
            conn.metadata.list([{ type }]),
            METADATA_LIST_TIMEOUT_MS,
            `metadata.list ${type}`,
          ),
        ).catch((e: unknown) => {
          listAttempts.push(e);
          throw e;
        }),
      retryOpts,
    );
    list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  } catch (e) {
    // The type genuinely isn't available in this org: nothing to fetch.
    if (isOrgRejection(e)) return;
    // The org refused the listing the same way on every attempt (e.g.
    // `ManagedTopic`: "Invalid input. See ManagedTopics documentation.") —
    // an unreadable type, not a retryable loss.
    const final = classifyFinalError(listAttempts.length > 0 ? listAttempts : [e]);
    if (isPlatformRefusal(final)) {
      throw new IncompleteSourceError(`generic:${type}`, [
        { name: `metadata.list ${type}`, error: final },
      ]);
    }
    throw e;
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
  // One metadata.read call reads a single type, so batch per read type
  // (always `type`, except list-only types such as Settings).
  const byReadType = new Map<string, any[]>();
  for (const item of items) {
    const rt = readTypeFor(type, String(item.fullName));
    const group = byReadType.get(rt) ?? [];
    group.push(item);
    byReadType.set(rt, group);
  }
  const batches: { readType: string; items: any[] }[] = [];
  for (const [readType, group] of byReadType) {
    for (let i = 0; i < group.length; i += BATCH) {
      batches.push({ readType, items: group.slice(i, i + BATCH) });
    }
  }
  const BATCH_WINDOW = 4;
  const failures: FetchFailure[] = [];
  // Per-member outcome, for the early stop below: the refusal signature of a
  // member reported via onFailed, "read" / "missing" once its batch settled.
  const outcome = new Map<string, string | undefined>();
  const errorOf = new Map<string, unknown>();
  // Any member read successfully (in-flight batches included) proves the
  // type readable: the early stop is off for good (review N1a).
  let anyRead = false;
  const onFailed = (names: string[], error: unknown): void => {
    for (const name of names) {
      failures.push({ name, error });
      errorOf.set(name, error);
      outcome.set(name, unreadableSignature(error) ?? "failed");
    }
  };
  // Early stop: when the type's first UNREADABLE_EARLY_STOP members (in list
  // order) have all been refused with one unreadable signature, the type is
  // unreadable on this org — stop launching batches instead of paying a
  // bisect plus per-member confirmation reads for every remaining member
  // (WorkflowFlowAutomation: 463 identical "unexpected metadata" refusals).
  // Keep going when: fewer than that many members; a missing record or a
  // differing error among them; ANY member of the type read successfully —
  // including a batch that was still in flight when the stop was decided,
  // which resumes launching; or the run explicitly names this label. The
  // signature is the full normalised message (see unreadableSignature).
  const firstMembers = batches
    .flatMap((b) => b.items.map((i) => String(i.fullName)))
    .slice(0, UNREADABLE_EARLY_STOP);
  const typeIsUnreadable = (): boolean => {
    if (!earlyStop || anyRead) return false;
    if (firstMembers.length < UNREADABLE_EARLY_STOP) return false;
    const sigs = firstMembers.map((n) => outcome.get(n));
    const first = sigs[0];
    return (
      first !== undefined &&
      first !== "read" &&
      first !== "missing" &&
      first !== "failed" &&
      sigs.every((sig) => sig === first)
    );
  };
  type Settled = { idx: number; batch: any[]; records: (unknown | null)[] };
  const inFlight = new Map<number, Promise<Settled>>();
  let nextBatch = 0;
  const launchBatch = (idx: number): void => {
    const entry = batches[idx];
    if (!entry) return;
    const batch = entry.items;
    const p = (async (): Promise<Settled> => ({
      idx,
      batch,
      records: await readMetadataBatchAdaptive(conn, entry.readType, batch, 0, onFailed),
    }))();
    inFlight.set(idx, p);
  };
  while (inFlight.size < BATCH_WINDOW && nextBatch < batches.length) {
    launchBatch(nextBatch++);
  }
  while (inFlight.size > 0) {
    const { idx, batch, records } = await Promise.race(inFlight.values());
    inFlight.delete(idx);
    batch.forEach((item: any, j: number) => {
      const name = String(item?.fullName);
      if (!outcome.has(name)) outcome.set(name, records[j] === null ? "missing" : "read");
      if (records[j] !== null && records[j] !== undefined) anyRead = true;
    });
    while (inFlight.size < BATCH_WINDOW && nextBatch < batches.length && !typeIsUnreadable()) {
      launchBatch(nextBatch++);
    }
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
  let unread = 0;
  for (let b = nextBatch; b < batches.length; b++) unread += batches[b]?.items.length ?? 0;
  if (unread > 0) {
    failures.push({
      name: `${unread} unread member(s)`,
      // The shared refusal is the first member's (review N2): failures[0] is
      // merely the first failure in time, possibly from another batch.
      error: new TypeUnreadableError(errorOf.get(firstMembers[0] ?? ""), unread),
    });
  }
  throwIfIncomplete(`generic:${type}`, failures);
}
