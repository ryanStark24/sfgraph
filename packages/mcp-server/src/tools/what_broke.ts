import { analyze, render } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org: z.string().min(1),
  since: z.string().optional(),
});

defineTool({
  name: "what_broke",
  description: "Find at-risk dependents of metadata changed since a snapshot.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    let fromId = input.since;
    if (!fromId) {
      const snaps = ctx.snapshotStore.listSnapshots(ctx.orgId);
      const auto = snaps.find((s) => s.isAuto || s.label.startsWith("pre-sync"));
      if (!auto) {
        return {
          summary: "no baseline snapshot",
          markdown: "> no auto snapshot found; pass `since` explicitly",
          data: { atRisk: [], covered: [] },
        };
      }
      fromId = auto.id;
    }
    const nodeDiff = ctx.snapshotStore.diffNodes(ctx.orgId, fromId, "current");
    const changedQnames = [
      ...nodeDiff.changed.map((c) => c.after.qualifiedName),
      ...nodeDiff.removed.map((r) => r.qualifiedName),
    ];
    if (changedQnames.length === 0) {
      return {
        summary: "no changes",
        markdown: "_no changes since snapshot_",
        data: { atRisk: [], covered: [] },
      };
    }
    const atRisk: string[] = [];
    const covered: string[] = [];
    const allNodes = new Map<string, { qualifiedName: string; label: string }>();
    const allEdges: Array<{ srcQualifiedName: string; dstQualifiedName: string }> = [];
    for (const qn of changedQnames) {
      const qname = asQualifiedName(qn);
      allNodes.set(qn, { qualifiedName: qn, label: "Changed" });
      const dep = analyze.findDependents(ctx.graphStore, ctx.orgId, qname, 3);
      for (const n of dep.nodes) {
        allNodes.set(n.qualifiedName, { qualifiedName: n.qualifiedName, label: n.label });
        // Skip nodes that are themselves test classes (they reach the target via IS_TEST_FOR chain).
        const isTestClass =
          ctx.graphStore.listEdgesFrom(
            ctx.orgId,
            asQualifiedName(n.qualifiedName),
            "IS_TEST_FOR" as never,
          ).length > 0;
        if (isTestClass) continue;
        const hasTest = analyze.hasTestCoverage(
          ctx.graphStore,
          ctx.orgId,
          asQualifiedName(n.qualifiedName),
        );
        if (hasTest) covered.push(n.qualifiedName);
        else atRisk.push(n.qualifiedName);
      }
      for (const e of dep.edges) {
        allEdges.push({
          srcQualifiedName: e.srcQualifiedName,
          dstQualifiedName: e.dstQualifiedName,
        });
      }
    }
    const mermaid = render.renderDependencyGraph({
      nodes: Array.from(allNodes.values()),
      edges: allEdges,
      title: "what_broke",
    });
    const md = [
      `Changed: ${changedQnames.length}, at risk: ${atRisk.length}, covered: ${covered.length}`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    return {
      summary: `${atRisk.length} dependents at risk`,
      markdown: md,
      data: { changed: changedQnames, atRisk, covered },
    };
  },
});
