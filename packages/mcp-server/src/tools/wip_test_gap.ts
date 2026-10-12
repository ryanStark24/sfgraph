import { analyze } from "@ryanstark24/sfgraph-core";
import { ConfigError, readWorkspace } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { resolveWipProjectRoot } from "./_project-root.js";
import { wipTestGapReport } from "./_wip_report.js";

const inputSchema = z.object({
  project_root: z.string().min(1).optional(),
  org: z.string().min(1).optional(),
  depth: numeric(z.number().int().min(1).max(5).default(3)),
  mode: z.enum(["changed-only", "full-folder"]).default("changed-only"),
});

defineTool({
  name: "wip_test_gap",
  description:
    "Use for 'which local changes lack tests': changed or added Apex classes and triggers, and dependents, no test covers.",
  inputSchema,
  async execute(input) {
    const projectRoot = resolveWipProjectRoot(input.project_root ?? process.cwd());
    let orgArg = input.org;
    if (!orgArg) {
      const ws = await readWorkspace(projectRoot);
      if (ws?.orgId) {
        orgArg = ws.orgId;
      } else {
        throw new ConfigError(
          "wip_test_gap: no `org` provided and no workspace binding found. Run `sfgraph link --org <alias>` first.",
        );
      }
    }
    const ctx = await getToolContext(orgArg ? { orgId: orgArg } : {});
    const result = await analyze.analyzeLocalImpact({
      graphStore: ctx.graphStore,
      orgId: ctx.orgId,
      projectRoot,
      depth: input.depth,
      mode: input.mode,
      testGaps: true,
    });
    const gaps = result.testGaps ?? { uncovered: [], covered: [], tests: [], notApplicable: [] };
    const uncovered = gaps.uncovered;
    const md =
      uncovered.length === 0
        ? "No uncovered dependents found."
        : [
            `Uncovered dependents (${uncovered.length}):`,
            ...uncovered.map(
              (d) =>
                `- ${d.qname} (${d.label}, ${d.seed ? `${d.seed} locally` : `depth=${d.depth}`}${d.viaRelType ? `, via=${d.viaRelType}` : ""})`,
            ),
          ].join("\n");
    return {
      summary: `${uncovered.length} uncovered Apex components from WIP changes`,
      markdown: wipTestGapReport(result, md),
      data: {
        uncovered,
        covered: gaps.covered,
        tests: gaps.tests,
        notApplicable: gaps.notApplicable,
      },
      follow_up_tools: ["wip_impact", "impact_from_git_diff"],
    };
  },
});
