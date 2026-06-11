import { describe, expect, it } from "vitest";
import { callTool } from "./_runner.js";

describe("start_ingest_job", () => {
  it("does NOT execute — returns the shell command for the user to run", async () => {
    const r = await callTool("start_ingest_job", {
      source: { type: "live-org", alias: "myorg" },
    });
    const d = r.data as { executed: boolean; run_this_command: string };
    expect(d.executed).toBe(false);
    expect(d.run_this_command).toContain("sfgraph ingest --org myorg");
    expect(r.markdown).toContain("MCP server cannot start ingests itself");
  });

  it("propagates --mode when not auto", async () => {
    const r = await callTool("start_ingest_job", {
      source: { type: "live-org", alias: "myorg" },
      mode: "incremental",
    });
    const d = r.data as { run_this_command: string };
    expect(d.run_this_command).toContain("--mode incremental");
  });

  it("rejects a filesystem source — there is no CLI filesystem ingest", async () => {
    await expect(
      callTool("start_ingest_job", { source: { type: "filesystem", path: "/tmp/x" } }),
    ).rejects.toThrow();
  });

  it("rejects invalid source", async () => {
    await expect(callTool("start_ingest_job", { source: { type: "nope" } })).rejects.toThrow();
  });

  it("rejects alias that fails validateOrgIdentifier (path separator)", async () => {
    await expect(
      callTool("start_ingest_job", {
        source: { type: "live-org", alias: "../escape" },
      }),
    ).rejects.toThrow();
  });

  it("rejects alias that fails validateOrgIdentifier (parent-dir traversal)", async () => {
    await expect(
      callTool("start_ingest_job", {
        source: { type: "live-org", alias: "myorg/../etc" },
      }),
    ).rejects.toThrow();
  });
});
