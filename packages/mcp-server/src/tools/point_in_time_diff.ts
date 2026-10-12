import { analyze, render } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { labelOfQname } from "./_reach_list.js";
import { NOTES, andList, code, countNoun, kindCounts, renderReport } from "./_report.js";
import { DIFF_MERMAID_MAX_NODES, isSnapshotEmpty } from "./_snapshot-util.js";

const inputSchema = z.object({
  org: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1).default("current"),
  /** Max entries returned per bucket (added / removed / changed). Counts are
   *  always exact. Default 100. */
  limit: numeric(z.number().int().min(1).max(1000).default(100)),
});

defineTool({
  name: "point_in_time_diff",
  description:
    "Diff the org between two snapshots (`to`: a snapshot id or current): added, removed and changed components; records and configuration apart.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const nodeDiff = ctx.snapshotStore.diffNodes(ctx.orgId, input.from, input.to);
    const n = input.limit;
    // Counts are exact; only the first `n` edge rows per bucket are read.
    const edgeDiff = ctx.snapshotStore.diffEdgesPage(ctx.orgId, input.from, input.to, n);
    // Component units (members rolled up) and record/config rows, apart.
    const scoped = analyze.scopeNodeDiff(ctx.graphStore, ctx.orgId, nodeDiff);
    const sizes = (b: analyze.ChangeBuckets) => ({
      added: b.added.length,
      removed: b.removed.length,
      changed: b.changed.length,
    });
    const counts = {
      nodes: {
        added: nodeDiff.added.length,
        removed: nodeDiff.removed.length,
        changed: nodeDiff.changed.length,
      },
      components: sizes(scoped.component),
      nonComponent: sizes(scoped.nonComponent),
      edges: { added: edgeDiff.addedCount, removed: edgeDiff.removedCount },
    };
    const over = (c: { added: number; removed: number; changed: number }) =>
      c.added > n || c.removed > n || c.changed > n;
    const truncated =
      over(counts.nodes) ||
      over(counts.components) ||
      over(counts.nonComponent) ||
      counts.edges.added > n ||
      counts.edges.removed > n;
    const cut = (b: analyze.ChangeBuckets): analyze.ChangeBuckets => ({
      added: b.added.slice(0, n),
      removed: b.removed.slice(0, n),
      changed: b.changed.slice(0, n),
    });
    const baselineEmpty = isSnapshotEmpty(ctx, input.from) === true;

    const cc = counts.components;
    const nc = counts.nonComponent;
    const md = [
      `**Components** — +${cc.added} / -${cc.removed} / ~${cc.changed}`,
      `**Records and configuration** (not components) — +${nc.added} / -${nc.removed} / ~${nc.changed}`,
      `**Nodes** — +${counts.nodes.added} / -${counts.nodes.removed} / ~${counts.nodes.changed}`,
      `**Edges** — +${counts.edges.added} / -${counts.edges.removed}`,
    ];
    if (baselineEmpty) {
      md.push(
        "",
        `> Baseline snapshot \`${input.from}\` is empty (taken before the first ingest), so every node and edge counts as added. Pick a later snapshot (snapshot_list) for a meaningful diff.`,
      );
    }
    const list = (title: string, qnames: string[], total: number) =>
      total === 0
        ? []
        : [
            "",
            `**${title}** (${total}${total > qnames.length ? `, first ${qnames.length}` : ""})`,
            ...qnames.map((q) => `- ${q}`),
          ];
    const componentTotal = cc.added + cc.removed + cc.changed;
    if (componentTotal <= DIFF_MERMAID_MAX_NODES) {
      const mermaid = render.renderDiff({
        added: scoped.component.added.map((qualifiedName) => ({ qualifiedName })),
        removed: scoped.component.removed.map((qualifiedName) => ({ qualifiedName })),
        changed: scoped.component.changed.map((qualifiedName) => ({ qualifiedName })),
      });
      md.push("", "```mermaid", mermaid, "```");
    } else {
      md.push(
        ...list("Added components", scoped.component.added.slice(0, n), cc.added),
        ...list("Removed components", scoped.component.removed.slice(0, n), cc.removed),
        ...list("Changed components", scoped.component.changed.slice(0, n), cc.changed),
      );
    }
    if (nc.added + nc.removed + nc.changed > 0) {
      md.push(
        "",
        "### Records and configuration (not components)",
        "_Custom metadata records, DataPack records, access and UI configuration._",
        ...list("Added", scoped.nonComponent.added.slice(0, n), nc.added),
        ...list("Removed", scoped.nonComponent.removed.slice(0, n), nc.removed),
        ...list("Changed", scoped.nonComponent.changed.slice(0, n), nc.changed),
      );
    }
    if (truncated) {
      md.push(
        "",
        `_Lists capped at ${n} per bucket; counts above are exact. Raise \`limit\` (max 1000) to see more._`,
      );
    }
    const span = `between snapshot ${code(input.from)} and ${input.to === "current" ? "now" : `snapshot ${code(input.to)}`}`;
    const Span = span.charAt(0).toUpperCase() + span.slice(1);
    const allComp = [
      ...scoped.component.added,
      ...scoped.component.removed,
      ...scoped.component.changed,
    ];
    const ncTotal = nc.added + nc.removed + nc.changed;
    const linkTotal = counts.edges.added + counts.edges.removed;
    const inShort: string[] = [];
    /** "1 added and 1 changed": the non-zero parts only. */
    const parts = (c: { added: number; removed?: number; changed?: number }) =>
      andList(
        [
          [c.added, "added"],
          [c.removed ?? 0, "removed"],
          [c.changed ?? 0, "changed"],
        ]
          .filter(([n]) => (n as number) > 0)
          .map(([n, w]) => `${n} ${w}`),
      );
    const isAre = (n: number) => (n === 1 ? "is" : "are");
    if (componentTotal === 0 && ncTotal === 0 && linkTotal === 0) {
      inShort.push(
        `Nothing changed ${span}: no components, records or links were added, removed or changed.`,
      );
    } else {
      inShort.push(
        componentTotal === 0
          ? `${Span}, no components changed.`
          : `${Span}, ${countNoun(componentTotal, "component")} ${isAre(componentTotal)} different: ${parts(cc)}${
              allComp.length === componentTotal
                ? `; by kind, ${kindCounts(allComp.map(labelOfQname), 3)}`
                : ""
            }.`,
      );
      const rest = [
        ...(ncTotal > 0
          ? [
              `${countNoun(ncTotal, "record or setting", "records or settings")} ${isAre(ncTotal)} different too: ${parts(nc)}`,
            ]
          : []),
        ...(linkTotal > 0
          ? [
              `${countNoun(linkTotal, "link")} between pieces ${linkTotal === 1 ? "was" : "were"} added or removed: ${parts(counts.edges)}`,
            ]
          : []),
      ];
      if (rest.length) inShort.push(`${rest.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()));
      if (truncated)
        inShort.push(`Each list below shows at most ${n} entries; the counts are exact.`);
    }
    if (baselineEmpty) {
      inShort.push(
        `The starting snapshot ${code(input.from)} is empty, so everything counts as added; pick a later snapshot for a useful comparison.`,
      );
    }
    const report = renderReport({
      title: `What changed ${span}`,
      inShort,
      details: md.join("\n"),
      next: [
        ...(componentTotal > 0
          ? ["Run `what_broke` or `impact_from_git_diff` to see what the changes affect."]
          : []),
        ...(baselineEmpty ? ["Run `snapshot_list` to pick a later snapshot."] : []),
        NOTES.componentLevel,
      ],
    });
    return {
      summary: `diff: +${cc.added} ~${cc.changed} -${cc.removed} components (+${counts.nodes.added} ~${counts.nodes.changed} -${counts.nodes.removed} nodes)${baselineEmpty ? " (empty baseline)" : ""}`,
      markdown: report,
      data: {
        // The component answer: component units, members rolled up.
        componentDiff: cut(scoped.component),
        // Record/config units, kept visible apart from the components.
        nonComponentChanges: { ...cut(scoped.nonComponent), counts: counts.nonComponent },
        // Raw node-level diff, every label.
        nodeDiff: {
          added: nodeDiff.added.slice(0, n),
          removed: nodeDiff.removed.slice(0, n),
          changed: nodeDiff.changed.slice(0, n),
        },
        edgeDiff: { added: edgeDiff.added, removed: edgeDiff.removed },
        counts,
        truncated,
        baselineEmpty,
      },
      follow_up_tools: ["what_broke", "impact_from_git_diff", "deployment_manifest_gen"],
    };
  },
});
