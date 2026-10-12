import { analyze } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { labelOfQname } from "./_reach_list.js";
import {
  NOTES,
  andList,
  code,
  kindCounts,
  linkFacts,
  linkLines,
  nameOf,
  pieceCount,
  pieceRole,
  renderReport,
  reportDiagram,
  testSplit,
} from "./_report.js";
import { DIFF_MERMAID_MAX_NODES, isSnapshotEmpty } from "./_snapshot-util.js";

const TITLE = "What could have broken since the last sync";

/** The plain report for an answer with no comparison (no baseline, empty baseline, no change). */
const plain = (inShort: string, details: string, next: string[]): string =>
  renderReport({ title: TITLE, inShort: [inShort], details, next });

/** Max changed/added/removed seeds traced for dependents. The counts always
 *  cover every change. */
const MAX_SEEDS = 200;

const inputSchema = z.object({
  org: z.string().min(1),
  since: z.string().optional(),
  /** Max entries returned per list (changed / added / atRisk / covered), as
   *  in point_in_time_diff. `counts` always holds the full totals. */
  limit: numeric(z.number().int().min(1).max(1000).default(100)),
  /** Dependent hops traced from each change. Default 1: what directly
   *  depends on a change. */
  depth: numeric(z.number().int().min(1).max(5).default(1)),
  /** Show the Picture (a diagram of at most 25 components); false hides it. */
  mermaid: z.boolean().default(true),
});

defineTool({
  name: "what_broke",
  description:
    "Use for 'what broke' after a deploy or sync. Compares with the latest pre-sync snapshot (or `since`): changes and dependents, at risk (no tests) or covered.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    let fromId = input.since;
    const follow = ["point_in_time_diff", "impact_from_git_diff", "deployment_manifest_gen"];
    if (!fromId) {
      const snaps = ctx.snapshotStore.listSnapshots(ctx.orgId);
      const autos = snaps.filter((s) => s.isAuto || s.label.startsWith("pre-sync"));
      if (autos.length === 0) {
        return {
          summary: "no baseline snapshot",
          markdown: plain(
            "No earlier snapshot of this org was found, so there is nothing to compare against.",
            "> no auto snapshot found; pass `since` explicitly",
            ["Pass `since` with a snapshot id from `snapshot_list`, or sync the org again first."],
          ),
          data: { atRisk: [], covered: [] },
          follow_up_tools: follow,
        };
      }
      // Skip empty auto snapshots (the pre-sync one taken before the first
      // ingest): against them every node is "added" and nothing is learned.
      const usable = autos.find((s) => isSnapshotEmpty(ctx, s.id) !== true);
      if (!usable) {
        return {
          summary: "no usable baseline",
          markdown: plain(
            "Every earlier snapshot of this org is empty (taken before the first load), so there is nothing to compare against.",
            "> no usable baseline: every auto snapshot is empty (taken before the first ingest). Re-run after the next sync, or pass `since` with a snapshot from snapshot_list.",
            [
              "Ask again after the next sync, or pass `since` with a snapshot id from `snapshot_list`.",
            ],
          ),
          data: { atRisk: [], covered: [], baselineEmpty: true },
          follow_up_tools: ["snapshot_list", ...follow],
        };
      }
      fromId = usable.id;
    }
    const nodeDiff = ctx.snapshotStore.diffNodes(ctx.orgId, fromId, "current");
    if (isSnapshotEmpty(ctx, fromId) === true) {
      return {
        summary: `empty baseline: ${nodeDiff.added.length} nodes added`,
        markdown: plain(
          `The chosen snapshot is empty (taken before the first load), so all ${nodeDiff.added.length} current components count as new and nothing can be said about what broke.`,
          `> Baseline snapshot \`${fromId}\` is empty (taken before the first ingest), so all ${nodeDiff.added.length} current nodes count as added; there is no prior state to regress from. Pass \`since\` with a later snapshot (snapshot_list).`,
          ["Pass `since` with a later snapshot id from `snapshot_list`."],
        ),
        data: { added: nodeDiff.added.length, atRisk: [], covered: [], baselineEmpty: true },
        follow_up_tools: ["snapshot_list", ...follow],
      };
    }
    const seedKind = new Map<string, "Changed" | "Added" | "Removed">();
    for (const c of nodeDiff.changed) seedKind.set(c.after.qualifiedName, "Changed");
    for (const a of nodeDiff.added) seedKind.set(a.qualifiedName, "Added");
    for (const r of nodeDiff.removed) seedKind.set(r.qualifiedName, "Removed");
    if (seedKind.size === 0) {
      return {
        summary: "no changes",
        markdown: plain(
          "Nothing changed since the snapshot, so nothing is at risk.",
          "_no changes since snapshot_",
          ["Pass an older `since` (see `snapshot_list`) to compare with an earlier state."],
        ),
        data: { atRisk: [], covered: [] },
        follow_up_tools: follow,
      };
    }
    // Component units (members rolled up) and record/config rows, apart
    // (core component-scope.ts). Only component changes seed dependents.
    const scoped = analyze.scopeNodeDiff(ctx.graphStore, ctx.orgId, nodeDiff);
    const seedUnit = (qn: string): string => analyze.changeUnitOf(ctx.graphStore, ctx.orgId, qn);
    const isComponent = (unit: string, label?: string): boolean =>
      analyze.changeScopeOf(unit, label) === "component";
    const changedQnames = [...seedKind.keys()].filter((q) => isComponent(seedUnit(q)));
    const seeds = changedQnames.slice(0, MAX_SEEDS);
    // Record/config changes are not traced for dependents (fix M-6): say which.
    const untracedSeeds = [...seedKind.keys()]
      .filter((q) => !isComponent(seedUnit(q)))
      .sort(analyze.codePointCompare);
    const classify = analyze.makeCoverageClassifier(ctx.graphStore, ctx.orgId);
    // Sets: a dependent shared by several seeds is classified once (review M3).
    const dependents = new Set<string>();
    const nonComponentDeps = new Set<string>();
    const allNodes = new Map<string, { qualifiedName: string; label: string }>();
    const allEdges: Array<{ srcQualifiedName: string; dstQualifiedName: string }> = [];
    // The same links with their relationship type, for the report only.
    const relEdges: Array<{ from: string; to: string; rel: string }> = [];
    // The nearest step at which each dependent unit was reached, for the report's order.
    const hopOf = new Map<string, number>();
    for (const qn of seeds) {
      const qname = asQualifiedName(qn);
      allNodes.set(qn, { qualifiedName: qn, label: seedKind.get(qn) ?? "Changed" });
      const own = seedUnit(qn);
      const dep = analyze.findDependents(ctx.graphStore, ctx.orgId, qname, input.depth);
      for (const n of dep.nodes) {
        allNodes.set(n.qualifiedName, { qualifiedName: n.qualifiedName, label: n.label });
        // Same roll-up as the seeds (fix M-7): an LWC bundle is its LWC.
        const unit = seedUnit(String(n.qualifiedName));
        // A sibling of a method seed rolls up to the seed's own class.
        if (unit === own) continue;
        // Record/config dependents (a DataPack record naming a changed
        // OmniScript) stay visible, apart from the component answer.
        if (isComponent(unit, unit === String(n.qualifiedName) ? n.label : undefined)) {
          dependents.add(unit);
        } else {
          nonComponentDeps.add(unit);
        }
      }
      for (const row of dep.reached ?? []) {
        const u = seedUnit(String(row.qualifiedName));
        hopOf.set(u, Math.min(hopOf.get(u) ?? row.hop, row.hop));
      }
      for (const e of dep.rowEdges ?? dep.edges) {
        allEdges.push({
          srcQualifiedName: e.srcQualifiedName,
          dstQualifiedName: e.dstQualifiedName,
        });
        relEdges.push({ from: e.srcQualifiedName, to: e.dstQualifiedName, rel: e.relType });
      }
    }
    // Priority order before the limit cut: production before test code, then
    // qname by code point.
    const byPriority = (a: string, b: string): number =>
      Number(classify(a).isTest) - Number(classify(b).isTest) || analyze.codePointCompare(a, b);
    const atRiskList = [...dependents].filter((u) => !classify(u).covered).sort(byPriority);
    const coveredList = [...dependents].filter((u) => classify(u).covered).sort(byPriority);
    const testCount = [...dependents].filter((u) => classify(u).isTest).length;
    const nonComponentDependents = [...nonComponentDeps].sort(analyze.codePointCompare);
    const sc = scoped.component;
    // `changed` = every changed component (changed + added + removed units).
    const changedUnits = [...new Set([...sc.changed, ...sc.added, ...sc.removed])].sort(
      analyze.codePointCompare,
    );
    const addedList = sc.added;
    const removedList = sc.removed;
    const nonComponent = scoped.nonComponent;
    const n = input.limit;
    const counts = {
      changed: changedUnits.length,
      added: addedList.length,
      removed: removedList.length,
      atRisk: atRiskList.length,
      covered: coveredList.length,
      tests: testCount,
      nonComponent: {
        changed: nonComponent.changed.length,
        added: nonComponent.added.length,
        removed: nonComponent.removed.length,
        dependents: nonComponentDependents.length,
      },
    };
    // Seeds past MAX_SEEDS were not traced, so atRisk/covered are partial too
    // (review N3).
    const seedsTruncated = changedQnames.length - seeds.length;
    const truncated =
      seedsTruncated > 0 ||
      counts.changed > n ||
      counts.added > n ||
      counts.removed > n ||
      counts.atRisk > n ||
      counts.covered > n ||
      counts.nonComponent.changed > n ||
      counts.nonComponent.added > n ||
      counts.nonComponent.removed > n ||
      counts.nonComponent.dependents > n;
    // Component counts, as in `data.counts` (not the node-level diff).
    const atRiskTests = atRiskList.filter((u) => classify(u).isTest).length;
    const header = `Changed: ${counts.changed}, added: ${counts.added}, removed: ${counts.removed}; at risk: ${counts.atRisk}${
      atRiskTests ? ` (${atRiskTests} test class${atRiskTests === 1 ? "" : "es"})` : ""
    }, covered: ${counts.covered}`;
    const ncCounts = counts.nonComponent;
    const ncChanged = ncCounts.changed + ncCounts.added + ncCounts.removed;
    const md = [
      ncChanged + ncCounts.dependents > 0
        ? `${header}; records/config (not components): ${ncChanged} changed, ${ncCounts.dependents} depending`
        : header,
    ];
    if (untracedSeeds.length > 0) {
      md.push(
        "",
        `_${untracedSeeds.length} record/config change${untracedSeeds.length === 1 ? "" : "s"} not traced for dependents._`,
      );
    }
    if (seeds.length < changedQnames.length) {
      md.push(
        "",
        `_Dependents traced for the first ${seeds.length} of ${changedQnames.length} changes; use point_in_time_diff for the full list._`,
      );
    }
    // The lists are always written out (the core diagram they used to give way to is now the
    // report's Picture); a small trace also lists its links, members included.
    {
      const shown = atRiskList.slice(0, n);
      const prod = shown.filter((u) => !classify(u).isTest);
      const tests = shown.filter((u) => classify(u).isTest);
      md.push(
        "",
        `**Changed components** (${changedUnits.length}${changedUnits.length > n ? `, first ${n}` : ""})`,
        ...changedUnits.slice(0, n).map((q) => `- ${q}`),
      );
      md.push("", "**At risk (no tests)**", ...prod.map((q) => `- ${q}`));
      if (tests.length > 0) {
        md.push("", "**Test classes depending on a change**", ...tests.map((q) => `- ${q}`));
      }
      if (atRiskList.length > n) md.push(`- _…${atRiskList.length - n} more_`);
      if (coveredList.length > 0) {
        md.push("", "**Covered by tests**", ...coveredList.slice(0, n).map((q) => `- ${q}`));
        if (coveredList.length > n) md.push(`- _…${coveredList.length - n} more_`);
      }
      if (allNodes.size <= DIFF_MERMAID_MAX_NODES && relEdges.length > 0) {
        md.push(
          "",
          `**Links traced** (${new Set(relEdges.map((e) => `${e.from}>${e.to}>${e.rel}`)).size})`,
          ...linkLines(relEdges),
        );
      }
    }
    const ncTotal =
      nonComponent.changed.length + nonComponent.added.length + nonComponent.removed.length;
    if (ncTotal + nonComponentDependents.length > 0) {
      const all = [...nonComponent.changed, ...nonComponent.added, ...nonComponent.removed].sort(
        analyze.codePointCompare,
      );
      md.push(
        "",
        "### Records and configuration (not components)",
        "_Custom metadata records, DataPack records, access and UI configuration: not traced for dependents._",
      );
      if (ncTotal > 0) {
        md.push(
          "",
          `**Changed records/config** (${ncTotal}${ncTotal > n ? `, first ${n}` : ""})`,
          ...all.slice(0, n).map((q) => `- ${q}`),
        );
      }
      if (nonComponentDependents.length > 0) {
        md.push(
          "",
          `**Records/config depending on a change** (${nonComponentDependents.length})`,
          ...nonComponentDependents.slice(0, n).map((q) => `- ${q}`),
        );
      }
    }
    // The report: components only (a member is drawn as its component).
    const labelOf = (u: string): string =>
      ctx.graphStore.getNode(ctx.orgId, asQualifiedName(u))?.label ?? labelOfQname(u);
    const changedSet = new Set(changedUnits);
    const unitEdges = relEdges
      .map((e) => ({ from: seedUnit(e.from), to: seedUnit(e.to), rel: e.rel }))
      .filter((e) => e.from !== e.to);
    // Pieces by group (changed, at risk, covered: a deliberate grouping), then step, then name.
    const byHop = (a: string, b: string): number =>
      (hopOf.get(a) ?? 0) - (hopOf.get(b) ?? 0) || analyze.codePointCompare(a, b);
    const reportUnits = [
      ...new Set([
        ...changedUnits,
        ...[...atRiskList].sort(byHop),
        ...[...coveredList].sort(byHop),
      ]),
    ].slice(0, 200);
    const facts = linkFacts(unitEdges, new Set(reportUnits));
    // Only an Apex class or trigger that is not a test can lack a test (review I1/M2).
    const atRiskApex = atRiskList.filter((u) => classify(u).applicable && !classify(u).isTest);
    const atRiskOther = atRiskList.filter((u) => !classify(u).applicable && !classify(u).isTest);
    const atRiskProd = atRiskApex.length;
    const inShort = [
      `Since the snapshot, ${changedUnits.length ? kindCounts(changedUnits.map(labelOf)) : "no components"} changed${
        counts.added || counts.removed
          ? ` (${andList([...(counts.added ? [`${counts.added} new`] : []), ...(counts.removed ? [`${counts.removed} removed`] : [])])})`
          : ""
      }.`,
      dependents.size
        ? `${pieceCount(dependents.size).replace(/^./, (c) => c.toUpperCase())} that rely on a change ${dependents.size === 1 ? "was" : "were"} found within ${input.depth} ${input.depth === 1 ? "step" : "steps"}: ${testSplit(
            {
              noTest: atRiskApex.map(labelOf),
              covered: coveredList.length,
              tests: atRiskTests,
              notApplicable: atRiskOther.map(labelOf),
            },
            "tests",
          )}.`
        : `Nothing relies on the changes within ${input.depth} ${input.depth === 1 ? "step" : "steps"}.`,
    ];
    const notes: string[] = [];
    if (ncChanged + ncCounts.dependents > 0)
      notes.push(
        `${ncChanged + ncCounts.dependents} records or settings changed or rely on a change, and were not traced further`,
      );
    if (seedsTruncated > 0) notes.push(`only the first ${seeds.length} changes were traced`);
    if (truncated) notes.push(`lists are cut at ${n} entries (the \`limit\` option)`);
    if (notes.length) inShort.push(`${andList(notes).replace(/^./, (c) => c.toUpperCase())}.`);
    const roleOf = (u: string): string => {
      const f = facts(u);
      const any = f.callers.length + f.usedBy.length + f.callees.length + f.does.length > 0;
      const base = any ? `${pieceRole({ kind: labelOf(u), ...f })} ` : "";
      if (changedSet.has(u)) return `${base}Changed since the snapshot.`;
      const c = classify(u);
      if (c.isTest) return `${base}A test class that relies on a change.`;
      if (!c.applicable) return `${base}Apex tests do not apply.`;
      return `${base}${c.covered ? "Covered by tests." : "No tests cover it."}`;
    };
    const next: string[] = [];
    if (atRiskProd > 0) next.push("Add or run tests for the pieces no tests cover.");
    next.push(
      `Raise \`depth\` (now ${input.depth}) to include pieces further from the change.`,
      "Run `point_in_time_diff` for the full list of changes, or `trace_upstream` on one piece for its chain.",
      NOTES.componentLevel,
    );
    if (reportUnits.some((u) => labelOf(u) === "ApexTrigger")) next.push(NOTES.triggerCoverage);
    const report = renderReport({
      title: TITLE,
      inShort,
      diagram: input.mermaid
        ? reportDiagram(
            reportUnits.map((u) => ({ id: u, label: labelOf(u) })),
            unitEdges,
          )
        : undefined,
      pieces: reportUnits.map((u) => ({ name: u, kind: labelOf(u), role: roleOf(u) })),
      details: md.join("\n"),
      next,
    });
    return {
      summary: `${atRiskList.length} dependents at risk`,
      markdown: report,
      data: {
        // `changed` = every changed component unit (changed + added +
        // removed; members rolled up); `added` / `removed` are its subsets.
        changed: changedUnits.slice(0, n),
        added: addedList.slice(0, n),
        removed: removedList.slice(0, n),
        atRisk: atRiskList.slice(0, n),
        covered: coveredList.slice(0, n),
        // Record/config rows, kept visible apart from the component answer.
        nonComponentChanges: {
          changed: nonComponent.changed.slice(0, n),
          added: nonComponent.added.slice(0, n),
          removed: nonComponent.removed.slice(0, n),
        },
        nonComponentDependents: nonComponentDependents.slice(0, n),
        counts,
        seedsTraced: seeds.length,
        seedsTruncated,
        // Changed record/config rows (raw qnames) that seeded no dependent
        // trace; `untracedSeedsTotal` is the full count.
        untracedSeeds: untracedSeeds.slice(0, n),
        untracedSeedsTotal: untracedSeeds.length,
        truncated,
        depth: input.depth,
      },
      follow_up_tools: ["point_in_time_diff", "impact_from_git_diff"],
    };
  },
});
