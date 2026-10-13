import { analyze } from "@ryanstark24/sfgraph-core";
import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, numeric, z } from "./_define.js";
import { findNodesSuggestion } from "./_not-found.js";
import { isMethodRow, labelOfQname, owningClass, unitOf } from "./_reach_list.js";
import {
  andList,
  code,
  kindCounts,
  linkFacts,
  listWithMore,
  methodCountNote,
  nameOf,
  pieceCount,
  pieceRole,
  renderReport,
  reportDiagram,
} from "./_report.js";

const inputSchema = z.object({
  org: z.string().min(1),
  diff: z.string().min(1),
  depth: numeric(z.number().int().min(1).max(5).default(3)),
  /** Show the Picture (a diagram of at most 25 components); false hides it. */
  mermaid: z.boolean().default(true),
});

/** Impacted nodes listed in markdown; the rest are counted. */
const MD_LIST_MAX = 100;

defineTool({
  name: "impact_from_git_diff",
  description:
    "Use for 'what does this PR break'. Maps a git `diff` to components and their dependents, `depth` hops back.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const files = analyze.parseUnifiedDiff(input.diff);
    // T15 I-4: member-level seeds where the hunks identify the ApexMethod,
    // every parsed type (file grammar, else the graph's member index), both
    // sides of a rename; binary / mode-only / unmapped paths are reported.
    const resolved = analyze.resolveDiffSeeds(ctx.graphStore, ctx.orgId, files, input.diff);
    const seedQnames = resolved.seeds.map((s) => s.qname);
    const memberSeeds = resolved.seeds.filter((s) => s.level === "member").map((s) => s.qname);
    const components = [...new Set(resolved.seeds.map((s) => s.component))];
    const seeds = new Set([...seedQnames, ...components]);
    const seedNodes = new Map<string, { qualifiedName: string; label: string }>();
    for (const c of components) {
      const node = ctx.graphStore.getNode(ctx.orgId, asQualifiedName(c));
      seedNodes.set(c, { qualifiedName: c, label: node?.label ?? "Changed" });
    }
    const dependents = new Map<string, { qualifiedName: string; label: string }>();
    const dependencies = new Set<string>();
    const edges: Array<{ srcQualifiedName: string; dstQualifiedName: string; relType?: string }> =
      [];
    const notFound: string[] = [];
    let truncated = false;
    // The nearest step at which each dependent was reached, for the report's order.
    const hopOf = new Map<string, number>();
    // Per reached dependent: did it depend on the change through any edge
    // other than containment (M-5)?
    const dependsBy = new Map<string, { structural: boolean; other: boolean }>();
    for (const qn of seedQnames) {
      const qname = asQualifiedName(qn);
      // Upstream = who depends on the change = the blast radius.
      // Component-level hops (as wip_impact): a reached method's class counts
      // as reached, so callers of its sibling methods are the next hop.
      const up = analyze.findDependents(ctx.graphStore, ctx.orgId, qname, input.depth, {
        componentHops: true,
      });
      // tools-11: a changed file the graph has never seen (new or not ingested).
      if (up.found === false) notFound.push(qn);
      if (up.truncated) truncated = true;
      for (const row of up.reached ?? []) {
        const q = String(row.qualifiedName);
        hopOf.set(q, Math.min(hopOf.get(q) ?? row.hop, row.hop));
      }
      for (const n of up.nodes) {
        if (seeds.has(n.qualifiedName)) continue;
        dependents.set(n.qualifiedName, { qualifiedName: n.qualifiedName, label: n.label });
      }
      for (const e of up.edges) {
        const k = dependsBy.get(e.srcQualifiedName) ?? { structural: false, other: false };
        if (analyze.isUpstreamStructuralEdge(e)) k.structural = true;
        else k.other = true;
        dependsBy.set(e.srcQualifiedName, k);
      }
      for (const e of up.rowEdges ?? up.edges) {
        edges.push({
          srcQualifiedName: e.srcQualifiedName,
          dstQualifiedName: e.dstQualifiedName,
          relType: e.relType,
        });
      }
      // Downstream (what the change uses, incl. its own members): context only.
      const down = analyze.findDependencies(ctx.graphStore, ctx.orgId, qname, 1);
      for (const n of down.nodes) {
        if (!seeds.has(n.qualifiedName) && !dependents.has(n.qualifiedName)) {
          dependencies.add(n.qualifiedName);
        }
      }
    }
    // An unchanged containment parent (the object of a changed field) is not
    // impacted by its member changing: drop a dependent reached only through
    // containment edges, unless it also depends on the change otherwise.
    const parentsOnly = new Set<string>();
    for (const [q, k] of dependsBy) {
      if (k.structural && !k.other && dependents.delete(q)) parentsOnly.add(q);
    }
    if (parentsOnly.size) {
      const kept = edges.filter(
        (e) => !parentsOnly.has(e.srcQualifiedName) && !parentsOnly.has(e.dstQualifiedName),
      );
      edges.splice(0, edges.length, ...kept);
    }
    const dependentList = Array.from(dependents.values()).sort((a, b) =>
      a.qualifiedName.localeCompare(b.qualifiedName),
    );
    // `impacted` = the changed nodes themselves plus their upstream dependents.
    const impactedList = [...seedNodes.values(), ...dependentList];
    const mdLines = [
      `Seed: ${files.length} files -> ${seedNodes.size} changed components${
        memberSeeds.length
          ? ` (${memberSeeds.length} changed methods: ${listWithMore(
              memberSeeds.map((q) => `\`${q}\``),
              10,
            )})`
          : ""
      }. Total impacted: ${impactedList.length} (${seedNodes.size} changed + ${dependentList.length} upstream dependents).`,
      "",
    ];
    if (impactedList.length === 0) {
      mdLines.push("_no changed file maps to a graph node_");
    } else {
      // Changed first, then dependents by label (TestMethod last); a method
      // row names its class.
      const row = (n: { qualifiedName: string; label: string }): string =>
        `- \`${n.qualifiedName}\` (${n.label}${isMethodRow(n) ? `, in ${owningClass(n.qualifiedName)}` : ""})${seeds.has(n.qualifiedName) ? " — changed" : ""}`;
      const byLabel = new Map<string, Array<{ qualifiedName: string; label: string }>>();
      for (const n of dependentList) {
        const g = byLabel.get(n.label);
        if (g) g.push(n);
        else byLabel.set(n.label, [n]);
      }
      const labelOrder = [...byLabel.keys()].sort(
        (a, b) => Number(a === "TestMethod") - Number(b === "TestMethod") || a.localeCompare(b),
      );
      const sections: Array<{
        head: string;
        items: Array<{ qualifiedName: string; label: string }>;
      }> = [
        { head: "Changed", items: [...seedNodes.values()] },
        ...labelOrder.map((l) => ({ head: `Dependents: ${l}`, items: byLabel.get(l) ?? [] })),
      ];
      let budget = MD_LIST_MAX;
      let first = true;
      for (const sec of sections) {
        if (sec.items.length === 0 || budget <= 0) continue;
        if (!first) mdLines.push("");
        first = false;
        mdLines.push(
          `### ${sec.head} (${sec.items.length})`,
          ...sec.items.slice(0, budget).map(row),
        );
        budget -= Math.min(budget, sec.items.length);
      }
      if (impactedList.length > MD_LIST_MAX) {
        mdLines.push(
          `- _+${impactedList.length - MD_LIST_MAX} more (narrow the call: a lower \`depth\` or a smaller \`diff\`)_`,
        );
      }
      const listedLower = new Set(impactedList.map((n) => n.qualifiedName.toLowerCase()));
      const owners = new Map<string, string>();
      for (const n of dependentList) {
        if (!isMethodRow(n)) continue;
        const c = owningClass(n.qualifiedName);
        if (!listedLower.has(c.toLowerCase())) owners.set(c.toLowerCase(), c);
      }
      if (owners.size > 0) {
        const sorted = [...owners.values()].sort((a, b) => a.localeCompare(b));
        mdLines.push(
          "",
          `### Classes of the listed methods (${sorted.length} not listed above)`,
          ...sorted.map((q) => `- \`${q}\``),
        );
      }
    }
    if (notFound.length > 0) {
      mdLines.push(
        "",
        `_${notFound.length} changed file${notFound.length === 1 ? " maps" : "s map"} to a qname not in the graph_ (new, or not ingested yet): ${listWithMore(
          notFound.map((q) => `\`${q}\``),
          10,
        )}. Their impact is unknown. ${findNodesSuggestion(notFound)}`,
      );
    }
    if (resolved.unmapped.length > 0) {
      mdLines.push(
        "",
        `_${resolved.unmapped.length} changed path${resolved.unmapped.length === 1 ? "" : "s"} not mapped to a graph node_ (impact unknown): ${resolved.unmapped
          .slice(0, 10)
          .map((u) => `\`${u.path}\` (${u.reason})`)
          .join(
            ", ",
          )}${resolved.unmapped.length > 10 ? `, +${resolved.unmapped.length - 10} more (narrow the call: a smaller \`diff\`)` : ""}`,
      );
    }
    if (truncated) {
      mdLines.push(
        "",
        "_truncated_ — one or more seeds hit the traversal node cap. Lower `depth` or split the diff.",
      );
    }
    // The report: a method is drawn and described as its class (one component each).
    const labelOf = new Map(impactedList.map((n) => [n.qualifiedName, n.label]));
    const unitQ = (q: string): string =>
      unitOf({
        qualifiedName: q,
        label: labelOf.get(q) ?? (q.startsWith("ApexMethod:") ? "ApexMethod" : ""),
      }).qualifiedName;
    const units = new Map<string, { qualifiedName: string; label: string; changed: boolean }>();
    for (const n of impactedList) {
      // A changed file with no node is labelled "Changed" in the list; the report names its kind.
      const u = unitOf(n.label === "Changed" ? { ...n, label: labelOfQname(n.qualifiedName) } : n);
      const changed = seeds.has(n.qualifiedName) || (units.get(u.qualifiedName)?.changed ?? false);
      units.set(u.qualifiedName, { ...u, changed });
    }
    const unitEdges = edges
      .map((e) => ({
        from: unitQ(e.srcQualifiedName),
        to: unitQ(e.dstQualifiedName),
        rel: e.relType ?? "",
      }))
      .filter((e) => e.from !== e.to);
    const changedUnits = [...units.values()].filter((u) => u.changed);
    // A unit's step is its nearest row's (a method counts for its class).
    const unitHop = new Map<string, number>();
    for (const [q, h] of hopOf) {
      const u = unitQ(q);
      unitHop.set(u, Math.min(unitHop.get(u) ?? h, h));
    }
    // Pieces: the changed ones first (a deliberate grouping), then by step, then by name.
    const affected = [...units.values()]
      .filter((u) => !u.changed)
      .sort(
        (a, b) =>
          (unitHop.get(a.qualifiedName) ?? 0) - (unitHop.get(b.qualifiedName) ?? 0) ||
          a.qualifiedName.localeCompare(b.qualifiedName),
      );
    const facts = linkFacts(unitEdges, new Set(units.keys()));
    const inShort: string[] = [];
    const missing = new Set(notFound);
    const known = changedUnits.filter((u) => !missing.has(u.qualifiedName));
    if (changedUnits.length === 0) {
      inShort.push(
        `None of the ${files.length} changed ${files.length === 1 ? "file matches" : "files match"} a component in this org's graph, so the effect of the change is unknown.`,
      );
    } else if (known.length === 0) {
      inShort.push(
        `The change touches ${andList(changedUnits.slice(0, 3).map((u) => code(nameOf(u.qualifiedName))))}${changedUnits.length > 3 ? ` and ${changedUnits.length - 3} more` : ""}, which ${changedUnits.length === 1 ? "is" : "are"} not in this org's graph yet (new, or not loaded), so the effect is unknown.`,
      );
    } else {
      inShort.push(
        `The change touches ${kindCounts(changedUnits.map((u) => u.label))}: ${andList(changedUnits.slice(0, 3).map((u) => code(nameOf(u.qualifiedName))))}${changedUnits.length > 3 ? ` and ${changedUnits.length - 3} more` : ""}.`,
        affected.length
          ? `${pieceCount(affected.length).replace(/^./, (c) => c.toUpperCase())} that rely on it could be affected, up to ${input.depth} ${input.depth === 1 ? "step" : "steps"} away: ${kindCounts(affected.map((u) => u.label))}.`
          : `Nothing else relies on it within ${input.depth} ${input.depth === 1 ? "step" : "steps"}.`,
      );
    }
    const unknown: string[] = [];
    if (notFound.length && known.length)
      unknown.push(
        `${notFound.length} changed ${notFound.length === 1 ? "file is" : "files are"} new or not loaded yet`,
      );
    if (resolved.unmapped.length)
      unknown.push(
        `${resolved.unmapped.length} changed ${resolved.unmapped.length === 1 ? "path matches" : "paths match"} no component`,
      );
    if (unknown.length) inShort.push(`Not checked: ${andList(unknown)}.`);
    if (truncated)
      inShort.push("The search stopped at its size limit, so the list may be incomplete.");
    const next: string[] = [];
    if (truncated) next.push("Lower `depth` or split the `diff` to get the full list.");
    if (notFound.length)
      next.push(
        "Check the names of new or unloaded files with `find_nodes`, or sync the org again.",
      );
    next.push(
      "Run `test_gap_intelligence_from_git_diff` to see which affected pieces have no tests.",
    );
    if (affected.length)
      next.push("Run `trace_upstream` on one piece to see its full chain of users.");
    if (changedUnits.some((u) => u.label === "ApexClass"))
      next.push(
        "A changed Apex class counts only the methods its changed lines touch, when they can be found; otherwise the whole class.",
      );
    if (dependencies.size)
      next.push(
        "What the changed files themselves use is not counted as impact; run `trace_downstream` for that.",
      );
    if (parentsOnly.size)
      next.push(
        "An unchanged containing object of a changed or dependent member is not listed, unless it is reached through a non-containment edge.",
      );
    const report = renderReport({
      title: "What this change could affect",
      inShort,
      diagram: input.mermaid
        ? reportDiagram(
            [...changedUnits, ...affected].map((u) => ({ id: u.qualifiedName, label: u.label })),
            unitEdges,
          )
        : undefined,
      pieces: [...changedUnits, ...affected].map((u) => {
        const f = facts(u.qualifiedName);
        const any = f.callers.length + f.usedBy.length + f.callees.length + f.does.length > 0;
        const role = any ? pieceRole({ kind: u.label, ...f }) : "";
        const said = missing.has(u.qualifiedName)
          ? "Changed in this diff; not in this org's graph yet."
          : u.changed
            ? `${role ? `${role} ` : ""}Changed in this diff.`
            : role || pieceRole({ kind: u.label });
        return { name: u.qualifiedName, kind: u.label, role: said };
      }),
      details:
        impactedList.length !== units.size && impactedList.some((n) => isMethodRow(n))
          ? `${methodCountNote(impactedList.length)}\n\n${mdLines.join("\n")}`
          : mdLines.join("\n"),
      next,
    });
    return {
      summary: `${impactedList.length} nodes impacted from ${files.length} changed files${notFound.length ? `, ${notFound.length} not in graph` : ""}${resolved.unmapped.length ? `, ${resolved.unmapped.length} unmapped` : ""}${truncated ? " (truncated)" : ""}`,
      markdown: report,
      data: {
        seedQnames,
        changed: components,
        changedMembers: memberSeeds,
        unmapped: resolved.unmapped,
        impacted: impactedList.map((n) => n.qualifiedName),
        dependents: dependentList.map((n) => n.qualifiedName),
        dependencies: Array.from(dependencies).sort(),
        notFound,
        truncated,
      },
      follow_up_tools: [
        "test_gap_intelligence_from_git_diff",
        "trace_downstream",
        "deployment_manifest_gen",
      ],
    };
  },
});
