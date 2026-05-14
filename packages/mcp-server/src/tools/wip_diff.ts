import { analyze } from "@ryanstark24/sfgraph-core";
import { ConfigError, readWorkspace } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  project_root: z.string().min(1).optional(),
  org: z.string().min(1).optional(),
  mode: z.enum(["changed-only", "full-folder"]).default("changed-only"),
});

defineTool({
  name: "wip_diff",
  description:
    "USE THIS for any 'show me what is different between my local source and the org' / 'list local-only / org-only metadata' question. Returns just the added/changed/removed sets — no dependent fan-out. Faster than wip_impact when you only need the diff.",
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
      markdown: md,
      data: {
        added: result.addedQnames,
        changed: result.changedQnames,
        removed: result.removedQnames,
      },
    };
  },
});
