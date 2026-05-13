import { describe, expect, it } from "vitest";
import { callTool } from "./_runner.js";

describe("ping tool", () => {
  it("returns ok with ts", async () => {
    const r = await callTool("ping", {});
    expect((r.data as { ok: boolean }).ok).toBe(true);
    expect(typeof (r.data as { ts: number }).ts).toBe("number");
  });
});
