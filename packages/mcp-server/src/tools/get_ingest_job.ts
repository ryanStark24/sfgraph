import { defineTool, z } from "./_define.js";
import { getJob } from "./_job-store.js";

const inputSchema = z.object({ job_id: z.string().min(1) });

defineTool({
  name: "get_ingest_job",
  description: "Fetch state of an ingest job by id.",
  inputSchema,
  async execute(input) {
    const job = getJob(input.job_id);
    if (!job) {
      return {
        summary: `unknown job ${input.job_id}`,
        markdown: `> No job with id \`${input.job_id}\``,
        data: { found: false },
      };
    }
    return {
      summary: `job ${job.job_id} is ${job.state}`,
      markdown: `Job \`${job.job_id}\` — state **${job.state}** — progress ${job.progress.processed}/${job.progress.total}`,
      data: job,
    };
  },
});
