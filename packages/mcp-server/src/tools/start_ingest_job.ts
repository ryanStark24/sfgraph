import { validateOrgIdentifier } from "@ryanstark24/sfgraph-shared";
import { defineTool, z } from "./_define.js";

// Only live-org ingest exists. There is NO filesystem ingest path in the CLI,
// so the tool no longer advertises one (it used to emit `sfgraph ingest
// --from-fs <path>` — a flag the CLI doesn't define).
const inputSchema = z.object({
  source: z.object({
    type: z.literal("live-org").default("live-org"),
    alias: z
      .string()
      .min(1)
      .refine(
        (s) => {
          try {
            validateOrgIdentifier(s);
            return true;
          } catch {
            return false;
          }
        },
        { message: "alias must be a Salesforce 15/18-char id or a safe alias" },
      ),
  }),
  mode: z.enum(["full", "incremental", "auto"]).default("auto"),
});

// Stays in the registry so agents can `tools/list` and discover the right
// out-of-band call to make, but refuses to enqueue. The previous version
// returned a fake queued record that would never advance — agents would
// poll `get_ingest_job` forever waiting for a worker that doesn't exist.
defineTool({
  name: "start_ingest_job",
  description:
    "RETURNS INSTRUCTIONS ONLY. The MCP server does NOT run ingest workers. To actually ingest, run `sfgraph ingest --org <alias>` in a shell. Calling this tool returns the exact shell command to run rather than enqueueing a phantom job. Live-org ingest only — there is no filesystem ingest.",
  inputSchema,
  async execute(input) {
    const alias = input.source.alias;
    // Alias already validated by validateOrgIdentifier; safe to interpolate.
    const cmd = `sfgraph ingest --org ${alias}${input.mode !== "auto" ? ` --mode ${input.mode}` : ""}`;
    return {
      summary: "ingest must run out-of-band",
      markdown: [
        "> **The MCP server cannot start ingests itself.** Run the command below in a shell.",
        "",
        "```bash",
        cmd,
        "```",
        "",
        `When it completes, MCP tools like \`trace_upstream\` / \`what_broke\` against \`${alias}\` will see the new data.`,
      ].join("\n"),
      data: { executed: false, run_this_command: cmd },
      // NOT get_ingest_job: this tool enqueues nothing, so there is no job to
      // poll. After the shell command finishes, verify the graph refreshed.
      follow_up_tools: ["staleness_check", "freshness_report"],
    };
  },
});
