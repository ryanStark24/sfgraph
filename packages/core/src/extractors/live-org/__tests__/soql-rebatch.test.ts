import { beforeEach, describe, expect, it } from "vitest";
import { limiter } from "../rate-limit.js";
import { isRebatchableSoqlError, runSoqlInRebatchable } from "../rate-limit.js";

interface Row {
  Id: string;
}

function buildIds(n: number, prefix = "001"): string[] {
  return Array.from({ length: n }, (_, i) => `'${prefix}${String(i).padStart(12, "0")}'`);
}

describe("W2-05: isRebatchableSoqlError classifier", () => {
  it("matches 414/431 statusCodes", () => {
    expect(isRebatchableSoqlError({ statusCode: 414, message: "URI Too Long" })).toBe(true);
    expect(isRebatchableSoqlError({ statusCode: 431, message: "header too large" })).toBe(true);
  });

  it("matches jsforce error codes", () => {
    expect(isRebatchableSoqlError({ errorCode: "URI_TOO_LONG" })).toBe(true);
    expect(isRebatchableSoqlError({ errorCode: "REQUEST_HEADER_FIELDS_TOO_LARGE" })).toBe(true);
  });

  it("falls back to message matching", () => {
    expect(isRebatchableSoqlError(new Error("Request URI Too Long"))).toBe(true);
    expect(isRebatchableSoqlError(new Error("MALFORMED_QUERY: query body too many characters"))).toBe(
      true,
    );
  });

  it("rejects unrelated errors (auth, timeout, etc.)", () => {
    expect(isRebatchableSoqlError({ statusCode: 401 })).toBe(false);
    expect(isRebatchableSoqlError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isRebatchableSoqlError(new Error("soql Foo timeout (60000ms)"))).toBe(false);
  });
});

describe("W2-05: runSoqlInRebatchable", () => {
  beforeEach(async () => {
    // Bottleneck's reservoir is consumed by every scheduled call — refill so
    // tests doing 500+ runs don't stall waiting for the 60s refresh window.
    await limiter.incrementReservoir(10_000);
  });

  it("passes through a small ID set in a single call", async () => {
    const ids = buildIds(5);
    const calls: string[] = [];
    const records = await runSoqlInRebatchable<Row>({
      ids,
      template: "SELECT Id FROM X WHERE Id IN (${IDS})",
      label: "test small",
      runner: async (soql) => {
        calls.push(soql);
        return { records: ids.map((id) => ({ Id: id })) };
      },
    });
    expect(calls.length).toBe(1);
    expect(records.length).toBe(5);
  });

  it("pre-splits when ids.length exceeds rebatchAt", async () => {
    const ids = buildIds(700);
    const callBatchSizes: number[] = [];
    const records = await runSoqlInRebatchable<Row>({
      ids,
      template: "SELECT Id FROM X WHERE Id IN (${IDS})",
      label: "test large",
      rebatchAt: 300,
      runner: async (soql) => {
        // Count IDs by counting commas + 1
        const inClause = soql.match(/IN \(([^)]+)\)/);
        const count = inClause ? (inClause[1] ?? "").split(",").length : 0;
        callBatchSizes.push(count);
        return { records: [] };
      },
    });
    expect(records.length).toBe(0);
    // 700 ids @ rebatchAt=300 → ceil(700/300) = 3 chunks of (300, 300, 100)
    expect(callBatchSizes.length).toBe(3);
    expect(callBatchSizes.sort((a, b) => a - b)).toEqual([100, 300, 300]);
  });

  it("recursively halves on a rebatchable error", async () => {
    const ids = buildIds(8);
    let firstCall = true;
    const sizes: number[] = [];
    await runSoqlInRebatchable<Row>({
      ids,
      template: "SELECT Id FROM X WHERE Id IN (${IDS})",
      label: "test rebatch",
      rebatchAt: 8, // don't pre-split; force the error path to do it
      runner: async (soql) => {
        const inClause = soql.match(/IN \(([^)]+)\)/);
        const count = inClause ? (inClause[1] ?? "").split(",").length : 0;
        sizes.push(count);
        if (firstCall) {
          firstCall = false;
          const err = new Error("Request URI Too Long") as Error & { statusCode: number };
          err.statusCode = 414;
          throw err;
        }
        return { records: [] };
      },
    });
    // First call (size 8) fails; helper splits into 4 + 4 which both succeed.
    expect(sizes[0]).toBe(8);
    expect(sizes.slice(1).sort()).toEqual([4, 4]);
  });

  it("does NOT rebatch on non-rebatchable errors — caller's failSoft handles them", async () => {
    const ids = buildIds(4);
    let calls = 0;
    await expect(
      runSoqlInRebatchable<Row>({
        ids,
        template: "SELECT Id FROM X WHERE Id IN (${IDS})",
        label: "test no-rebatch",
        rebatchAt: 4,
        runner: async () => {
          calls += 1;
          throw new Error("INVALID_FIELD: no such column 'Bogus__c'");
        },
      }),
    ).rejects.toThrow(/INVALID_FIELD/);
    expect(calls).toBe(1);
  });

  it("rejects a template without the IDS placeholder", async () => {
    await expect(
      runSoqlInRebatchable<Row>({
        ids: buildIds(1),
        template: "SELECT Id FROM X",
        label: "test bad template",
        runner: async () => ({ records: [] }),
      }),
    ).rejects.toThrow(/IDS/);
  });
});
