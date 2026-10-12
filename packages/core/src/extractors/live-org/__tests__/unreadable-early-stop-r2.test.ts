import { asOrgId } from "@ryanstark24/sfgraph-shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type IngestSkipReport, bulkRetrieve, skipEntriesFor } from "../bulk-retrieve.js";
import type { OrgCapabilities } from "../capabilities.js";
import { iterGenericMetadata } from "../extractors/generic-metadata.js";
import { limiter, metadataPool } from "../rate-limit.js";
import { IncompleteSourceError, TypeUnreadableError, UNREADABLE_EARLY_STOP } from "../retry.js";
import { buildJsforceMock } from "./_jsforce-mock.js";

/**
 * Re-review N1 / N2 on the early stop (controller ruling):
 *  (a) any successful read of the type — in flight included — cancels it;
 *  (b) the signature is the full normalised message, not the matched pattern;
 *  (c) it is off when the run explicitly names the label (--retry-skipped /
 *      --only), so an explicit re-run reads every member.
 * N2: the stop entry carries the refusal of the type's first member and
 * states the count that actually matched.
 */

function sfFault(code: string, message: string): Error {
  const e = new Error(message) as Error & { errorCode: string };
  e.name = `sf:${code}`;
  e.errorCode = `sf:${code}`;
  return e;
}

const TYPE = "QuickAction";
const names = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `M${from + i}`);
const idx = (n: string) => Number(n.slice(1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gack = () => sfFault("UNKNOWN_EXCEPTION", "UNKNOWN_EXCEPTION: unexpected metadata");

/** `outcomeFor(name)` → an Error to fail the read with, or null to return
 *  the record; `delayFor(batch)` → ms to wait before answering. */
function orgWith(
  members: string[],
  outcomeFor: (name: string) => Error | null,
  delayFor: (batch: string[]) => number = () => 0,
) {
  const requested = new Set<string>();
  const conn = buildJsforceMock({
    metadataList: { [TYPE]: members.map((fullName) => ({ fullName })) },
  });
  conn.metadata.read = async (_t: string, batch: string[]) => {
    for (const n of batch) requested.add(n);
    const ms = delayFor(batch);
    if (ms > 0) await sleep(ms);
    for (const n of batch) {
      const err = outcomeFor(n);
      if (err) throw err;
    }
    return batch.map((fullName) => ({ fullName }));
  };
  return { conn, requested };
}

async function run(conn: unknown, opts?: { earlyStop?: boolean }) {
  const read: string[] = [];
  let error: unknown;
  try {
    for await (const m of iterGenericMetadata(conn, "00Dxx", TYPE, {}, opts))
      read.push(m.ref.memberName);
  } catch (e) {
    error = e;
  }
  const failures = error instanceof IncompleteSourceError ? error.failures : [];
  const stop = failures.find((f) => f.error instanceof TypeUnreadableError);
  return { read, error, failures, stop };
}

beforeEach(async () => {
  await metadataPool.incrementReservoir(10_000);
  await limiter.incrementReservoir(10_000);
});

describe("early stop (a): any successful read of the type cancels it", () => {
  it("first 10 refused identically, the in-flight batches and the rest readable → every readable member is yielded", async () => {
    // Batch 0 bisects and confirms each refusal (~15 calls); readable reads
    // take 40 ms, so when batch 0 settles most batches are not launched yet.
    const members = names(300);
    const { conn } = orgWith(
      members,
      (n) => (idx(n) < 10 ? gack() : null),
      (batch) => (batch.some((n) => idx(n) >= 10) ? 40 : 0),
    );
    const { read, stop } = await run(conn);
    expect(stop).toBeUndefined();
    expect(read.sort()).toEqual(members.slice(10).sort());
  });

  it("a read that lands AFTER the stop fired resumes the type", async () => {
    // Batch 0 is refused at once; the in-flight batches 1-3 answer later
    // (successfully), when the stop has already been decided.
    const members = names(80);
    const { conn } = orgWith(
      members,
      (n) => (idx(n) < 10 ? gack() : null),
      (batch) => (batch.some((n) => idx(n) >= 10 && idx(n) < 40) ? 400 : 0),
    );
    const { read, stop } = await run(conn);
    expect(stop).toBeUndefined();
    expect(read.sort()).toEqual(members.slice(10).sort());
  });
});

describe("early stop (b): the signature is the full normalised message", () => {
  it("10 different `targetObject is invalid` refusals are NOT one signature", async () => {
    const members = names(60);
    const { conn, requested } = orgWith(members, (n) =>
      sfFault("UNKNOWN_EXCEPTION", `UNKNOWN_EXCEPTION: targetObject is invalid: Obj_${n}__c`),
    );
    const { stop } = await run(conn);
    expect(stop).toBeUndefined();
    expect(requested.size).toBe(members.length);
  });

  it("10 identical `targetObject is invalid` refusals still stop", async () => {
    const members = names(60);
    const { conn, requested } = orgWith(members, () =>
      sfFault("UNKNOWN_EXCEPTION", "UNKNOWN_EXCEPTION: targetObject is invalid"),
    );
    const { stop } = await run(conn);
    expect(stop).toBeDefined();
    expect(requested.size).toBeLessThan(members.length);
  });
});

describe("early stop (c): off for an explicit re-run of the label", () => {
  it("iterGenericMetadata({ earlyStop: false }) reads every member", async () => {
    const members = names(60);
    const { conn, requested } = orgWith(members, gack);
    const { stop, failures } = await run(conn, { earlyStop: false });
    expect(stop).toBeUndefined();
    expect(requested.size).toBe(members.length);
    expect(failures).toHaveLength(members.length);
  });

  const caps: OrgCapabilities = {
    detectedNamespaces: [],
    vlocityNamespaces: [],
    vlocityLegacy: false,
    vlocityCmt: false,
    omnistudioOncore: false,
    agentforce: false,
    experienceCloud: false,
    sourceTracking: false,
  } as unknown as OrgCapabilities;

  async function viaBulk(explicitOnlyLabels: boolean) {
    const members = names(60);
    const { conn, requested } = orgWith(members, gack);
    conn.metadata.describe = async () => ({
      metadataObjects: [{ xmlName: TYPE, childXmlNames: [] }],
    });
    const skipReport: IngestSkipReport = { skips: [] };
    for await (const _ of bulkRetrieve(conn, caps, asOrgId("00Dxx0000000R2SAAA"), {
      skipReport,
      onlyLabels: new Set([`generic:${TYPE}`]),
      ...(explicitOnlyLabels ? { explicitOnlyLabels } : {}),
    })) {
      /* consume */
    }
    return { requested, members };
  }

  it("bulkRetrieve({ explicitOnlyLabels }) passes it down: every member is read", async () => {
    const { requested, members } = await viaBulk(true);
    expect(requested.size).toBe(members.length);
  });

  it("without it (in-run auto-retry), the early stop still applies", async () => {
    const { requested, members } = await viaBulk(false);
    expect(requested.size).toBeLessThan(members.length);
  });
});

describe("early stop entry (N2): first member's refusal, matched count", () => {
  it("names the refusal of the first member, not an earlier transient failure", async () => {
    // Batch 0 (the first 10 members) is refused, slowly; batch 1 fails
    // transiently first; batches 2-3 refused identically to batch 0.
    const members = names(80);
    const { conn } = orgWith(
      members,
      (n) => (idx(n) >= 10 && idx(n) < 20 ? new Error("socket hang up (ECONNRESET)") : gack()),
      (batch) => (batch.some((n) => idx(n) < 10) ? 30 : 0),
    );
    const { error, stop, failures } = await run(conn);
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect((failures[0]?.error as Error).message).toMatch(/socket hang up/);
    expect(stop).toBeDefined();
    expect(((stop?.error as TypeUnreadableError).cause as Error).message).toMatch(
      /unexpected metadata/,
    );
    const entry = skipEntriesFor(`generic:${TYPE}`, error as Error).find(
      (e) => e.category === "unreadable",
    );
    expect(entry?.reason).toContain(
      `stopped reading the type after ${UNREADABLE_EARLY_STOP} identical refusals`,
    );
    expect(entry?.reason).toMatch(/first error: UNKNOWN_EXCEPTION: unexpected metadata/);
  });
});
