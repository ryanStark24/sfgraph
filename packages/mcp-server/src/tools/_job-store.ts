import { randomUUID } from "node:crypto";

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface IngestJob {
  job_id: string;
  state: JobState;
  source: unknown;
  mode: string;
  queue_position: number;
  started_at?: number;
  finished_at?: number;
  errors: string[];
  progress: { processed: number; total: number };
}

const jobs = new Map<string, IngestJob>();
const queue: string[] = [];

export function enqueueJob(source: unknown, mode: string): IngestJob {
  const id = `job_${randomUUID()}`;
  const job: IngestJob = {
    job_id: id,
    state: "queued",
    source,
    mode,
    queue_position: queue.length,
    errors: [],
    progress: { processed: 0, total: 0 },
  };
  jobs.set(id, job);
  queue.push(id);
  return job;
}

export function getJob(id: string): IngestJob | undefined {
  return jobs.get(id);
}

export function _resetJobStore(): void {
  jobs.clear();
  queue.length = 0;
}
