import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  /** Max rows to render inline. The full set can be thousands on a large org
   *  (6k+ on PLDT), which blows the MCP token budget. Default 50; the summary
   *  (counts by confidence + label) always covers 100%. Use export_sarif for
   *  the complete machine-readable set. */
  limit: z.number().int().min(1).max(500).default(50),
  /** Only show this confidence bucket (high|medium|low). */
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

interface CachedDead {
  qualifiedName: string;
  score: number;
  confidence: string;
  reasons: string[];
}

function labelOf(qname: string): string {
  const i = qname.indexOf(":");
  return i > 0 ? qname.slice(0, i) : "(unlabeled)";
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function fmtCounts(counts: Record<string, number>): string {
  return (
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "none"
  );
}

function readCachedDeadCode(db: unknown, orgId: string): CachedDead[] | null {
  try {
    const d = db as {
      prepare: (s: string) => {
        all: (...args: unknown[]) => Array<{
          qualified_name: string;
          score: number;
          confidence: string;
          reasons: string;
        }>;
      };
    };
    const rows = d
      .prepare(
        "SELECT qualified_name, score, confidence, reasons FROM _sfgraph_dead_code_scores WHERE org_id = ? ORDER BY score ASC",
      )
      .all(orgId);
    if (!rows || rows.length === 0) return null;
    return rows.map((r) => ({
      qualifiedName: r.qualified_name,
      score: r.score,
      confidence: r.confidence,
      reasons: (() => {
        try {
          return JSON.parse(r.reasons) as string[];
        } catch {
          return [];
        }
      })(),
    }));
  } catch {
    return null;
  }
}

defineTool({
  name: "dead_code_audit",
  description:
    "USE THIS for any 'what can I delete' / 'find unused Apex / LWC / Flow' / 'dead code' / 'orphan metadata' question about a Salesforce org. Returns nodes with low freshness AND zero incoming edges, bucketed by confidence with reasons.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const cached = ctx.db ? readCachedDeadCode(ctx.db, ctx.orgId) : null;
    if (cached) {
      const pool = input.confidence
        ? cached.filter((d) => d.confidence === input.confidence)
        : cached;
      if (pool.length === 0) {
        return {
          summary: "no dead-code candidates",
          markdown: "_no dead code detected_",
          data: { dead: [], cached: true, total: 0 },
          follow_up_tools: ["trace_upstream", "find_similar", "freshness_report"],
        };
      }
      const byConfidence = countBy(pool, (d) => d.confidence);
      const byLabel = countBy(pool, (d) => labelOf(d.qualifiedName));
      const shown = pool.slice(0, input.limit);
      const md = [
        `**${pool.length} dead-code candidate${pool.length === 1 ? "" : "s"}**${input.confidence ? ` (confidence=${input.confidence})` : ""} — showing ${shown.length}.`,
        "",
        `Confidence: ${fmtCounts(byConfidence)}`,
        `Type: ${fmtCounts(byLabel)}`,
        "",
        "| qname | confidence | score | reasons |",
        "|---|---|---|---|",
        ...shown.map(
          (d) =>
            `| \`${d.qualifiedName}\` | ${d.confidence} | ${d.score.toFixed(2)} | ${d.reasons.join(", ")} |`,
        ),
      ];
      if (pool.length > shown.length) {
        md.push(
          "",
          `_${pool.length - shown.length} more not shown — raise \`limit\`, filter by \`confidence\`, or use \`export_sarif\` for the full machine-readable set._`,
        );
      }
      return {
        summary: `${pool.length} dead-code candidates (cached), showing ${shown.length}`,
        markdown: md.join("\n"),
        data: { dead: shown, total: pool.length, byConfidence, byLabel, cached: true },
        follow_up_tools: ["trace_upstream", "find_similar", "freshness_report", "export_sarif"],
      };
    }
    const dead = analyze.findDeadCode(ctx.graphStore, ctx.orgId);
    if (dead.length === 0) {
      return {
        summary: "no dead-code candidates",
        markdown: "_no dead code detected_",
        data: { dead: [], cached: false, total: 0 },
        follow_up_tools: ["trace_upstream", "find_similar", "freshness_report"],
      };
    }
    const byLabel = countBy(dead, (d) => d.label);
    const shown = dead.slice(0, input.limit);
    const md = [
      `**${dead.length} dead-code candidate${dead.length === 1 ? "" : "s"}** — showing ${shown.length}.`,
      "",
      `Type: ${fmtCounts(byLabel)}`,
      "",
      "| qname | label |",
      "|---|---|",
      ...shown.map((d) => `| \`${d.qualifiedName}\` | ${d.label} |`),
    ];
    if (dead.length > shown.length) {
      md.push("", `_${dead.length - shown.length} more not shown — raise \`limit\`._`);
    }
    return {
      summary: `${dead.length} dead-code candidates, showing ${shown.length}`,
      markdown: md.join("\n"),
      data: { dead: shown.map((d) => d.qualifiedName), total: dead.length, byLabel, cached: false },
      follow_up_tools: ["trace_upstream", "find_similar", "freshness_report"],
    };
  },
});
