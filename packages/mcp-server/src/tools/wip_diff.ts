import { analyze } from "@ryanstark24/sfgraph-core";
import { ConfigError, readWorkspace } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { resolveWipProjectRoot } from "./_project-root.js";
import { wipDiffReport } from "./_wip_report.js";

const inputSchema = z.object({
  project_root: z.string().min(1).optional(),
  org: z.string().min(1).optional(),
  mode: z.enum(["changed-only", "full-folder"]).default("changed-only"),
});

defineTool({
  name: "wip_diff",
  description:
    "Use to list how local source differs from the org: added, changed and removed components.",
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
          "wip_diff: no `org` provided and no workspace binding found. Run `sfgraph link --org <alias>` first.",
        );
      }
    }
    const ctx = await getToolContext(orgArg ? { orgId: orgArg } : {});
    const result = await analyze.analyzeLocalImpact({
      graphStore: ctx.graphStore,
      orgId: ctx.orgId,
      projectRoot,
      mode: input.mode,
      // wip_diff reports only added/changed/removed: no dependents pass.
      skipDependents: true,
    });
    const md = [
      `Added (${result.addedQnames.length}):`,
      ...result.addedQnames.map((q) => `  + ${q}`),
      "",
      `Changed (${result.changedQnames.length}):`,
      ...result.changedQnames.map((q) => `  ~ ${q}`),
      "",
      `Removed (${result.removedQnames.length}):`,
      ...result.removedQnames.map((q) => `  - ${q}`),
    ].join("\n");
    return {
      summary: `WIP diff: +${result.addedQnames.length} ~${result.changedQnames.length} -${result.removedQnames.length}`,
      markdown: wipDiffReport(result, input.mode, md),
      data: {
        added: result.addedQnames,
        changed: result.changedQnames,
        removed: result.removedQnames,
      },
      follow_up_tools: ["wip_impact", "wip_test_gap", "deployment_manifest_gen"],
    };
  },
});
