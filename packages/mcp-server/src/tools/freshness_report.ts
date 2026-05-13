import { analyze } from "@ryanstark24/sfgraph-core";
import { METADATA_CATEGORY } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  bucket: z.enum(["stale", "hot", "dead", "current"]).optional(),
});

const SCAN_LABELS = [
  METADATA_CATEGORY.APEX_CLASS,
  METADATA_CATEGORY.LWC,
  METADATA_CATEGORY.FLOW,
  METADATA_CATEGORY.OBJECT,
];

defineTool({
  name: "freshness_report",
  description: "Bucket metadata by freshness score.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const now = Date.now();
    const buckets: Record<
      string,
      Array<{ qualifiedName: string; score: number; label: string }>
    > = {
      hot: [],
      current: [],
      stale: [],
      dead: [],
    };
    for (const lbl of SCAN_LABELS) {
      for (const n of ctx.graphStore.listNodesByLabel(ctx.orgId, lbl, 5000)) {
        const s = analyze.freshnessScore(n, now);
        const b = analyze.freshnessBucket(s);
        (buckets[b] ?? []).push({ qualifiedName: n.qualifiedName, score: s, label: n.label });
      }
    }
    for (const k of Object.keys(buckets)) {
      const arr = buckets[k] ?? [];
      arr.sort((a, b) => a.score - b.score);
      buckets[k] = arr.slice(0, 20);
    }
    const filter = input.bucket;
    const md = (filter ? [filter] : Object.keys(buckets))
      .map((b) => {
        const rows = (buckets[b] ?? [])
          .map((r) => `| \`${r.qualifiedName}\` | ${r.label} | ${r.score.toFixed(2)} |`)
          .join("\n");
        return `### ${b}\n\n| qname | label | score |\n|---|---|---|\n${rows || "_empty_"}`;
      })
      .join("\n\n");
    return {
      summary: `freshness report ${filter ?? "all buckets"}`,
      markdown: md,
      data: { buckets },
    };
  },
});
