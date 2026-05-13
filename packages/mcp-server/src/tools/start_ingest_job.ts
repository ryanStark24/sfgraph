import { defineTool, z } from "./_define.js";
import { enqueueJob } from "./_job-store.js";

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("live-org"), alias: z.string().min(1) }),
  z.object({ type: z.literal("filesystem"), path: z.string().min(1) }),
]);

const inputSchema = z.object({
  source: sourceSchema,
  mode: z.enum(["full", "incremental", "auto"]).default("auto"),
});

defineTool({
  name: "start_ingest_job",
  description: "Enqueue a metadata ingest job. Does not run synchronously.",
  inputSchema,
  async execute(input) {
    const job = enqueueJob(input.source, input.mode);
    return {
      summary: `queued ingest job ${job.job_id}`,
      markdown: `Job \`${job.job_id}\` queued at position ${job.queue_position}.`,
      data: {
        job_id: job.job_id,
        state: job.state,
        queue_position: job.queue_position,
      },
      follow_up_tools: ["get_ingest_job"],
    };
  },
});
