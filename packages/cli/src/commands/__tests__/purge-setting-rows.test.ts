import { describe, expect, it } from "vitest";
import { purgeReport } from "../purge-setting-rows.js";

describe("purgeReport", () => {
  it("reports the number of settings and succeeds when no vector is pending", () => {
    const r = purgeReport({ settings: 3, vectorsPending: 0 }, "00Dx", true);
    expect(r.message).toBe(
      "purge-setting-rows: removed row values from 3 custom setting(s) for org=00Dx",
    );
    expect(r.message).not.toContain("[object Object]");
    expect(r.warning).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });

  it("warns and exits 1 when vectors are pending, naming why", () => {
    const off = purgeReport({ settings: 2, vectorsPending: 2 }, "00Dx", false);
    expect(off.exitCode).toBe(1);
    expect(off.warning).toContain("NOT finished");
    expect(off.warning).toContain("vector store is unavailable");
    expect(purgeReport({ settings: 2, vectorsPending: 1 }, "00Dx", true).warning).toContain(
      "a delete failed",
    );
  });
});
