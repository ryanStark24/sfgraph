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
  description:
    "Record an ingest job request. NOTE: this endpoint only enqueues a job record in an in-memory queue; the MCP server does NOT run a worker that consumes the queue, so the ingest will not execute from inside the MCP process. To actually perform the ingest, run `sfgraph ingest --org <alias>` from a shell. The queued record is returned only so callers can later inspect it via get_ingest_job. (Future work: pluggable worker pool — not implemented.)",
  inputSchema,
  async execute(input) {
    const job = enqueueJob(input.source, input.mode);
    const aliasHint = input.source.type === "live-org" ? input.source.alias : "<alias>";
    return {
      summary: `recorded ingest job ${job.job_id} (queued only — run \`sfgraph ingest --org ${aliasHint}\` from a shell to execute)`,
      markdown: [
        `Job \`${job.job_id}\` queued at position ${job.queue_position}.`,
        "",
        "> **This tool does not execute the ingest.** The MCP server has no runner consuming the queue.",
        `> Run \`sfgraph ingest --org ${aliasHint}\` from a shell, or trigger via your existing pipeline.`,
      ].join("\n"),
      data: {
        job_id: job.job_id,
        state: job.state,
        queue_position: job.queue_position,
        note: "queued-record-only: no in-process worker consumes this queue",
      },
      follow_up_tools: ["get_ingest_job"],
    };
  },
});
