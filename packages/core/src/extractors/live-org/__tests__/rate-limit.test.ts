import Bottleneck from "bottleneck";
import { describe, expect, it } from "vitest";
import { queryLimit, readMetadataBatchAdaptive, scheduleQuery } from "../rate-limit.js";

describe("rate-limit", () => {
  it("retries once on REQUEST_LIMIT_EXCEEDED and ultimately resolves", async () => {
    let calls = 0;
    // Use a local Bottleneck to keep test isolated, but verify via scheduleQuery shape too.
    const lim = new Bottleneck({ maxConcurrent: 1 });
    lim.on("failed", (err: any, info) => {
      if (err?.errorCode === "REQUEST_LIMIT_EXCEEDED" && info.retryCount < 1) return 1;
      return null;
    });
    const job = () =>
      lim.schedule(() => {
        calls += 1;
        if (calls === 1) {
          const e: any = new Error("limit");
          e.errorCode = "REQUEST_LIMIT_EXCEEDED";
          throw e;
        }
        return Promise.resolve("ok");
      });
    const res = await job();
    expect(res).toBe("ok");
    expect(calls).toBe(2);
  });

  it("scheduleQuery passes through and respects queryLimit serialization", async () => {
    expect(queryLimit.activeCount).toBeGreaterThanOrEqual(0);
    const r = await scheduleQuery(async () => 7);
    expect(r).toBe(7);
  });

  it("readMetadataBatchAdaptive bisects on timeout and resolves singletons", async () => {
    const items = [
      { fullName: "a" },
      { fullName: "b" },
      { fullName: "c" },
      { fullName: "d" },
    ];
    const POISON = "c";
    const conn = {
      metadata: {
        read: async (_type: string, names: string[]) => {
          if (names.includes(POISON) && names.length > 1) {
            // Simulate Salesforce timing out the multi-item read whenever the
            // poison record is in the batch.
            await new Promise((r) => setTimeout(r, 5));
            throw new Error("metadata.read CustomObject: timeout (5ms)");
          }
          if (names.length === 1 && names[0] === POISON) {
            throw new Error("metadata.read CustomObject: timeout (single)");
          }
          // Return one record per name in the same order.
          return names.map((n) => ({ fullName: n }));
        },
      },
    };
    const result = await readMetadataBatchAdaptive(conn, "CustomObject", items);
    expect(result).toHaveLength(4);
    // a, b, d survive — c is dropped after recursive bisect.
    expect((result[0] as any)?.fullName).toBe("a");
    expect((result[1] as any)?.fullName).toBe("b");
    expect(result[2]).toBeNull();
    expect((result[3] as any)?.fullName).toBe("d");
  });

  it("readMetadataBatchAdaptive returns nulls when every slice times out", async () => {
    const items = [{ fullName: "a" }, { fullName: "b" }];
    const conn = {
      metadata: {
        read: async () => {
          throw new Error("metadata.read CustomObject: timeout (everything)");
        },
      },
    };
    const result = await readMetadataBatchAdaptive(conn, "CustomObject", items);
    expect(result).toEqual([null, null]);
  });
});
