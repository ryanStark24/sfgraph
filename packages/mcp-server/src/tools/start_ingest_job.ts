import { validateOrgIdentifier } from "@ryanstark24/sfgraph-shared";
import { defineTool, z } from "./_define.js";
import { withInShort } from "./_report.js";

const aliasSchema = z
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
  );

// Two sources: a live org (`sfgraph ingest --org`) and an SFDX checkout
// (`sfgraph ingest --project <path> --org <alias>`). Project ingests default
// to a delta (Task 11c): only the members that changed since the last
// project ingest are re-derived.
const inputSchema = z
  .object({
    source: z.union([
      z.object({
        type: z.literal("project"),
        path: z
          .string()
          .min(1)
          .refine((p) => !/[\r\n\0]/.test(p), { message: "path must be a single line" }),
        alias: aliasSchema,
      }),
      z.object({
        type: z.literal("live-org").default("live-org"),
        alias: aliasSchema,
      }),
    ]),
    mode: z.enum(["full", "incremental", "auto", "delta"]).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.source.type === "live-org" && v.mode === "delta") {
      ctx.addIssue({ code: "custom", message: "mode delta needs a project source" });
    }
    if (v.source.type === "project" && v.mode === "incremental") {
      ctx.addIssue({ code: "custom", message: "a project source is ingested full or delta" });
    }
  });

/** POSIX single-quote a shell word. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Stays in the registry so agents can `tools/list` and discover the right
// out-of-band call to make, but refuses to enqueue. The previous version
// returned a fake queued record that would never advance — agents would
// poll `get_ingest_job` forever waiting for a worker that doesn't exist.
defineTool({
  name: "start_ingest_job",
  description:
    "Returns the shell command that ingests a live org or an SFDX project (the server runs no ingest). `mode`: full, incremental or auto (org); delta (default) or full (project).",
  inputSchema,
  async execute(input) {
    const alias = input.source.alias;
    // Alias already validated by validateOrgIdentifier; safe to interpolate.
    // The project path is single-quoted (and has no newline).
    let cmd: string;
    if (input.source.type === "project") {
      const delta = input.mode !== "full";
      cmd = `sfgraph ingest --project ${shellQuote(input.source.path)} --org ${alias}${delta ? " --delta" : ""}`;
    } else {
      const mode = input.mode ?? "auto";
      cmd = `sfgraph ingest --org ${alias}${mode !== "auto" ? ` --mode ${mode}` : ""}`;
    }
    return {
      summary: "ingest must run out-of-band",
      markdown: withInShort(
        `This server cannot load data itself; nothing was started. Run the command below in a shell to load \`${alias}\`.`,
        [
          "> **The MCP server cannot start ingests itself.** Run the command below in a shell.",
          "",
          "```bash",
          cmd,
          "```",
          "",
          `When it completes, MCP tools like \`trace_upstream\` / \`what_broke\` against \`${alias}\` will see the new data.`,
        ].join("\n"),
      ),
      data: { executed: false, run_this_command: cmd },
      // NOT get_ingest_job: this tool enqueues nothing, so there is no job to
      // poll. After the shell command finishes, verify the graph refreshed.
      follow_up_tools: ["staleness_check", "freshness_report"],
    };
  },
});
