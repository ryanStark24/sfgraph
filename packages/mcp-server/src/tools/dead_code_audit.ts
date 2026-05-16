import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({ org: z.string().min(1) });

interface CachedDead {
  qualifiedName: string;
  score: number;
  confidence: string;
  reasons: string[];
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
      const md = cached.length
        ? [
            "| qname | confidence | score | reasons |",
            "|---|---|---|---|",
            ...cached.map(
              (d) =>
                `| \`${d.qualifiedName}\` | ${d.confidence} | ${d.score.toFixed(2)} | ${d.reasons.join(", ")} |`,
            ),
          ].join("\n")
        : "_no dead code detected_";
      return {
        summary: `${cached.length} dead-code candidates (cached)`,
        markdown: md,
        data: { dead: cached, cached: true },
        follow_up_tools: ["trace_upstream", "find_similar", "freshness_report"],
      };
    }
    const dead = analyze.findDeadCode(ctx.graphStore, ctx.orgId);
    const md = dead.length
      ? [
          "| qname | label |",
          "|---|---|",
          ...dead.map((d) => `| \`${d.qualifiedName}\` | ${d.label} |`),
        ].join("\n")
      : "_no dead code detected_";
    return {
      summary: `${dead.length} dead-code candidates`,
      markdown: md,
      data: { dead: dead.map((d) => d.qualifiedName), cached: false },
      follow_up_tools: ["trace_upstream", "find_similar", "freshness_report"],
    };
  },
});
