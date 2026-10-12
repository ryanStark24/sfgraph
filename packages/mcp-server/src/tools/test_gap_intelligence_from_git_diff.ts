import { analyze } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { findNodesSuggestion } from "./_not-found.js";
import { labelOfQname } from "./_reach_list.js";
import { listWithMore } from "./_report.js";
import { gapReport } from "./_wip_report.js";

/** Gaps listed in the text; the rest are counted. */
const GAPS_MAX = 50;

const inputSchema = z.object({
  org: z.string().min(1),
  diff: z.string().min(1),
  /** Dependent hops traced from each changed component. Default 1: the
   *  direct dependents of the diff. */
  depth: numeric(z.number().int().min(1).max(5).default(1)),
});

defineTool({
  name: "test_gap_intelligence_from_git_diff",
  description:
    "Use for 'which changes in this git diff lack tests': changed and dependent Apex classes and triggers no test covers.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const files = analyze.parseUnifiedDiff(input.diff);
    // T15 I-4: the same path mapping as impact_from_git_diff (every parsed
    // type, renames old+new), at component level; unmapped paths reported.
    const resolved = analyze.resolveDiffSeeds(ctx.graphStore, ctx.orgId, files, input.diff);
    const seedQnames = [...new Set(resolved.seeds.map((s) => s.component))];
    const classify = analyze.makeCoverageClassifier(ctx.graphStore, ctx.orgId);
    // unit -> true when it is (also) a changed component of the diff.
    const units = new Map<string, boolean>();
    const notFound: string[] = [];
    const consider = (q: string, isSeed: boolean): void => {
      const { unit } = classify(q);
      units.set(unit, isSeed || units.get(unit) === true);
    };
    for (const qn of seedQnames) {
      const dep = analyze.findDependents(
        ctx.graphStore,
        ctx.orgId,
        asQualifiedName(qn),
        input.depth,
      );
      // tools-11: report seeds the graph does not know instead of a silent 0.
      if (dep.found === false) {
        notFound.push(qn);
        continue;
      }
      // A changed class without tests is a gap too ("changed ... or directly
      // depending on a changed component").
      consider(qn, true);
      for (const n of dep.nodes) consider(String(n.qualifiedName), false);
    }
    const gaps: string[] = [];
    const changedGaps: string[] = [];
    const covered: string[] = [];
    const tests: string[] = [];
    const notApplicable: string[] = [];
    for (const [unit, isSeed] of [...units].sort((a, b) => analyze.codePointCompare(a[0], b[0]))) {
      const v = classify(unit);
      // A test is not a coverage gap in itself: decided on the owning class,
      // as test methods carry no IS_TEST_FOR of their own.
      if (v.isTest) tests.push(unit);
      else if (!v.applicable) notApplicable.push(unit);
      else if (v.covered) covered.push(unit);
      else {
        gaps.push(unit);
        if (isSeed) changedGaps.push(unit);
      }
    }
    const md = [
      `**Test gaps:** ${gaps.length}`,
      "",
      ...gaps.slice(0, GAPS_MAX).map((g) => `- \`${g}\``),
      ...(gaps.length > GAPS_MAX
        ? [
            `- _and ${gaps.length - GAPS_MAX} more (narrow the call: a smaller \`diff\` or a lower \`depth\`)_`,
          ]
        : []),
      ...(notFound.length > 0
        ? [
            "",
            `_${notFound.length} changed file${notFound.length === 1 ? "" : "s"} not in the graph_ (new, or not ingested yet): ${listWithMore(
              notFound.map((q) => `\`${q}\``),
              10,
            )}. ${findNodesSuggestion(notFound)}`,
          ]
        : []),
      ...(resolved.unmapped.length > 0
        ? [
            "",
            `_${resolved.unmapped.length} changed path${resolved.unmapped.length === 1 ? "" : "s"} not mapped to a graph node_: ${resolved.unmapped
              .slice(0, 10)
              .map((u) => `\`${u.path}\` (${u.reason})`)
              .join(
                ", ",
              )}${resolved.unmapped.length > 10 ? `, +${resolved.unmapped.length - 10} more (narrow the call: a smaller \`diff\`)` : ""}`,
          ]
        : []),
    ].join("\n");
    return {
      summary: `${gaps.length} changed or dependent Apex components lack tests${
        notFound.length > 0
          ? `; ${notFound.length} changed file${notFound.length === 1 ? "" : "s"} not found in graph`
          : ""
      }`,
      markdown: gapReport({
        title: "Which changes in this diff no tests cover",
        scope: `changed by this diff or relying on a change within ${input.depth} ${input.depth === 1 ? "step" : "steps"}`,
        found: "in or affected by the change",
        gaps: gaps.map((q) => ({
          qname: q,
          label: ctx.graphStore.getNode(ctx.orgId, asQualifiedName(q))?.label ?? labelOfQname(q),
          role: changedGaps.includes(q)
            ? "Changed in this diff; no test covers it."
            : "Relies on a change in this diff; no test covers it.",
        })),
        changedGaps: changedGaps.length,
        covered,
        tests,
        notApplicable,
        notChecked: [
          ...(notFound.length
            ? [
                `${notFound.length} changed ${notFound.length === 1 ? "file is" : "files are"} new or not loaded yet`,
              ]
            : []),
          ...(resolved.unmapped.length
            ? [
                `${resolved.unmapped.length} changed ${resolved.unmapped.length === 1 ? "path matches" : "paths match"} no component`,
              ]
            : []),
        ],
        details: md,
        next: [
          ...(notFound.length
            ? ["Check the names of new or unloaded files with `find_nodes`, or sync the org again."]
            : []),
          `Raise \`depth\` (now ${input.depth}) to check pieces further from the change.`,
          "Run `impact_from_git_diff` to see everything the change could affect.",
        ],
      }),
      data: {
        gaps,
        changedGaps,
        covered,
        tests,
        notApplicable,
        notFound,
        unmapped: resolved.unmapped,
        depth: input.depth,
      },
      follow_up_tools: ["impact_from_git_diff"],
    };
  },
});
