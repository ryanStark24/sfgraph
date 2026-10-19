import { beforeEach, describe, expect, it } from "vitest";
import { skipEntriesFor } from "../bulk-retrieve.js";
import { iterGenericMetadata } from "../extractors/generic-metadata.js";
import { metadataPool } from "../rate-limit.js";
import { IncompleteSourceError, TypeUnreadableError, UNREADABLE_EARLY_STOP } from "../retry.js";
import { buildJsforceMock } from "./_jsforce-mock.js";

/**
 * WorkflowFlowAutomation on a large live org: all 463 members refused with the same
 * "UNKNOWN_EXCEPTION: unexpected metadata", each paying a bisect plus a
 * per-member retry. Once the type's first 10 members (list order) all fail
 * with one unreadable signature, the extractor stops reading the type and
 * files a type-level unreadable skip with the unread count. Fewer than 10
 * members, differing errors, or a successful read among them: keep going.
 */

function sfFault(code: string, message: string): Error {
  const e = new Error(message) as Error & { errorCode: string };
  e.name = `sf:${code}`;
  e.errorCode = `sf:${code}`;
  return e;
}

const TYPE = "WorkflowFlowAutomation";
const names = (n: number, prefix = "M") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** Mock org listing `members`; a read that includes any name `refuse()`
 *  returns an error for fails the whole call (as the Metadata API does). */
function orgWith(members: string[], refuse: (name: string) => Error | null) {
  const requested = new Set<string>();
  const conn = buildJsforceMock({
    metadataList: { [TYPE]: members.map((fullName) => ({ fullName })) },
    metadataRead: {
      [TYPE]: (batch: string[]) => {
        for (const n of batch) requested.add(n);
        for (const n of batch) {
          const err = refuse(n);
          if (err) throw err;
        }
        return batch.map((fullName) => ({ fullName }));
      },
    },
  });
  return { conn, requested };
}

async function run(conn: unknown) {
  const read: string[] = [];
  let error: unknown;
  try {
    for await (const m of iterGenericMetadata(conn, "00Dxx", TYPE)) read.push(m.ref.memberName);
  } catch (e) {
    error = e;
  }
  return { read, error };
}

const unexpected = () => sfFault("UNKNOWN_EXCEPTION", "UNKNOWN_EXCEPTION: unexpected metadata");

describe("generic metadata: early stop on an unreadable type", () => {
  beforeEach(async () => {
    await metadataPool.incrementReservoir(10_000);
  });

  it("stops after the first 10 identical refusals and records the unread count", async () => {
    const members = names(120);
    const { conn, requested } = orgWith(members, unexpected);
    const { read, error } = await run(conn);
    expect(read).toEqual([]);
    expect(error).toBeInstanceOf(IncompleteSourceError);
    const failures = (error as IncompleteSourceError).failures;
    const stop = failures.find((f) => f.error instanceof TypeUnreadableError);
    expect(stop).toBeDefined();
    const unread = (stop?.error as TypeUnreadableError).unreadCount;
    // Only the batches already in flight were read; the rest never requested.
    expect(requested.size).toBeGreaterThanOrEqual(UNREADABLE_EARLY_STOP);
    expect(requested.size).toBeLessThan(members.length);
    expect(unread).toBe(members.length - requested.size);
    expect(failures.length - 1).toBe(requested.size);
    // One `unreadable` skip, naming the stop and the unread count.
    const entries = skipEntriesFor(`generic:${TYPE}`, error as Error);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.category).toBe("unreadable");
    expect(entries[0]?.reason).toContain(`${unread} more member(s) not read`);
    expect(entries[0]?.reason).toContain("unexpected metadata");
  });

  it("keeps going when fewer than 10 members failed (the rest are readable)", async () => {
    const bad = new Set(names(UNREADABLE_EARLY_STOP - 1, "Bad"));
    const members = [...bad, ...names(60)];
    const { conn, requested } = orgWith(members, (n) => (bad.has(n) ? unexpected() : null));
    const { read, error } = await run(conn);
    expect(requested.size).toBe(members.length);
    expect(read).toHaveLength(60);
    const failures = (error as IncompleteSourceError).failures;
    expect(failures).toHaveLength(bad.size);
    expect(failures.some((f) => f.error instanceof TypeUnreadableError)).toBe(false);
  });

  it("a type with fewer than 10 members is read in full, all refused or not", async () => {
    const members = names(UNREADABLE_EARLY_STOP - 1);
    const { conn, requested } = orgWith(members, unexpected);
    const { error } = await run(conn);
    expect(requested.size).toBe(members.length);
    const failures = (error as IncompleteSourceError).failures;
    expect(failures).toHaveLength(members.length);
    expect(failures.some((f) => f.error instanceof TypeUnreadableError)).toBe(false);
  });

  it("keeps going when the first 10 failures carry different errors", async () => {
    const members = names(60);
    const { conn, requested } = orgWith(members, (n) =>
      Number(n.slice(1)) % 2 === 0
        ? unexpected()
        : sfFault("INVALID_CROSS_REFERENCE_KEY", "INVALID_CROSS_REFERENCE_KEY: no such column"),
    );
    const { read, error } = await run(conn);
    expect(read).toEqual([]);
    expect(requested.size).toBe(members.length);
    const failures = (error as IncompleteSourceError).failures;
    expect(failures).toHaveLength(members.length);
    expect(failures.some((f) => f.error instanceof TypeUnreadableError)).toBe(false);
  });

  it("keeps going when a member was read, even if 10+ others failed identically", async () => {
    // Batch 1 is "Ok0" + nine refused members; every later member is refused.
    const members = ["Ok0", ...names(59, "Bad")];
    const { conn, requested } = orgWith(members, (n) => (n === "Ok0" ? null : unexpected()));
    const { read, error } = await run(conn);
    expect(read).toEqual(["Ok0"]);
    expect(requested.size).toBe(members.length);
    const failures = (error as IncompleteSourceError).failures;
    expect(failures).toHaveLength(59);
    expect(failures.some((f) => f.error instanceof TypeUnreadableError)).toBe(false);
  });

  it("does not stop on transient failures (a retryable timeout is not unreadable)", async () => {
    const members = names(40);
    const { conn, requested } = orgWith(members, () => new Error("socket hang up (ECONNRESET)"));
    const { error } = await run(conn);
    expect(requested.size).toBe(members.length);
    expect(
      (error as IncompleteSourceError).failures.some((f) => f.error instanceof TypeUnreadableError),
    ).toBe(false);
  });
});
