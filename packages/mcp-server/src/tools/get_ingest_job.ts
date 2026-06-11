import { defineTool, z } from "./_define.js";
import { getJob } from "./_job-store.js";

const inputSchema = z.object({ job_id: z.string().min(1) });

defineTool({
  name: "get_ingest_job",
  description:
    "Fetch state of an in-process ingest job by id. NOTE: the MCP server does not run ingest workers — `start_ingest_job` returns a shell command instead of enqueueing, so in normal use there are no jobs to fetch and this returns 'unknown job'. Jobs exist only when a host embeds the server and enqueues programmatically. To check whether an out-of-band `sfgraph ingest` landed, use staleness_check / freshness_report instead.",
  inputSchema,
  async execute(input) {
    const job = getJob(input.job_id);
    if (!job) {
      return {
        summary: `unknown job ${input.job_id}`,
        markdown: `> No job with id \`${input.job_id}\``,
        data: { found: false },
        follow_up_tools: ["freshness_report", "staleness_check"],
      };
    }
    return {
      summary: `job ${job.job_id} is ${job.state}`,
      markdown: `Job \`${job.job_id}\` — state **${job.state}** — progress ${job.progress.processed}/${job.progress.total}`,
      data: job,
      follow_up_tools: ["freshness_report", "staleness_check"],
    };
  },
});
