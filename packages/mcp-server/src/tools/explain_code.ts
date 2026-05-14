import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  qname: z.string().min(1),
  refresh: z.boolean().default(false),
  annotation: z.string().optional(),
});

defineTool({
  name: "explain_code",
  description:
    "USE THIS for any 'explain this method' / 'walk me through X' / 'what does Apex method Y do' question about a stored Salesforce code snippet. Returns the source text + cached LLM explanation (if any). Pass annotation to cache the LLM's explanation back to the graph for future use.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(input.qname);

    // Annotation write path
    if (typeof input.annotation === "string" && input.annotation.length > 0) {
      const now = Date.now();
      const ok = ctx.graphStore.updateSnippetExplanation(ctx.orgId, qname, input.annotation, now);
      if (!ok) {
        return {
          summary: `no snippet stored for ${input.qname} — annotation not persisted`,
          markdown: `> No snippet exists for \`${input.qname}\`. Likely a non-code metadata type, or the org has not been ingested yet.`,
          data: {
            qname: input.qname,
            sourceFormat: null,
            sourceText: null,
            startLine: null,
            endLine: null,
            cachedExplanation: null,
            cachedAt: null,
            stored: false,
          },
        };
      }
      const snippet = ctx.graphStore.getSnippet(ctx.orgId, qname);
      return {
        summary: `cached explanation for ${input.qname}`,
        markdown: `> Explanation cached for \`${input.qname}\` at ${new Date(now).toISOString()}.`,
        data: {
          qname: input.qname,
          sourceFormat: snippet?.sourceFormat ?? null,
          sourceText: snippet?.sourceText ?? null,
          startLine: snippet?.startLine ?? null,
          endLine: snippet?.endLine ?? null,
          cachedExplanation: snippet?.llmExplanation ?? input.annotation,
          cachedAt: snippet?.explainedAt ?? now,
          stored: true,
        },
      };
    }

    // Read path
    const snippet = ctx.graphStore.getSnippet(ctx.orgId, qname);
    if (!snippet) {
      return {
        summary: `no snippet stored for ${input.qname} — likely a non-code metadata type`,
        markdown: `> No snippet stored for \`${input.qname}\`. Snippets are emitted only for code parsers (currently Apex methods). For declarative metadata, use \`analyze_field\` or \`trace_upstream\` instead.`,
        data: {
          qname: input.qname,
          sourceFormat: null,
          sourceText: null,
          startLine: null,
          endLine: null,
          cachedExplanation: null,
          cachedAt: null,
          stored: false,
        },
      };
    }

    const showCached = !input.refresh && snippet.llmExplanation;
    const md: string[] = [
      `**${input.qname}** — \`${snippet.sourceFormat}\`${
        snippet.startLine != null ? ` (lines ${snippet.startLine}–${snippet.endLine ?? "?"})` : ""
      }`,
      "",
      `\`\`\`${snippet.sourceFormat}`,
      snippet.sourceText,
      "```",
      "",
    ];
    if (showCached) {
      md.push("**Cached explanation:**", "", `> ${snippet.llmExplanation}`);
    } else {
      md.push(
        "> No explanation cached yet — generate one and call `explain_code` again with `annotation` to persist it.",
      );
    }
    md.push("", "_follow_up_tools: `analyze_field`, `trace_upstream`, `trace_downstream`_");
    return {
      summary: showCached
        ? `snippet + cached explanation for ${input.qname}`
        : `snippet for ${input.qname} (no cached explanation)`,
      markdown: md.join("\n"),
      data: {
        qname: input.qname,
        sourceFormat: snippet.sourceFormat,
        sourceText: snippet.sourceText,
        startLine: snippet.startLine ?? null,
        endLine: snippet.endLine ?? null,
        cachedExplanation: showCached ? (snippet.llmExplanation ?? null) : null,
        cachedAt: showCached ? (snippet.explainedAt ?? null) : null,
        stored: false,
      },
    };
  },
});
