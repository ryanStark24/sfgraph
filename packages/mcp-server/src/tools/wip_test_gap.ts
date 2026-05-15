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
  name: "wip_test_gap",
  description:
    "USE THIS for any 'what tests am I missing for these local changes' / 'will my uncommitted changes have test coverage gaps' question. Runs wip_impact internally then filters dependents to those without IS_TEST_FOR coverage.",
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
    });
    const uncovered = result.dependents.filter((d) => !d.coveredByTest);
    const md =
      uncovered.length === 0
        ? "No uncovered dependents found."
        : [
            `Uncovered dependents (${uncovered.length}):`,
            ...uncovered.map(
              (d) =>
                `- ${d.qname} (${d.label}, depth=${d.depth}${d.viaRelType ? `, via=${d.viaRelType}` : ""})`,
            ),
          ].join("\n");
    return {
      summary: `${uncovered.length} uncovered dependents from WIP changes`,
      markdown: md,
      data: { uncovered },
    };
  },
});
