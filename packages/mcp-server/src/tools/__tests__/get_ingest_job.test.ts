import { describe, expect, it } from "vitest";
import { _resetJobStore } from "../_job-store.js";
import { callTool } from "./_runner.js";

describe("get_ingest_job", () => {
  it("returns not-found for unknown id", async () => {
    _resetJobStore();
    const r = await callTool("get_ingest_job", { job_id: "job_does_not_exist" });
    expect((r.data as { found: boolean }).found).toBe(false);
  });

  it("returns the job after a manual enqueue (job store still functions even though start_ingest_job no longer writes to it)", async () => {
    _resetJobStore();
    const { enqueueJob } = await import("../_job-store.js");
    const job = enqueueJob({ type: "filesystem", path: "/tmp/x" }, "auto");
    const r = await callTool("get_ingest_job", { job_id: job.job_id });
    expect((r.data as { job_id: string }).job_id).toBe(job.job_id);
  });

  it("rejects empty job_id", async () => {
    _resetJobStore();
    await expect(callTool("get_ingest_job", { job_id: "" })).rejects.toThrow();
  });

  it("rejects missing job_id", async () => {
    _resetJobStore();
    await expect(callTool("get_ingest_job", {})).rejects.toThrow();
  });

  it("distinguishes between multiple jobs", async () => {
    _resetJobStore();
    const { enqueueJob } = await import("../_job-store.js");
    const j1 = enqueueJob({ type: "filesystem", path: "/tmp/a" }, "auto");
    const j2 = enqueueJob({ type: "filesystem", path: "/tmp/b" }, "auto");
    expect(j1.job_id).not.toBe(j2.job_id);
    const r1 = await callTool("get_ingest_job", { job_id: j1.job_id });
    const r2 = await callTool("get_ingest_job", { job_id: j2.job_id });
    expect((r1.data as { job_id: string }).job_id).toBe(j1.job_id);
    expect((r2.data as { job_id: string }).job_id).toBe(j2.job_id);
  });

  it("includes summary text identifying the unknown id", async () => {
    _resetJobStore();
    const r = await callTool("get_ingest_job", { job_id: "job_phantom" });
    expect(r.summary).toContain("job_phantom");
  });
});
