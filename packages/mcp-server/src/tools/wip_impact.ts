import { analyze } from "@ryanstark24/sfgraph-core";
import { ConfigError, readWorkspace } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { resolveWipProjectRoot } from "./_project-root.js";
import { wipImpactReport } from "./_wip_report.js";

const inputSchema = z.object({
  project_root: z.string().min(1).optional(),
  org: z.string().min(1).optional(),
  depth: numeric(z.number().int().min(1).max(5).default(3)),
  mode: z.enum(["changed-only", "full-folder"]).default("changed-only"),
  /** Show the Picture (a diagram of at most 25 components); false hides it. */
  mermaid: z.boolean().default(true),
});

defineTool({
  name: "wip_impact",
  description:
    "Use for 'what do my local changes break'. Overlays local source on the org graph (read-only): the changes and their dependents.",
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
          "wip_impact: no `org` provided and no workspace binding found. Run `sfgraph link --org <alias>` first.",
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
      // For the report only: which dependents are tests, or cannot carry Apex test coverage.
      testGaps: true,
    });
    return {
      summary: `WIP impact: ${result.changedQnames.length} changed, ${result.addedQnames.length} added, ${result.dependents.length} dependents`,
      markdown: wipImpactReport(result, input.depth, input.mermaid),
      data: {
        changed: result.changedQnames,
        added: result.addedQnames,
        removed: result.removedQnames,
        dependents: result.dependents,
      },
      follow_up_tools: [
        "wip_diff",
        "wip_test_gap",
        "impact_from_git_diff",
        "deployment_manifest_gen",
      ],
    };
  },
});
