import { describe, expect, it } from "vitest";
import { _resetJobStore } from "../_job-store.js";
import { callTool } from "./_runner.js";

describe("get_ingest_job", () => {
  it("returns not-found for unknown id", async () => {
    _resetJobStore();
    const r = await callTool("get_ingest_job", { job_id: "job_does_not_exist" });
    expect((r.data as { found: boolean }).found).toBe(false);
  });

  it("returns the job after enqueue", async () => {
    _resetJobStore();
    const e = await callTool("start_ingest_job", {
      source: { type: "filesystem", path: "/tmp/x" },
    });
    const id = (e.data as { job_id: string }).job_id;
    const r = await callTool("get_ingest_job", { job_id: id });
    expect((r.data as { job_id: string }).job_id).toBe(id);
  });
});
