import type { analyze } from "@ryanstark24/sfgraph-core";
import { labelOfQname, unitOf } from "./_reach_list.js";
import {
  NOTES,
  andList,
  code,
  kindCounts,
  linkFacts,
  linkLines,
  nameOf,
  pieceCount,
  pieceRole,
  renderReport,
  reportDiagram,
  testSplit,
} from "./_report.js";

/**
 * Cycle 3 T3: the human reports of wip_diff, wip_impact and wip_test_gap. Components only: a method
 * is described as its class.
 */
type Result = Awaited<ReturnType<typeof analyze.analyzeLocalImpact>>;

const unitQ = (q: string): string =>
  unitOf({ qualifiedName: q, label: labelOfQname(q) }).qualifiedName;
const units = (qs: readonly string[]): string[] => [...new Set(qs.map(unitQ))];
const names = (qs: readonly string[]): string => {
  const shown = qs.slice(0, 3).map((q) => code(nameOf(q)));
  return qs.length > 3 ? `${shown.join(", ")} and ${qs.length - 3} more` : andList(shown);
};
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const steps = (n: number): string => `${n} ${n === 1 ? "step" : "steps"}`;

/** "adds 1 Apex class (server code) and changes 2 fields", over the three local sets. */
function changePhrase(r: Pick<Result, "addedQnames" | "changedQnames" | "removedQnames">): string {
  const parts: string[] = [];
  const add = units(r.addedQnames);
  const chg = units(r.changedQnames).filter((q) => !add.includes(q));
  const rem = units(r.removedQnames);
  if (add.length) parts.push(`adds ${kindCounts(add.map(labelOfQname))}`);
  if (chg.length) parts.push(`changes ${kindCounts(chg.map(labelOfQname))}`);
  if (rem.length) parts.push(`removes ${kindCounts(rem.map(labelOfQname))}`);
  return andList(parts);
}

function seedPieces(r: Pick<Result, "addedQnames" | "changedQnames" | "removedQnames">) {
  const add = units(r.addedQnames);
  const chg = units(r.changedQnames).filter((q) => !add.includes(q));
  const rem = units(r.removedQnames);
  return [
    ...add.map((q) => ({ q, said: "New in your local source." })),
    ...chg.map((q) => ({ q, said: "Changed in your local source." })),
    ...rem.map((q) => ({ q, said: "Removed from your local source." })),
  ];
}

export function wipDiffReport(r: Result, mode: string, details: string): string {
  const any = r.addedQnames.length + r.changedQnames.length + r.removedQnames.length > 0;
  const inShort = [
    any
      ? `Compared with the org, your local source ${changePhrase(r)}.`
      : "Your local source matches the org's graph: nothing was added, changed or removed.",
  ];
  if (mode === "changed-only")
    inShort.push("Only files changed locally were compared, so removed pieces are not looked for.");
  return renderReport({
    title: "How your local source differs from the org",
    inShort,
    pieces: seedPieces(r).map(({ q, said }) => ({ name: q, kind: labelOfQname(q), role: said })),
    details,
    next: [
      "Run `wip_impact` to see what relies on these changes.",
      "Run `wip_test_gap` to find changes no tests cover.",
      ...(mode === "changed-only"
        ? ['Set `mode: "full-folder"` to compare every file and also find removed pieces.']
        : []),
    ],
  });
}

export function wipImpactDetails(r: Result): string {
  const list = (head: string, qs: readonly string[]) =>
    qs.length ? ["", `### ${head} (${qs.length})`, ...qs.map((q) => `- ${q}`)] : [];
  const lines = [
    `Changed: ${r.changedQnames.length}, Added: ${r.addedQnames.length}, Removed: ${r.removedQnames.length}, Dependents: ${r.dependents.length}`,
    ...list("Changed", r.changedQnames),
    ...list("Added", r.addedQnames),
    ...list("Removed", r.removedQnames),
  ];
  if (r.dependents.length)
    lines.push(
      "",
      `### Dependents (${r.dependents.length})`,
      ...r.dependents.map(
        (d) =>
          `- ${d.qname} (${d.label}, depth=${d.depth}${d.viaRelType ? `, via=${d.viaRelType}` : ""}, ${d.coveredByTest ? "covered by a test" : "no test"})`,
      ),
    );
  const links = r.graph.edges.map((e) => ({
    from: e.srcQualifiedName,
    to: e.dstQualifiedName,
    rel: e.relType,
  }));
  const shown = linkLines(links);
  if (shown.length) lines.push("", `### Links (${shown.length})`, ...shown);
  if (r.truncated) lines.push("", "_truncated_ — removed-member detection hit its per-label cap.");
  return lines.join("\n");
}

const ROLE_OF_VERDICT = {
  gap: "No test covers it.",
  covered: "A test covers it.",
  test: "A test class.",
  na: "Apex tests do not apply.",
} as const;

export function wipImpactReport(r: Result, depth: number, mermaid: boolean): string {
  const seeds = seedPieces(r);
  const seedSet = new Set(seeds.map((s) => s.q));
  const depUnits = new Map<string, { covered: boolean; depth: number }>();
  for (const d of r.dependents) {
    const u = unitQ(d.qname);
    if (seedSet.has(u)) continue;
    const had = depUnits.get(u);
    depUnits.set(u, {
      covered: (had?.covered ?? false) || d.coveredByTest,
      depth: Math.min(had?.depth ?? d.depth, d.depth),
    });
  }
  const deps = [...depUnits].sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));
  const labelOf = new Map(r.graph.nodes.map((n) => [n.qualifiedName, n.label]));
  const lab = (q: string) => labelOf.get(q) ?? labelOfQname(q);
  const kindOfUnit = (u: string) => (u.startsWith("ApexClass:") ? "ApexClass" : lab(u));
  const edges = r.graph.edges
    .map((e) => ({
      from: unitQ(e.srcQualifiedName),
      to: unitQ(e.dstQualifiedName),
      rel: e.relType ?? "",
    }))
    .filter((e) => e.from !== e.to);
  const all = [...seeds.map((s) => s.q), ...deps.map(([u]) => u)];
  const facts = linkFacts(edges, new Set(all));
  const any = seeds.length > 0;
  // Each dependent as core's coverage classifier sees it: only an Apex class or trigger that is
  // not a test can lack a test.
  const g = r.testGaps;
  const verdict = new Map<string, "gap" | "covered" | "test" | "na">();
  for (const d of g?.uncovered ?? []) verdict.set(d.qname.toLowerCase(), "gap");
  for (const q of g?.covered ?? []) verdict.set(q.toLowerCase(), "covered");
  for (const q of g?.tests ?? []) verdict.set(q.toLowerCase(), "test");
  for (const q of g?.notApplicable ?? []) verdict.set(q.toLowerCase(), "na");
  const verdictOf = (u: string, covered: boolean) =>
    verdict.get(u.toLowerCase()) ??
    (["ApexClass", "ApexTrigger"].includes(kindOfUnit(u)) ? (covered ? "covered" : "gap") : "na");
  const byVerdict = (v: string) => deps.filter(([u, d]) => verdictOf(u, d.covered) === v);
  const split = testSplit({
    noTest: byVerdict("gap").map(([u]) => kindOfUnit(u)),
    covered: byVerdict("covered").length,
    tests: byVerdict("test").length,
    notApplicable: byVerdict("na").map(([u]) => kindOfUnit(u)),
  });
  const inShort = [
    any
      ? `Your local source ${changePhrase(r)}.`
      : "Your local source matches the org's graph, so nothing is affected.",
  ];
  if (any)
    inShort.push(
      deps.length
        ? `${cap(pieceCount(deps.length))} that rely on ${seeds.length === 1 ? "it" : "them"} could be affected, up to ${steps(depth)} away: ${kindCounts(deps.map(([u]) => kindOfUnit(u)))}.`
        : `Nothing in the org relies on ${seeds.length === 1 ? "it" : "them"} within ${steps(depth)}.`,
    );
  if (any && deps.length && split) inShort.push(`Of these, ${split}.`);
  const roleOf = (u: string, said: string) => {
    const f = facts(u);
    const has = f.callers.length + f.usedBy.length + f.callees.length + f.does.length > 0;
    return `${has ? `${pieceRole({ kind: kindOfUnit(u), ...f })} ` : ""}${said}`;
  };
  return renderReport({
    title: "What your local changes could affect",
    inShort,
    diagram: mermaid
      ? reportDiagram(
          all.map((q) => ({ id: q, label: kindOfUnit(q) })),
          edges,
        )
      : undefined,
    pieces: [
      ...seeds.map(({ q, said }) => ({ name: q, kind: kindOfUnit(q), role: roleOf(q, said) })),
      ...deps.map(([u, v]) => ({
        name: u,
        kind: kindOfUnit(u),
        role: roleOf(u, ROLE_OF_VERDICT[verdictOf(u, v.covered)]),
      })),
    ],
    details: wipImpactDetails(r),
    next: [
      "Run `wip_test_gap` to list the changed or affected Apex code no tests cover.",
      `Raise or lower \`depth\` (now ${depth}) to look further from or closer to the changes.`,
      "Run `deployment_manifest_gen` to build a deployment list for the changes.",
      ...(r.removedQnames.length
        ? ["A removed piece's dependents are the references its removal breaks."]
        : []),
    ],
  });
}

/** The test-gap report shared by wip_test_gap and test_gap_intelligence_from_git_diff. */
export function gapReport(o: {
  title: string;
  /** "in or affected by your local changes" */
  scope: string;
  /** Where nothing was found, when no Apex class or trigger was checked: "in or affected by the change". */
  found: string;
  gaps: { qname: string; label: string; role: string }[];
  /** How many of the gaps are themselves changed (counted in the first sentence). */
  changedGaps?: number;
  covered: readonly string[];
  tests: readonly string[];
  notApplicable: readonly string[];
  notChecked?: string[];
  details: string;
  next: string[];
}): string {
  const un = o.gaps;
  const inShort = [
    un.length
      ? `${cap(kindCounts(un.map((d) => d.label)))} ${o.scope} ${un.length === 1 ? "has" : "have"} no test: ${names(un.map((d) => d.qname))}${
          o.changedGaps
            ? ` (${o.changedGaps === un.length ? (un.length === 1 ? "it is" : "all are") : `${o.changedGaps} of them ${o.changedGaps === 1 ? "is" : "are"}`} changed directly)`
            : ""
        }.`
      : o.covered.length
        ? `Every Apex class and trigger ${o.scope} has a test.`
        : `No Apex classes or triggers were found ${o.found}, so there was nothing to check for tests.`,
  ];
  const also: string[] = [];
  if (o.covered.length)
    also.push(`${o.covered.length} other ${o.covered.length === 1 ? "is" : "are"} covered`);
  if (o.tests.length)
    also.push(
      `${o.tests.length} test ${o.tests.length === 1 ? "class was" : "classes were"} skipped`,
    );
  if (o.notApplicable.length)
    also.push(
      `${pieceCount(o.notApplicable.length)} (screens, flows and the like) cannot carry Apex test coverage`,
    );
  if (also.length) inShort.push(`${cap(andList(also))}.`);
  if (o.notChecked?.length) inShort.push(`Not checked: ${andList(o.notChecked)}.`);
  if (un.some((d) => d.label === "ApexTrigger"))
    inShort.push(
      "Triggers always show as not covered, because tests that reach a trigger by saving records are not tracked.",
    );
  const list = (head: string, qs: readonly string[]) =>
    qs.length ? ["", `### ${head} (${qs.length})`, ...qs.map((q) => `- ${q}`)] : [];
  const details = [
    o.details,
    ...list("Covered", o.covered),
    ...list("Test classes (skipped)", o.tests),
    ...list("Not applicable (no Apex test coverage)", o.notApplicable),
  ].join("\n");
  return renderReport({
    title: o.title,
    inShort,
    pieces: un.map((d) => ({ name: d.qname, kind: d.label, role: d.role })),
    details,
    next: [
      ...(un.length ? ["Write or extend a test class for each piece listed, then run it."] : []),
      ...o.next,
      ...([...o.covered, ...o.notApplicable].some((q) => q.startsWith("ApexTrigger:")) ||
      un.some((d) => d.label === "ApexTrigger")
        ? [NOTES.triggerCoverage]
        : []),
    ],
  });
}

export function wipTestGapReport(r: Result, details: string): string {
  const g = r.testGaps ?? { uncovered: [], covered: [], tests: [], notApplicable: [] };
  return gapReport({
    title: "Which local changes no tests cover",
    scope: "in or affected by your local changes",
    found: "in or affected by your local changes",
    gaps: g.uncovered.map((d) => ({
      qname: d.qname,
      label: d.label,
      role: d.seed
        ? `${d.seed === "added" ? "New" : "Changed"} in your local source; no test covers it.`
        : `Relies on a local change, ${steps(d.depth)} away; no test covers it.`,
    })),
    covered: g.covered,
    tests: g.tests,
    notApplicable: g.notApplicable,
    details,
    next: [
      "Run `wip_impact` to see everything the changes could affect.",
      "Raise `depth` to check pieces further from the changes.",
    ],
  });
}
