import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  /**
   * Glob pattern matched against node qualifiedName. The dot is treated
   * as the path separator — so `ApexClass:*` matches every Apex class,
   * `CustomField:Account.*` matches every field on Account, and
   * `CustomField:**.*Email*` matches any field on any object whose name
   * contains "Email". Supports `*`, `?`, `**`, `[abc]`, `{a,b}` via
   * picomatch.
   */
  pattern: z.string().min(1),
  /** Optional label filter — bypasses the cross-label scan when set. */
  label: z.string().optional(),
  /** Result cap. Default 500. */
  limit: z.number().int().positive().optional(),
});

defineTool({
  name: "find_nodes",
  description:
    "Glob-pattern node lookup. Pattern matches node qualifiedName with `.` as separator: `ApexClass:*`, `CustomField:Account.*`, `Flow:Lead_*`, `**:*Email*`. Faster than full-text search; falls back to lexicographic sort. Use this when the agent knows the rough qname shape but not the exact spelling.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const opts: Parameters<typeof analyze.findNodesByGlob>[3] = {};
    if (input.label) opts.label = input.label;
    if (input.limit) opts.limit = input.limit;
    const result = analyze.findNodesByGlob(ctx.graphStore, ctx.orgId, input.pattern, opts);
    const lines = result.matches.map(
      (n) => `- \`${n.qualifiedName}\` (${n.label})`,
    );
    const md = [
      `Pattern \`${input.pattern}\` matched ${result.total} node${result.total === 1 ? "" : "s"}${
        result.truncated ? ` (showing first ${result.matches.length})` : ""
      }.`,
      "",
      ...lines,
    ].join("\n");
    return {
      summary:
        result.total === 0
          ? "no matches"
          : `${result.total} match${result.total === 1 ? "" : "es"}${result.truncated ? " (truncated)" : ""}`,
      markdown: md,
      data: {
        matches: result.matches.map((n) => ({
          qualifiedName: n.qualifiedName,
          label: n.label,
        })),
        total: result.total,
        truncated: result.truncated,
      },
      follow_up_tools: ["analyze_field", "explain_code", "trace_downstream", "trace_upstream"],
    };
  },
});
