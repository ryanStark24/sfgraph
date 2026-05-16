import { analyze, render } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({
  org_a: z.string().min(1),
  org_b: z.string().min(1),
  category: z.string().default("all"),
});

defineTool({
  name: "cross_org_diff",
  description:
    "USE THIS for any 'what is different between prod and sandbox' / 'compare two orgs' / 'org drift' question. Set difference of metadata between two ingested Salesforce orgs by category. Returns onlyInA / onlyInB / changed lists.",
  inputSchema,
  async execute(input) {
    // Each org has its own SQLite file. Open BOTH contexts so onlyInA/onlyInB
    // are computed against the right rows. getToolContext resolves aliases
    // for both org_a and org_b.
    const ctxA = await getToolContext({ orgId: input.org_a });
    const ctxB = await getToolContext({ orgId: input.org_b });
    const diff = analyze.diffOrgs({
      storeA: ctxA.graphStore,
      orgA: ctxA.orgId,
      storeB: ctxB.graphStore,
      orgB: ctxB.orgId,
      category: input.category,
    });
    const mermaid = render.renderDiff({
      added: diff.onlyInB.slice(0, 30).map((n) => ({ qualifiedName: n.qualifiedName })),
      removed: diff.onlyInA.slice(0, 30).map((n) => ({ qualifiedName: n.qualifiedName })),
      changed: diff.changed.slice(0, 30).map((c) => ({ qualifiedName: c.a.qualifiedName })),
    });
    const md = [
      "| metric | count |",
      "|---|---|",
      `| only in A | ${diff.onlyInA.length} |`,
      `| only in B | ${diff.onlyInB.length} |`,
      `| changed | ${diff.changed.length} |`,
      "",
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    const truncationNote = diff.truncated
      ? ` — results capped at ${analyze.CROSS_ORG_PER_LABEL_CAP}/label; narrow with category filter`
      : "";
    return {
      summary: `A-only:${diff.onlyInA.length} B-only:${diff.onlyInB.length} changed:${diff.changed.length}${truncationNote}`,
      markdown: diff.truncated
        ? `${md}\n\n> _Note: at least one label hit the ${analyze.CROSS_ORG_PER_LABEL_CAP}-row cap. Diff is incomplete — pass a narrower \`category\` to investigate._`
        : md,
      data: {
        onlyInA: diff.onlyInA.map((n) => n.qualifiedName),
        onlyInB: diff.onlyInB.map((n) => n.qualifiedName),
        changed: diff.changed.map((c) => c.a.qualifiedName),
        truncated: diff.truncated ?? false,
      },
      follow_up_tools: ["point_in_time_diff", "deployment_manifest_gen"],
    };
  },
});
