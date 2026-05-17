import { analyze } from "@ryanstark24/sfgraph-core";
import { ConfigError, readWorkspace } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { resolveWipProjectRoot } from "./_project-root.js";

const inputSchema = z.object({
  project_root: z.string().min(1).optional(),
  org: z.string().min(1).optional(),
  depth: z.number().int().min(1).max(5).default(3),
  mode: z.enum(["changed-only", "full-folder"]).default("changed-only"),
});

defineTool({
  name: "wip_impact",
  description:
    "USE THIS for any 'what does this branch break' / 'dry-run my local changes' / 'what would happen if I deployed this' / 'impact of my uncommitted changes' question. Parses the local sfdx-source tree (force-app/) and overlays it on the org's persisted graph WITHOUT writing to it. Returns changed/added/removed qnames + N-hop dependent BFS + Mermaid. The local-equivalent of impact_from_git_diff for uncommitted work.",
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
      follow_up_tools: ["wip_diff", "wip_test_gap", "impact_from_git_diff", "deployment_manifest_gen"],
    };
  },
});
