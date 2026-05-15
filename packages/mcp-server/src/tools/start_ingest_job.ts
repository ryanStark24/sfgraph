import { validateOrgIdentifier } from "@ryanstark24/sfgraph-shared";
import { defineTool, z } from "./_define.js";

// Reject all C0 control characters (0x00-0x1F) and DEL (0x7F). Built from
// a code-point check so the source file stays clean of literal control bytes.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

const sourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("live-org"),
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
  z.object({
    type: z.literal("filesystem"),
    // Reject control chars / newlines outright. The CLI command we render
    // is meant to be copy-pasted; a path containing a newline or a NUL
    // could splice a second shell command into the agent's clipboard.
    path: z
      .string()
      .min(1)
      .refine((p) => !hasControlChar(p), { message: "path contains control characters" }),
  }),
]);

const inputSchema = z.object({
  source: sourceSchema,
  mode: z.enum(["full", "incremental", "auto"]).default("auto"),
});

/**
 * POSIX single-quote shell escape. Wraps the value in `'...'`, replacing
 * embedded single quotes with `'\''`. Safe to copy-paste into bash/zsh.
 */
function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Stays in the registry so agents can `tools/list` and discover the right
// out-of-band call to make, but refuses to enqueue. The previous version
// returned a fake queued record that would never advance — agents would
// poll `get_ingest_job` forever waiting for a worker that doesn't exist.
defineTool({
  name: "start_ingest_job",
  description:
    "RETURNS INSTRUCTIONS ONLY. The MCP server does NOT run ingest workers. To actually ingest, run `sfgraph ingest --org <alias>` in a shell. Calling this tool now returns the exact shell command to run rather than enqueueing a phantom job.",
  inputSchema,
  async execute(input) {
    const aliasHint = input.source.type === "live-org" ? input.source.alias : null;
    const cmd =
      input.source.type === "live-org"
        ? // Alias already validated by validateOrgIdentifier; safe to interpolate.
          `sfgraph ingest --org ${input.source.alias}${input.mode !== "auto" ? ` --mode ${input.mode}` : ""}`
        : // Path may contain spaces / shell metacharacters — quote it.
          `sfgraph ingest --from-fs ${shellQuotePosix(input.source.path)}`;
    return {
      summary: "ingest must run out-of-band",
      markdown: [
        "> **The MCP server cannot start ingests itself.** Run the command below in a shell.",
        "",
        "```bash",
        cmd,
        "```",
        "",
        aliasHint
          ? `When it completes, MCP tools like \`trace_upstream\` / \`what_broke\` against \`${aliasHint}\` will see the new data.`
          : "When it completes, MCP tools will see the new data on next invocation.",
      ].join("\n"),
      data: { executed: false, run_this_command: cmd },
    };
  },
});
