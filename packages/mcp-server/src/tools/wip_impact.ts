import { analyze } from "@ryanstark24/sfgraph-core";
import { ConfigError, readWorkspace } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  project_root: z.string().min(1).optional(),
  org: z.string().min(1).optional(),
  depth: z.number().int().min(1).max(5).default(3),
  mode: z.enum(["changed-only", "full-folder"]).default("changed-only"),
});

defineTool({
  name: "wip_impact",
  description:
    "Local impact analysis: parse uncommitted sfdx-source changes and compute dependents against the persisted graph (read-only).",
  inputSchema,
  async execute(input) {
    const projectRoot = input.project_root ?? process.cwd();
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
    });
    const md = [
      `Changed: ${result.changedQnames.length}, Added: ${result.addedQnames.length}, Removed: ${result.removedQnames.length}, Dependents: ${result.dependents.length}`,
      "",
      "```mermaid",
      result.mermaid,
      "```",
    ].join("\n");
    return {
      summary: `WIP impact: ${result.changedQnames.length} changed, ${result.addedQnames.length} added, ${result.dependents.length} dependents`,
      markdown: md,
      data: {
        changed: result.changedQnames,
        added: result.addedQnames,
        removed: result.removedQnames,
        dependents: result.dependents,
      },
    };
  },
});
