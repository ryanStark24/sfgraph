import { describe, expect, it } from "vitest";
import { _resetJobStore } from "../_job-store.js";
import { callTool } from "./_runner.js";

describe("start_ingest_job", () => {
  it("enqueues a live-org job", async () => {
    _resetJobStore();
    const r = await callTool("start_ingest_job", {
      source: { type: "live-org", alias: "myorg" },
    });
    const d = r.data as { job_id: string; state: string; queue_position: number };
    expect(d.state).toBe("queued");
    expect(d.job_id).toMatch(/^job_/);
    expect(d.queue_position).toBe(0);
  });

  it("rejects invalid source", async () => {
    await expect(callTool("start_ingest_job", { source: { type: "nope" } })).rejects.toThrow();
  });
});
