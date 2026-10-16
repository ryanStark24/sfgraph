import { defineTool, z } from "./_define.js";
import { getJob } from "./_job-store.js";
import { withInShort } from "./_report.js";

const inputSchema = z.object({ job_id: z.string().min(1) });

defineTool({
  name: "get_ingest_job",
  description:
    "Look up an in-process ingest job by id; usually 'unknown job', as the server runs no ingest.",
  inputSchema,
  async execute(input) {
    const job = getJob(input.job_id);
    if (!job) {
      return {
        summary: `unknown job ${input.job_id}`,
        markdown: withInShort(
          `There is no load job \`${input.job_id}\`: this server does not run loads itself, so it has no jobs to report.`,
          `> No job with id \`${input.job_id}\``,
        ),
        data: { found: false },
        follow_up_tools: ["freshness_report", "staleness_check"],
      };
    }
    return {
      summary: `job ${job.job_id} is ${job.state}`,
      markdown: withInShort(
        `Load job \`${job.job_id}\` is ${job.state}: ${job.progress.processed} of ${job.progress.total} done.`,
        `Job \`${job.job_id}\` — state **${job.state}** — progress ${job.progress.processed}/${job.progress.total}`,
      ),
      data: job,
      follow_up_tools: ["freshness_report", "staleness_check"],
    };
  },
});
