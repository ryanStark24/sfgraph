import { analyze } from "@sfgraph/core";
import { asOrgId } from "@sfgraph/shared";
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
    const ctx = await getToolContext({ orgId: input.from_org });
    const orgA = ctx.orgId;
    const orgB = asOrgId(input.to_org);
    const manifest = analyze.generateManifest(ctx.graphStore, orgA, orgB, input.category ?? "all");
    return {
      summary: `${manifest.summary.addedOrChanged} added/changed, ${manifest.summary.removed} removed`,
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
      ].join("\n"),
      data: manifest,
    };
  },
});
