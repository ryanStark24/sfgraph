import type { ApexFrameCandidate } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";

type ParsedFrame = {
  kind: "class" | "trigger";
  ownerName: string;
  memberName?: string;
  line: number;
  raw: string | null;
};

// Salesforce commonly embeds frames in a larger exception message, so these
// intentionally match a frame anywhere in the supplied text. The identifiers
// are deliberately conservative: a malformed trace must not turn into a
// broad graph lookup.
const CLASS_FRAME = /\bClass\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)\s*:\s*line\s+(\d+)\b/i;
const TRIGGER_FRAME = /\bTrigger\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*:\s*line\s+(\d+)\b/i;

export function parseSalesforceFrame(raw: string): ParsedFrame | null {
  const classMatch = CLASS_FRAME.exec(raw);
  if (classMatch) {
    return {
      kind: "class",
      ownerName: classMatch[1]!,
      memberName: classMatch[2]!,
      line: Number(classMatch[3]),
      raw,
    };
  }
  const triggerMatch = TRIGGER_FRAME.exec(raw);
  if (triggerMatch) {
    return {
      kind: "trigger",
      ownerName: triggerMatch[1]!,
      line: Number(triggerMatch[2]),
      raw,
    };
  }
  return null;
}

const inputSchema = z
  .object({
    org: z.string().min(1),
    /** A Salesforce frame, e.g. `Class.OrderBilling.sendInvoice: line 142`. */
    frame: z.string().trim().min(1).max(500).optional(),
    /** Structured alternative to `frame`; useful to clients that already parsed a log. */
    kind: z.enum(["class", "trigger"]).optional(),
    class_name: z.string().trim().min(1).max(255).optional(),
    method: z.string().trim().min(1).max(255).optional(),
    line: numeric(z.number().int().positive().max(2_000_000).optional()),
    /** Source lines on either side of the failing line (0–50, default 12). */
    context_lines: numeric(z.number().int().min(0).max(50).default(12)),
  })
  .superRefine((value, ctx) => {
    if (value.frame) {
      if (!parseSalesforceFrame(value.frame)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["frame"],
          message:
            "frame must contain `Class.Name.method: line N` or `Trigger.Name: line N`",
        });
      }
      return;
    }
    if (!value.kind || !value.class_name || !value.line) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide `frame`, or all of `kind`, `class_name`, and `line`",
      });
    }
    if (value.kind === "class" && !value.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "a class frame requires `method`",
      });
    }
    if (value.kind === "trigger" && value.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "a trigger frame does not take `method`",
      });
    }
  });

function requestedFrame(input: z.infer<typeof inputSchema>): ParsedFrame {
  if (input.frame) return parseSalesforceFrame(input.frame)!;
  return {
    kind: input.kind!,
    ownerName: input.class_name!,
    ...(input.kind === "class" ? { memberName: input.method! } : {}),
    line: input.line!,
    raw: null,
  };
}

function sourceRange(candidate: ApexFrameCandidate): string {
  return candidate.startLine != null && candidate.endLine != null
    ? `lines ${candidate.startLine}–${candidate.endLine}`
    : "an unnumbered stored source snippet";
}

function candidateData(candidate: ApexFrameCandidate) {
  return {
    qname: String(candidate.qualifiedName),
    sourceRange:
      candidate.startLine != null && candidate.endLine != null
        ? { startLine: candidate.startLine, endLine: candidate.endLine }
        : null,
    sourceHash: String(candidate.sourceHash),
  };
}

function excerpt(candidate: ApexFrameCandidate, line: number, contextLines: number) {
  const sourceStart = candidate.startLine!;
  const lines = candidate.sourceText.split(/\r?\n/);
  const from = Math.max(sourceStart, line - contextLines);
  const to = Math.min(candidate.endLine!, line + contextLines);
  const fromIndex = from - sourceStart;
  return {
    startLine: from,
    endLine: to,
    sourceText: lines.slice(fromIndex, fromIndex + to - from + 1).join("\n"),
  };
}

function renderedExcerpt(sourceText: string, startLine: number, focusLine: number): string {
  return sourceText
    .split("\n")
    .map((text, index) => {
      const line = startLine + index;
      return `${line === focusLine ? ">" : " "} ${String(line).padStart(6)} | ${text}`;
    })
    .join("\n");
}

defineTool({
  name: "resolve_frame",
  description:
    "Resolve a Salesforce Class./Trigger. stack frame to one exact, line-aware stored source excerpt with qname, source range and hash. Use for debugging logs before tracing impact.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const frame = requestedFrame(input);
    const candidates = ctx.graphStore.findApexFrameCandidates(ctx.orgId, frame);
    const ranged = candidates.filter(
      (candidate) =>
        candidate.startLine != null &&
        candidate.endLine != null &&
        candidate.startLine <= frame.line &&
        frame.line <= candidate.endLine,
    );

    if (ranged.length === 1) {
      const candidate = ranged[0]!;
      const focused = excerpt(candidate, frame.line, input.context_lines);
      const subject =
        frame.kind === "class"
          ? `Class.${frame.ownerName}.${frame.memberName}`
          : `Trigger.${frame.ownerName}`;
      return {
        summary: `resolved ${subject}: line ${frame.line} to ${candidate.qualifiedName}`,
        markdown: [
          `**Resolved:** \`${subject}: line ${frame.line}\` → \`${candidate.qualifiedName}\`.`,
          "",
          `Stored source: ${sourceRange(candidate)}; hash \`${candidate.sourceHash}\`. The \`>\` line is the failing frame line.`,
          "",
          `\`\`\`${candidate.sourceFormat}`,
          renderedExcerpt(focused.sourceText, focused.startLine, frame.line),
          "\`\`",
          "",
          "The server attaches graph freshness in the MCP response metadata; re-run after an ingest if it says a sync was in progress.",
        ].join("\n"),
        data: {
          status: "resolved",
          frame: {
            kind: frame.kind,
            ownerName: frame.ownerName,
            memberName: frame.memberName ?? null,
            line: frame.line,
            raw: frame.raw,
          },
          qname: String(candidate.qualifiedName),
          sourceFormat: candidate.sourceFormat,
          sourceHash: String(candidate.sourceHash),
          sourceRange: { startLine: candidate.startLine, endLine: candidate.endLine },
          excerpt: { ...focused, focusLine: frame.line },
        },
        follow_up_tools: ["explain_code", "trace_upstream", "trace_downstream"],
      };
    }

    if (ranged.length > 1) {
      return {
        summary: `ambiguous frame: ${ranged.length} source snippets contain line ${frame.line}`,
        markdown: `> Could not safely choose a source for this frame: ${ranged.length} indexed snippets match its name and line. Re-ingest after checking duplicate Apex source.`,
        data: {
          status: "ambiguous",
          frame,
          candidates: ranged.map(candidateData),
        },
        follow_up_tools: ["find_nodes", "explain_code"],
      };
    }

    const status = candidates.length ? "line_outside_source" : "not_found";
    const reason = candidates.length
      ? `Found ${candidates.length} matching source snippet${candidates.length === 1 ? "" : "s"}, but line ${frame.line} is outside every stored source range.`
      : "No indexed Apex source matches this class/trigger and method.";
    return {
      summary: `${status.replace(/_/g, " ")}: ${reason}`,
      markdown: `> ${reason} Re-ingest the org if the deployed source or stack trace may be newer than this graph.`,
      data: {
        status,
        frame,
        candidates: candidates.map(candidateData),
      },
      follow_up_tools: ["freshness_report", "find_nodes", "explain_code"],
    };
  },
});
