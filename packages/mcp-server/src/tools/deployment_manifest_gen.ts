import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  from_org: z.string().min(1),
  to_org: z.string().min(1),
  category: z.string().optional(),
});

defineTool({
  name: "deployment_manifest_gen",
  description: "Generate package.xml + destructiveChanges.xml from cross-org diff.",
  inputSchema,
  async execute(input) {
    // Open BOTH org contexts so the manifest sees the target org's actual
    // node set (each org has its own SQLite file). Aliases for both inputs
    // are resolved by getToolContext.
    const ctxA = await getToolContext({ orgId: input.from_org });
    const ctxB = await getToolContext({ orgId: input.to_org });
    const manifest = analyze.generateManifest({
      storeA: ctxA.graphStore,
      orgA: ctxA.orgId,
      storeB: ctxB.graphStore,
      orgB: ctxB.orgId,
      category: input.category ?? "all",
    });
    const unmapped = Object.entries(manifest.incomplete.unmappedLabels);
    const incompleteNote =
      manifest.incomplete.diffTruncated || unmapped.length > 0
        ? [
            "",
            "> ⚠️ **This manifest is INCOMPLETE — do not treat it as the full change set.**",
            ...(manifest.incomplete.diffTruncated
              ? [
                  "> - The cross-org diff hit its per-label cap; some changed members were not considered.",
                ]
              : []),
            ...(unmapped.length > 0
              ? [
                  `> - ${unmapped.reduce((s, [, c]) => s + c, 0)} changed component(s) have no package.xml type mapping and were dropped: ${unmapped
                    .map(([l, c]) => `${l}×${c}`)
                    .join(", ")}.`,
                ]
              : []),
          ]
        : [];
    return {
      summary: `${manifest.summary.addedOrChanged} added/changed, ${manifest.summary.removed} removed${
        incompleteNote.length ? " (INCOMPLETE)" : ""
      }`,
      markdown: [
        "### package.xml",
        "```xml",
        manifest.packageXml.trimEnd(),
        "```",
        "",
        "### destructiveChanges.xml",
        "```xml",
        manifest.destructiveXml.trimEnd(),
        "```",
        ...incompleteNote,
      ].join("\n"),
      data: manifest,
      follow_up_tools: ["cross_org_diff"],
    };
  },
});
