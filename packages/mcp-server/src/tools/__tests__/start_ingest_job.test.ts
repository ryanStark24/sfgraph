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

  it("renders filesystem source with shell-quoted path", async () => {
    const r = await callTool("start_ingest_job", {
      source: { type: "filesystem", path: "/tmp/x" },
    });
    const d = r.data as { run_this_command: string };
    expect(d.run_this_command).toContain("sfgraph ingest --from-fs '/tmp/x'");
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

  it("shell-escapes embedded single quotes in filesystem path", async () => {
    const r = await callTool("start_ingest_job", {
      source: { type: "filesystem", path: "/tmp/it's a path" },
    });
    const d = r.data as { run_this_command: string };
    // POSIX escape: split single-quoted segments and concatenate the escaped quote.
    expect(d.run_this_command).toContain("'/tmp/it'\\''s a path'");
  });

  it("rejects filesystem path containing a newline (command-injection guard)", async () => {
    await expect(
      callTool("start_ingest_job", {
        source: { type: "filesystem", path: "/tmp/x\nrm -rf ~" },
      }),
    ).rejects.toThrow();
  });
});
