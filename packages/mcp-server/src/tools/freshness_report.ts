import { analyze } from "@ryanstark24/sfgraph-core";
import { METADATA_CATEGORY } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { countNoun, kindCounts, withInShort } from "./_report.js";

const inputSchema = z.object({
  org: z.string().min(1),
  bucket: z.enum(["stale", "hot", "dead", "current"]).optional(),
});

// The LWC parser labels its bundles `LWC`; `LightningComponentBundle` (METADATA_CATEGORY.LWC)
// is kept for older stores, as in dead_code_audit.
const SCAN_LABELS = [
  METADATA_CATEGORY.APEX_CLASS,
  "LWC",
  METADATA_CATEGORY.LWC,
  METADATA_CATEGORY.FLOW,
  METADATA_CATEGORY.OBJECT,
];

const FRESHNESS_PER_LABEL_CAP = 5000;

defineTool({
  name: "freshness_report",
  description:
    "Use for 'what is stale'. Buckets components by last change: dead, stale, current, hot.",
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
    let truncated = false;
    const scanned: string[] = [];
    for (const lbl of SCAN_LABELS) {
      const rows = ctx.graphStore.listNodesByLabel(ctx.orgId, lbl, FRESHNESS_PER_LABEL_CAP);
      if (rows.length >= FRESHNESS_PER_LABEL_CAP) truncated = true;
      for (const n of rows) {
        scanned.push(n.label);
        const s = analyze.freshnessScore(n, now);
        const b = analyze.freshnessBucket(s);
        (buckets[b] ?? []).push({ qualifiedName: n.qualifiedName, score: s, label: n.label });
      }
    }
    const totals = {
      hot: buckets.hot?.length ?? 0,
      current: buckets.current?.length ?? 0,
      stale: buckets.stale?.length ?? 0,
      dead: buckets.dead?.length ?? 0,
    };
    const checkedN = totals.hot + totals.current + totals.stale + totals.dead;
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
    const truncationNote = truncated
      ? ` — results capped at ${FRESHNESS_PER_LABEL_CAP}/label; narrow scope or paginate`
      : "";
    return {
      summary: `freshness report ${filter ?? "all buckets"}${truncationNote}`,
      markdown: withInShort(
        checkedN === 0
          ? "No Apex classes, Lightning web components, flows or objects were found, so nothing was checked."
          : `Checked when each of ${countNoun(checkedN, "piece")} was last changed: ${kindCounts(scanned)}. ${totals.hot} hot (in the last 30 days), ${totals.current} current (31 to 90 days ago, or no date), ${totals.stale} stale (91 days to a year ago) and ${totals.dead} dead (over a year ago). Each list below shows at most 20, least recently changed first.${
              truncated
                ? ` At least one kind has ${FRESHNESS_PER_LABEL_CAP} or more pieces and only the first ${FRESHNESS_PER_LABEL_CAP} were checked.`
                : ""
            }`,
        truncated
          ? `${md}\n\n> _Note: at least one label hit the ${FRESHNESS_PER_LABEL_CAP}-row cap. Results are incomplete._`
          : md,
      ),
      data: { buckets, truncated },
      follow_up_tools: ["dead_code_audit", "staleness_check"],
    };
  },
});
