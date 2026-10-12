import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { code, countNoun, renderReport } from "./_report.js";

/** How many `<members>` entries a manifest XML lists. */
const memberCount = (xml: string): number => (xml.match(/<members>/g) ?? []).length;

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
    const a = code(input.from_org);
    const b = code(input.to_org);
    const deploy = memberCount(manifest.packageXml);
    const remove = memberCount(manifest.destructiveXml);
    const droppedN = unmapped.reduce((s, [, c]) => s + c, 0);
    const markdown = renderReport({
      title: `Deployment files to make ${b} match ${a}`,
      inShort: [
        `To make ${b} match ${a}, the package file lists ${countNoun(deploy, "component")} to deploy (new in ${a} or changed) and the delete file lists ${countNoun(remove, "component")} to remove (only in ${b}).`,
        input.category
          ? `Compared: the ${code(input.category)} category only.`
          : "Compared: every category.",
        ...(manifest.incomplete.diffTruncated
          ? [
              "The comparison hit its row limit, so these files are incomplete; narrow it with `category`.",
            ]
          : []),
        ...(droppedN > 0
          ? [
              `${countNoun(droppedN, "changed component")} ${droppedN === 1 ? "has" : "have"} no deployment type and ${droppedN === 1 ? "was" : "were"} left out of the files.`,
            ]
          : []),
      ],
      details: [
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
      next: ["Review both files before deploying; run `cross_org_diff` to see each difference."],
    });
    return {
      summary: `${manifest.summary.addedOrChanged} added/changed, ${manifest.summary.removed} removed${
        incompleteNote.length ? " (INCOMPLETE)" : ""
      }`,
      markdown,
      data: manifest,
      follow_up_tools: ["cross_org_diff"],
    };
  },
});
