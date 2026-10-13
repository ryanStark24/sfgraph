import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { code, countNoun, kindCounts, kindInText, renderReport } from "./_report.js";

/** Audit sec-02: input bounds at the tool boundary. Core's glob matcher is
 *  linear (no backtracking) and has its own caps; these stricter limits are
 *  defence in depth and keep agent-supplied patterns reasonable. */
const MAX_PATTERN_LENGTH = 256;
const MAX_STAR_RUNS = 4;

const inputSchema = z.object({
  org: z.string().min(1),
  /**
   * Glob pattern matched case-insensitively against the whole node
   * qualifiedName by core's linear glob matcher. `*` (and `**`) match any
   * run of characters, dots included; `?` matches one character; `{a,b}`
   * lists alternatives. So `ApexClass:*` matches every Apex class and
   * `CustomField:Account.*` every field on Account. At most 256 characters
   * and 4 `*` runs (`**` counts as one).
   */
  pattern: z
    .string()
    .min(1)
    .max(MAX_PATTERN_LENGTH)
    .refine((p) => (p.match(/\*+/g)?.length ?? 0) <= MAX_STAR_RUNS, {
      message: `pattern may contain at most ${MAX_STAR_RUNS} wildcard runs ('*' or '**'); use a more specific pattern or the label filter`,
    }),
  /** Optional label filter — bypasses the cross-label scan when set. */
  label: z.string().optional(),
  /** Result cap. Default 200. */
  limit: numeric(z.number().int().positive().optional()),
});

defineTool({
  name: "find_nodes",
  description:
    "Find nodes by name glob, case-insensitive: `*` any run (dots too), `?` one char, `{a,b}` alternatives, e.g. `ApexClass:*Handler`. At most 256 characters and 4 `*` runs.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const opts: Parameters<typeof analyze.findNodesByGlob>[3] = {};
    if (input.label) opts.label = input.label;
    opts.limit = input.limit ?? 200;
    const result = analyze.findNodesByGlob(ctx.graphStore, ctx.orgId, input.pattern, opts);
    const lines = result.matches.map((n) => `- \`${n.qualifiedName}\` (${n.label})`);
    const md = [
      `Pattern \`${input.pattern}\` matched ${result.total} node${result.total === 1 ? "" : "s"}${
        result.truncated ? ` (showing first ${result.matches.length})` : ""
      }.`,
      "",
      ...lines,
      ...(result.truncated
        ? [
            "",
            `_${result.total - result.matches.length} more, narrow with a more specific \`pattern\`, a \`label\` filter, or raise \`limit\`._`,
          ]
        : []),
    ].join("\n");
    const among = input.label ? ` among ${kindInText(input.label, { plural: true })}` : "";
    const shownN = result.matches.length;
    const markdown = renderReport({
      title: `Names matching ${code(input.pattern)}`,
      inShort:
        result.total === 0
          ? [
              `No piece in the graph has a name matching ${code(input.pattern)}${among}.`,
              "Matching ignores case; `*` stands for any run of characters and `?` for one character.",
            ]
          : [
              `${code(input.pattern)} matched ${countNoun(result.total, "piece")}${among}${result.truncated ? "" : `: ${kindCounts(result.matches.map((n) => n.label))}`}.`,
              ...(result.truncated
                ? [
                    `Only the first ${shownN} ${shownN === 1 ? "is" : "are"} listed below: ${kindCounts(result.matches.map((n) => n.label))}. The kinds of the rest were not counted.`,
                  ]
                : []),
            ],
      details: md,
      next: [
        ...(result.truncated
          ? ["Narrow with a more specific `pattern` or a `label`, or raise `limit`."]
          : []),
        ...(result.total === 0 ? ["Try a wider pattern, such as `*:*Name*`."] : []),
        ...(result.total > 0
          ? ["Use `explain_code`, `trace_downstream` or `trace_upstream` on a match."]
          : []),
      ],
    });
    return {
      summary:
        result.total === 0
          ? "no matches"
          : `${result.total} match${result.total === 1 ? "" : "es"}${result.truncated ? " (truncated)" : ""}`,
      markdown,
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
