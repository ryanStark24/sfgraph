import { analyze, render } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { labelOfQname } from "./_reach_list.js";
import { andList, code, countNoun, kindCounts, renderReport } from "./_report.js";

const inputSchema = z.object({
  org_a: z.string().min(1),
  org_b: z.string().min(1),
  category: z.string().default("all"),
  include_managed: z.boolean().default(false),
  include_standard: z.boolean().default(false),
});

/** Max qnames printed per list, so the three lists and the diagram fit the server text budget (TEXT_MAX). */
const LIST_CAP = 100;

/**
 * One capped list. Past the cap it suggests `category` only when the call passed none
 * (`filtered` false); with a category already passed it says how many are left out.
 */
function listSection(
  title: string,
  what: string,
  qnames: string[],
  filtered: boolean,
  note?: string,
): string[] {
  const head = `### ${title} (${note ? `${qnames.length}, ${note}` : qnames.length})`;
  if (qnames.length === 0) return [head, "_none_", ""];
  const shown = qnames.slice(0, LIST_CAP).map((q) => `- ${q}`);
  const more = qnames.length - LIST_CAP;
  return [
    head,
    ...shown,
    ...(more > 0
      ? [
          filtered
            ? `_+${more} more ${what} not shown_ (each list is capped at ${LIST_CAP})`
            : `_+${more} more ${what}_ (narrow with \`category\`)`,
        ]
      : []),
    "",
  ];
}

defineTool({
  name: "cross_org_diff",
  description:
    "Use to compare two orgs: metadata only in `org_a`, only in `org_b`, and changed, by category.",
  inputSchema,
  async execute(input) {
    // Each org has its own SQLite file. Open BOTH contexts so onlyInA/onlyInB
    // are computed against the right rows. getToolContext resolves aliases
    // for both org_a and org_b.
    const ctxA = await getToolContext({ orgId: input.org_a });
    const ctxB = await getToolContext({ orgId: input.org_b });
    // Managed-package and standard items present in one org only reflect what was installed or
    // retrieved, not anyone's change, so they are hidden by default (counted, never dropped silently).
    const diff = analyze.hideOneSided(
      analyze.diffOrgs({
        storeA: ctxA.graphStore,
        orgA: ctxA.orgId,
        storeB: ctxB.graphStore,
        orgB: ctxB.orgId,
        category: input.category,
      }),
      { includeManaged: input.include_managed, includeStandard: input.include_standard },
    );
    const { hidden } = diff;
    const hiddenParts = [
      ...(hidden.managed ? [countNoun(hidden.managed, "managed-package item")] : []),
      ...(hidden.standard ? [countNoun(hidden.standard, "standard Salesforce item")] : []),
    ];
    const hiddenFlags = [
      ...(hidden.managed ? ["`include_managed: true`"] : []),
      ...(hidden.standard ? ["`include_standard: true`"] : []),
    ];
    const hiddenTotal = hidden.managed + hidden.standard;
    const one = hiddenTotal === 1;
    const hiddenNote = hiddenParts.length
      ? `${andList(hiddenParts)} that ${one ? "is" : "are"} in only one org ${one ? "is" : "are"} not shown, though ${one ? "it counts" : "they count"} if the question is what exists in one org but not the other; call again with ${hiddenFlags.join(" or ")} to list ${one ? "it" : "them"}.`
      : null;
    const mermaid = render.renderDiff({
      added: diff.onlyInB.slice(0, 30).map((n) => ({ qualifiedName: n.qualifiedName })),
      removed: diff.onlyInA.slice(0, 30).map((n) => ({ qualifiedName: n.qualifiedName })),
      changed: diff.changed.slice(0, 30).map((c) => ({ qualifiedName: c.a.qualifiedName })),
    });
    const filtered = input.category.toLowerCase() !== "all";
    // A named category neither org has: say so instead of "No differences found" (final review I2).
    const unknown = diff.unknownCategory === true;
    const byQname = (xs: string[]) => [...xs].sort(analyze.codePointCompare);
    const md = [
      "| metric | count |",
      "|---|---|",
      `| only in A | ${diff.onlyInA.length} |`,
      `| only in B | ${diff.onlyInB.length} |`,
      `| changed | ${diff.changed.length} |`,
      "",
      // An MCP client sees only this text, so every list is here by full qname.
      ...listSection(
        `Only in A (\`${input.org_a}\`)`,
        "only in A",
        byQname(diff.onlyInA.map((n) => n.qualifiedName)),
        filtered,
      ),
      ...listSection(
        `Only in B (\`${input.org_b}\`)`,
        "only in B",
        byQname(diff.onlyInB.map((n) => n.qualifiedName)),
        filtered,
      ),
      ...listSection(
        "Changed",
        "changed",
        byQname(diff.changed.map((c) => c.a.qualifiedName)),
        filtered,
        "in both with different source",
      ),
      "```mermaid",
      mermaid,
      "```",
    ].join("\n");
    const truncationNote = diff.truncated
      ? ` — results capped at ${analyze.CROSS_ORG_PER_LABEL_CAP}/label; narrow with category filter`
      : "";
    const a = code(input.org_a);
    const b = code(input.org_b);
    const onlyA = diff.onlyInA.map((n) => n.qualifiedName);
    const onlyB = diff.onlyInB.map((n) => n.qualifiedName);
    const changed = diff.changed.map((c) => c.a.qualifiedName);
    const total = onlyA.length + onlyB.length + changed.length;
    const kinds = (qs: string[]) => kindCounts(qs.map(labelOfQname), 3);
    const sides = [
      ...(onlyA.length ? [`${countNoun(onlyA.length, "is", "are")} only in ${a}`] : []),
      ...(onlyB.length ? [`${countNoun(onlyB.length, "is", "are")} only in ${b}`] : []),
      ...(changed.length
        ? [`${countNoun(changed.length, "is", "are")} in both with different source`]
        : []),
    ];
    const byKind = [
      ...(onlyA.length ? [`only in ${a}, ${kinds(onlyA)}`] : []),
      ...(onlyB.length ? [`only in ${b}, ${kinds(onlyB)}`] : []),
      ...(changed.length ? [`in both, ${kinds(changed)}`] : []),
    ];
    const scope = filtered
      ? `Compared: the ${code(input.category)} category only.`
      : "Compared: every category.";
    const markdown = renderReport({
      title: `How ${a} and ${b} differ`,
      inShort: [
        unknown
          ? `Neither org has any ${code(input.category)}; check the name with \`find_nodes\`.`
          : total > 0
            ? `${a} and ${b} differ in ${countNoun(total, "piece")}: ${andList(sides)}.`
            : hiddenTotal > 0
              ? `No differences are shown between ${a} and ${b}: the only ${one ? "difference is" : "differences are"} ${andList(hiddenParts)} found in one org only, hidden by default, though ${one ? "it counts" : "they count"} if the question is what exists in one org but not the other; call again with ${hiddenFlags.join(" or ")} to see ${one ? "it" : "them"}.`
              : `No differences found between ${a} and ${b}: no piece is only in one of them, and none has different source.`,
        ...(total > 0 ? [`By kind: ${byKind.join("; ")}.`] : []),
        scope,
        ...(hiddenNote && total > 0 ? [hiddenNote] : []),
        ...(diff.truncated
          ? [
              "At least one kind hit the row limit, so the comparison is incomplete; narrow it with `category`.",
            ]
          : []),
      ],
      details: diff.truncated
        ? `${md}\n\n> _Note: at least one label hit the ${analyze.CROSS_ORG_PER_LABEL_CAP}-row cap. Diff is incomplete — pass a narrower \`category\` to investigate._`
        : md,
      next: [
        ...(filtered ? [] : ["Narrow with `category`."]),
        ...(total > 0
          ? ["Run `deployment_manifest_gen` to build the deployment files for these differences."]
          : []),
      ],
    });
    return {
      summary: unknown
        ? `neither org has category ${input.category}`
        : `A-only:${diff.onlyInA.length} B-only:${diff.onlyInB.length} changed:${diff.changed.length}${hiddenTotal > 0 ? ` hidden:${hiddenTotal}` : ""}${truncationNote}`,
      markdown,
      data: {
        onlyInA: diff.onlyInA.map((n) => n.qualifiedName),
        onlyInB: diff.onlyInB.map((n) => n.qualifiedName),
        changed: diff.changed.map((c) => c.a.qualifiedName),
        truncated: diff.truncated ?? false,
        hidden,
        ...(unknown ? { unknownCategory: true } : {}),
      },
      follow_up_tools: ["point_in_time_diff", "deployment_manifest_gen"],
    };
  },
});
