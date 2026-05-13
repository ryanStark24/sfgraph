import { describe, expect, it } from "vitest";
import { SfgraphMcpServer } from "../../server.js";

describe("dispatcher (server.dispatch)", () => {
  it("returns isError + UNKNOWN_TOOL for unregistered name", async () => {
    const s = new SfgraphMcpServer();
    await s.loadAllTools();
    const r = await s.dispatch("does_not_exist", {});
    expect(r.isError).toBe(true);
    expect(r._meta?.code).toBe("UNKNOWN_TOOL");
  });

  it("surfaces INVALID_INPUT on ZodError", async () => {
    const s = new SfgraphMcpServer();
    await s.loadAllTools();
    const r = await s.dispatch("start_ingest_job", { source: { type: "garbage" } });
    expect(r.isError).toBe(true);
    expect(r._meta?.code).toBe("INVALID_INPUT");
  });
});
