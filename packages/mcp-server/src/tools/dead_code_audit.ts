import { analyze } from "@ryanstark24/sfgraph-core";
import { getToolContext } from "../context.js";
import { cacheFreshness, isDeadCodeCacheRow } from "./_analysis-cache.js";
import { defineTool, numeric, z } from "./_define.js";
import {
  type Piece,
  andList,
  code,
  countNoun,
  kindCounts,
  kindInText,
  renderReport,
} from "./_report.js";

/** Pattern length cap: generous for any real name prefix / glob. */
const MAX_PATTERN_LENGTH = 256;

const inputSchema = z.object({
  org: z.string().min(1),
  /** Max rows to render inline. The full set can be thousands on a large org
   *  (6k+ on a large Vlocity repo), which blows the MCP token budget. Default 50; the summary
   *  (counts by confidence + label) always covers 100%. Use export_sarif for
   *  the complete machine-readable set. */
  limit: numeric(z.number().int().min(1).max(500).default(50)),
  /** Only show this confidence bucket (high|medium|low). */
  confidence: z.enum(["high", "medium", "low"]).optional(),
  /** Only this node label, e.g. `ApexClass`, `Flow`, `DataRaptor` (case-insensitive). */
  label: z.string().min(1).optional(),
  /** Name prefix (`Acme_`) or glob (`*Handler`, `Acme_??`) matched case-insensitively
   *  against the name part of the qname (after `Label:`) or the full qname. */
  pattern: z.string().min(1).max(MAX_PATTERN_LENGTH).optional(),
});

function filterNote(input: {
  confidence?: string | undefined;
  label?: string | undefined;
  pattern?: string | undefined;
}): string {
  const parts = [
    input.confidence ? `confidence=${input.confidence}` : "",
    input.label ? `label=${input.label}` : "",
    input.pattern ? `pattern=${input.pattern}` : "",
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

const makeFilter = analyze.makeScanFilter;

const TITLE = "Code with no captured incoming references";
const NOT_USES =
  "Permission grants, a component's own files and guesses from code that names things at run time do not count as references.";
/** What a missing reference does not prove: shown wherever pieces are listed. */
const OUTSIDE_GRAPH =
  "Callers outside the graph (integrations, the UI, schedules) are not captured, so no captured references is not proof that nothing uses a piece.";

/** The kinds the score covers, in plain words: "Apex classes, Lightning web components, ...". */
const SCORED_PLAIN = andList(
  [...new Set(analyze.DEAD_CODE_LABELS.map((l) => kindInText(l, { plural: true })))].map((k) =>
    k.replace(/ \(.*\)$/, ""),
  ),
);

/** What was looked at, in plain words: "flows named like `Acme_*`, high confidence only". */
function scopeText(input: {
  confidence?: string | undefined;
  label?: string | undefined;
  pattern?: string | undefined;
}): string {
  const kinds = input.label ? kindInText(input.label, { plural: true }) : SCORED_PLAIN;
  return [
    kinds,
    ...(input.pattern ? [`named like ${code(input.pattern)}`] : []),
    ...(input.confidence ? [`${input.confidence} confidence only`] : []),
  ].join(", ");
}

/** "Separately, 2 pieces are used only by tests: ..." (empty when there are none). */
const testOnlySentence = (n: number): string[] =>
  n === 0
    ? []
    : [
        `Separately, ${countNoun(n, "piece")} ${n === 1 ? "is" : "are"} used only by tests: not unused, but deleting ${n === 1 ? "it" : "them"} means deleting those tests too.`,
      ];

/** Each reason a candidate was scored, in plain words. */
const REASON_PLAIN: Readonly<Record<string, string>> = {
  no_incoming_edges: "no captured incoming references",
  external_entry_point: "known external entry point",
  referenced_only_by_tests: "only tests refer to it",
  test_class: "it is a test class",
  stale_freshness: "last changed more than 180 days ago",
};
const reasonText = (reasons: readonly string[]): string =>
  andList(
    reasons
      // The entry-point kinds are listed under their own heading; the one reason is enough here.
      .filter((r) => !r.startsWith(analyze.ENTRY_POINT_REASON_PREFIX))
      .map((r) => REASON_PLAIN[r] ?? r.replace(/_/g, " ")),
  );
/** "a REST endpoint (an @Http method) and a Schedulable class (run by a schedule)". */
const entryPointText = (reasons: readonly string[]): string =>
  andList(
    analyze
      .entryPointsFromReasons(reasons)
      .map((k) => analyze.ENTRY_POINT_PLAIN[k] ?? k.replace(/_/g, " ")),
  );
const isEntryPointRow = (d: { reasons: readonly string[] }): boolean =>
  d.reasons.includes(analyze.EXTERNAL_ENTRY_POINT_REASON);

const NEXT = [
  "Run `trace_upstream` on a piece to see the references the graph does have. It cannot show callers outside the graph (integrations, the UI, schedules): check those before deleting.",
  "Narrow with `label`, `pattern` or `confidence`.",
];
/** NEXT, plus the notes that apply to the listed pieces. */
const nextFor = (listed: readonly { qualifiedName: string; isTest: boolean }[]): string[] => [
  ...NEXT,
  ...(listed.some((d) => d.isTest)
    ? ["References from tests count, so an unused test class is listed."]
    : []),
  ...(listed.some((d) => d.qualifiedName.startsWith("ApexClass:"))
    ? ["A Custom Metadata record naming exactly one Apex class counts as a use of it."]
    : []),
];

const NARROW_HINT = "narrow with `label`, `pattern` or `confidence`, or raise `limit`";

interface CachedDead {
  qualifiedName: string;
  score: number;
  confidence: string;
  reasons: string[];
}

/** Rows of the score cache / live scan are one of two kinds, by reason:
 *  `referenced_only_by_tests` rows are production code only tests use (not
 *  dead, listed apart); every other kept row is dead (no inbound at all). */
const isTestOnlyRow = (d: { reasons: readonly string[] }): boolean =>
  d.reasons.includes("referenced_only_by_tests");

/** A dead row of an unreferenced `@isTest` class (scoreDeadCode `test_class`). */
const isTestRow = (d: { reasons: readonly string[] }): boolean => d.reasons.includes("test_class");

function labelOf(qname: string): string {
  const i = qname.indexOf(":");
  return i > 0 ? qname.slice(0, i) : "(unlabeled)";
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function fmtCounts(counts: Record<string, number>): string {
  return (
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "none"
  );
}

/**
 * Cached scores, via core's version-stamped reader: unstamped or older-version
 * rows (written before the scorer fixes) read as null and are never served.
 * Like the other analysis caches, the table is trusted only when fresh
 * (computed after the last sync; review M1).
 */
function readCachedDeadCode(
  ctx: Awaited<ReturnType<typeof getToolContext>>,
): { rows: CachedDead[]; coverage: analyze.ScanCoverage } | null {
  if (!ctx.db || cacheFreshness(ctx, "_sfgraph_dead_code_scores").state !== "fresh") return null;
  let rows: ReturnType<typeof analyze.readDeadCodeScores>;
  let coverage: analyze.ScanCoverage | null;
  try {
    rows = analyze.readDeadCodeScores(ctx.db as never, ctx.orgId);
    coverage = analyze.readScanCoverage(ctx.db as never, ctx.orgId, "dead_code");
  } catch {
    return null;
  }
  // No recorded coverage: the cache cannot say how much it looked at; scan live.
  if (!rows || !coverage) return null;
  // The scorer persists candidates only, each tagged `no_incoming_edges` or
  // `referenced_only_by_tests`; drop any other row so a stray one cannot list
  // used code as dead.
  const kept = rows
    .filter((r) => isDeadCodeCacheRow(r.reasons))
    .map((r) => ({
      qualifiedName: r.qualifiedName,
      score: r.score,
      confidence: r.confidence,
      reasons: r.reasons,
    }));
  // Nothing usable: fall back to the live scan rather than "no dead code".
  return kept.length > 0 ? { rows: kept, coverage } : null;
}

/** "only the first is listed below" / "the first N are listed below". */
const firstListed = (n: number): string =>
  n === 1 ? "only the first is listed below" : `the first ${n} are listed below`;

/** Labels the score cache / findDeadCode cover: core `DEAD_CODE_LABELS`. */
const SCORED_LABELS = new Set(analyze.DEAD_CODE_LABELS.map((l) => l.toLowerCase()));

/** Resolve a case-insensitive label to the stored label (falls back to input). */
function canonicalLabel(store: { listAllLabels(): string[] }, label: string): string {
  const want = label.toLowerCase();
  return store.listAllLabels().find((l) => l.toLowerCase() === want) ?? label;
}

/**
 * Label outside the scored set: list nodes with no inbound reference live,
 * by the scored labels' rule (core `deadCodeKind`: grants and reflection
 * guesses excluded, test references count; an unambiguous Custom Metadata
 * record naming an Apex class still counts as a use). Nodes only tests
 * reference go to `referencedOnlyByTests`.
 */
function liveZeroInbound(
  ctx: Awaited<ReturnType<typeof getToolContext>>,
  rawLabel: string,
  input: { limit: number; pattern?: string | undefined; confidence?: string | undefined },
) {
  const label = canonicalLabel(ctx.graphStore, rawLabel);
  const labelExists = ctx.graphStore.countNodesByLabel(ctx.orgId, label) > 0;
  // The pattern goes into the store query (before any limit); the exact matcher
  // runs on what comes back. Every node of the label is read, a page at a time.
  const keepName = makeFilter({ pattern: input.pattern });
  const scan = analyze.scanLabel(
    ctx.graphStore,
    ctx.orgId,
    label,
    input.pattern ? { nameLike: analyze.nameLikePattern(input.pattern) } : {},
  );
  const isTestSource = analyze.makeTestSourceCheck(ctx.graphStore, ctx.orgId);
  const dead: Array<{ qualifiedName: string; isTest: boolean }> = [];
  // Known external entry points (an Apex trigger on a platform event): no captured
  // references, but the platform runs them, so they are listed apart from `dead`.
  const entry: Array<{ qualifiedName: string; kinds: analyze.ExternalEntryPoint[] }> = [];
  const testOnly: string[] = [];
  let checked = 0;
  for (const page of scan.pages) {
    for (const n of page) {
      if (!keepName(n.qualifiedName)) continue;
      checked += 1;
      const isTest = analyze.isTestClass(n);
      const refs = analyze.incomingRefs(ctx.graphStore, ctx.orgId, n.qualifiedName, isTestSource);
      const kind = analyze.deadCodeKind(refs, isTest);
      if (kind === "dead") {
        const kinds = analyze.externalEntryPoints(ctx.graphStore, ctx.orgId, n, []);
        if (kinds.length > 0) entry.push({ qualifiedName: String(n.qualifiedName), kinds });
        else dead.push({ qualifiedName: String(n.qualifiedName), isTest });
      } else if (kind === "referenced-only-by-tests") testOnly.push(String(n.qualifiedName));
    }
  }
  const coverage = scan.coverage();
  if (!labelExists) {
    return {
      summary: `label ${label} is not scored`,
      markdown: renderReport({
        title: TITLE,
        inShort: [
          `No pieces of the kind ${code(label)} were found in the graph, so nothing was checked.`,
          "Check the kind name, for example `ApexClass`, `Flow` or `DataRaptor`.",
        ],
        details: `label ${label} is not scored by dead_code_audit (no ${label} nodes found; check the label spelling)`,
        next: ["Use `find_nodes` with a pattern such as `Flow:*` to see which kinds exist."],
      }),
      data: {
        dead: [],
        cached: false,
        total: 0,
        referencedOnlyByTests: [],
        referencedOnlyByTestsTotal: 0,
        scored: false,
        scan: coverage,
      },
      follow_up_tools: ["trace_upstream", "find_similar"],
    };
  }
  const partial = !coverage.complete;
  const partialText = `The scan was incomplete: it inspected ${coverage.scanned} of ${coverage.total} ${label} nodes.`;
  const shown = dead.slice(0, input.limit);
  const shownTestOnly = testOnly.slice(0, input.limit);
  const md = [
    `**${dead.length} ${label} candidate${dead.length === 1 ? "" : "s"} with no captured incoming references** (computed live; ${label} has no freshness score, so every ${label} with no incoming reference (test references count) is listed)${filterNote({ pattern: input.pattern })} — showing ${shown.length}.`,
    "",
    `_Note: ${input.confidence ? `confidence=${input.confidence} is ignored; ` : ""}confidence/freshness filters do not apply to unscored labels. Scanned ${coverage.scanned} of ${coverage.total}${partial ? " (incomplete)" : ""}._`,
    "",
    ...(dead.length
      ? shown.map((d) => `- ${d.qualifiedName}${d.isTest ? " (test class)" : ""}`)
      : [
          partial
            ? `_no ${label} with no captured incoming references in the ${coverage.scanned} of ${coverage.total} inspected_`
            : `_no ${label} with no captured incoming references_`,
        ]),
  ];
  if (dead.length > shown.length) {
    md.push("", `_${dead.length - shown.length} more not shown — ${NARROW_HINT}._`);
  }
  const shownEntry = entry.slice(0, input.limit);
  if (entry.length > 0) {
    md.push(
      "",
      `### Known external entry points (${entry.length}${entry.length > shownEntry.length ? `, first ${shownEntry.length}` : ""}; no captured incoming references, but run by the platform)`,
      ...shownEntry.map(
        (d) =>
          `- ${d.qualifiedName} — ${andList(d.kinds.map((k) => analyze.ENTRY_POINT_PLAIN[k] ?? k))}`,
      ),
    );
  }
  md.push(...testOnlySection(testOnly.length, shownTestOnly));
  const kinds = kindInText(label, { plural: true });
  const scope = `${checked} ${kindInText(label, { plural: checked !== 1 })}${input.pattern ? ` named like ${code(input.pattern)}` : ""}`;
  const markdown = renderReport({
    title: TITLE,
    inShort: [
      dead.length
        ? `${dead.length} of the ${scope} checked ${dead.length === 1 ? "has" : "have"} no captured incoming references${dead.length > shown.length ? `; ${firstListed(shown.length)}` : ""}.`
        : partial
          ? `None found in the ${coverage.scanned} of ${coverage.total} ${kinds} inspected; the scan was incomplete, so the rest were not checked.`
          : checked === 1
            ? `The ${scope} checked has something referring to it, so it is not unused.`
            : checked
              ? `None of the ${scope} checked has zero references: each has something referring to it.`
              : `No ${kinds}${input.pattern ? ` named like ${code(input.pattern)}` : ""} were found, so nothing was checked.`,
      `This kind has no age score, so it is checked live; references from tests count.${partial ? ` ${partialText}` : ""} ${OUTSIDE_GRAPH}`,
      ...(entry.length
        ? [
            `Separately, ${countNoun(entry.length, "piece")} ${entry.length === 1 ? "is a" : "are"} known external entry point${entry.length === 1 ? "" : "s"} (an Apex trigger on a platform event): no captured references, but the platform runs ${entry.length === 1 ? "it" : "them"}.`,
          ]
        : []),
      ...testOnlySentence(testOnly.length),
    ],
    pieces: shown.map((d) => ({
      name: d.qualifiedName,
      kind: label,
      role: d.isTest
        ? "a test class with no captured incoming references."
        : "no captured incoming references.",
    })),
    details: md.join("\n"),
    next: nextFor(shown),
  });
  return {
    summary: `${dead.length} ${label} candidates with no captured incoming references (live), showing ${shown.length}${testOnly.length ? `; ${testOnly.length} referenced only by tests` : ""}${partial ? `; scan incomplete (${coverage.scanned} of ${coverage.total})` : ""}`,
    markdown,
    // Same row shape as the scored path (review N1); unscored labels have no
    // freshness score, so score/confidence are null.
    data: {
      dead: shown.map(({ qualifiedName, isTest }) => ({
        qualifiedName,
        isTest,
        score: null,
        confidence: null,
        reasons: [] as string[],
      })),
      total: dead.length,
      // Only present when the label has entry points (the live shape stays as before otherwise).
      ...(entry.length
        ? {
            externalEntryPoints: shownEntry.map((d) => ({
              qualifiedName: d.qualifiedName,
              kinds: d.kinds,
              score: null,
              confidence: null,
              reasons: [analyze.EXTERNAL_ENTRY_POINT_REASON],
            })),
            externalEntryPointsTotal: entry.length,
          }
        : {}),
      referencedOnlyByTests: shownTestOnly.map((qualifiedName) => ({
        qualifiedName,
        score: null,
        confidence: null,
        reasons: ["referenced_only_by_tests"],
      })),
      referencedOnlyByTestsTotal: testOnly.length,
      cached: false,
      scored: false,
      live: true,
      scan: coverage,
    },
    follow_up_tools: ["trace_upstream", "find_similar"],
  };
}

/** The delete-safety list: production code only tests reference. */
function testOnlySection(total: number, shown: readonly string[]): string[] {
  if (total === 0) return [];
  return [
    "",
    `### Referenced only by tests (${total}${total > shown.length ? `, first ${shown.length}` : ""}; not dead)`,
    "_Production code whose only references come from test code: not dead (tests reference it), but deleting it means deleting those tests too._",
    ...shown.map((q) => `- ${q}`),
    ...(total > shown.length
      ? [
          `_+${total - shown.length} more (narrow the call: \`label\` or \`pattern\`, or a higher \`limit\`)_`,
        ]
      : []),
  ];
}

/** The separate list of known external entry points (REST, global, schedulable, ...). */
function entryPointSection(rows: readonly CachedDead[], limit: number): string[] {
  if (rows.length === 0) return [];
  const shown = rows.slice(0, limit);
  return [
    "",
    `### Known external entry points (${rows.length}${rows.length > shown.length ? `, first ${shown.length}` : ""}; no captured incoming references, but callable from outside)`,
    "_These are reached by integrations, the UI, schedules or other packages, which are not in the graph. Their age is shown, but age is not evidence they are unused; confidence stays low._",
    ...shown.map(
      (d) =>
        `- ${d.qualifiedName} — ${entryPointText(d.reasons)}; age score ${d.score.toFixed(2)}${d.reasons.includes("stale_freshness") ? " (not changed for over 180 days)" : ""}`,
    ),
    ...(rows.length > shown.length
      ? [`_+${rows.length - shown.length} more (narrow the call or raise \`limit\`)_`]
      : []),
  ];
}

function renderCandidates(
  candidates: CachedDead[],
  input: z.infer<typeof inputSchema>,
  cached: boolean,
  coverage: analyze.ScanCoverage,
) {
  const keep = makeFilter(input);
  const matches = candidates.filter(
    (d) => (!input.confidence || d.confidence === input.confidence) && keep(d.qualifiedName),
  );
  const partial = !coverage.complete;
  const partialText = `The scan was incomplete: it inspected ${coverage.scanned} of ${coverage.total}, so pieces in the rest are not listed.`;
  const scanData = { scan: coverage };
  const nonTest = matches.filter((d) => !isTestOnlyRow(d));
  // Known external entry points are listed apart: the graph cannot see their callers.
  const entry = nonTest.filter(isEntryPointRow);
  const pool = nonTest.filter((d) => !isEntryPointRow(d));
  const entryData = {
    externalEntryPoints: entry.slice(0, input.limit).map((d) => ({
      qualifiedName: d.qualifiedName,
      kinds: analyze.entryPointsFromReasons(d.reasons),
      score: d.score,
      confidence: d.confidence,
      reasons: d.reasons,
    })),
    externalEntryPointsTotal: entry.length,
  };
  const entryMd = entryPointSection(entry, input.limit);
  const entrySentence = entry.length
    ? [
        `Separately, ${countNoun(entry.length, "piece")} ${entry.length === 1 ? "is a" : "are"} known external entry point${entry.length === 1 ? "" : "s"} (REST, global, scheduled and similar): no captured references, but callers outside the graph are likely.`,
      ]
    : [];
  const testOnly = matches.filter(isTestOnlyRow);
  const shownTestOnly = testOnly.slice(0, input.limit);
  const testOnlyData = {
    referencedOnlyByTests: shownTestOnly.map((d) => ({
      qualifiedName: d.qualifiedName,
      score: d.score,
      confidence: d.confidence,
      reasons: d.reasons,
    })),
    referencedOnlyByTestsTotal: testOnly.length,
  };
  const testOnlyMd = testOnlySection(
    testOnly.length,
    shownTestOnly.map((d) => d.qualifiedName),
  );
  if (pool.length === 0) {
    const none = partial
      ? `No code with no captured incoming references found in the ${coverage.scanned} of ${coverage.total} inspected among ${scopeText(input)}; the scan was incomplete, so the rest were not checked.`
      : `No code with no captured incoming references found among ${scopeText(input)}.`;
    return {
      summary: `${partial ? `no dead-code candidates in the ${coverage.scanned} of ${coverage.total} inspected (scan incomplete)` : "no dead-code candidates"}${entry.length ? `; ${entry.length} known external entry points` : ""}${testOnly.length ? `; ${testOnly.length} referenced only by tests` : ""}`,
      markdown: renderReport({
        title: TITLE,
        inShort: [none, ...entrySentence, ...testOnlySentence(testOnly.length), NOT_USES],
        details: [
          partial
            ? `_no dead code detected in the ${coverage.scanned} of ${coverage.total} inspected (scan incomplete)_`
            : "_no dead code detected_",
          ...entryMd,
          ...testOnlyMd,
        ].join("\n"),
        next: NEXT.slice(1),
      }),
      data: { dead: [], cached, total: 0, ...entryData, ...testOnlyData, ...scanData },
      follow_up_tools: ["trace_upstream", "find_similar", "freshness_report"],
    };
  }
  const byConfidence = countBy(pool, (d) => d.confidence);
  const byLabel = countBy(pool, (d) => labelOf(d.qualifiedName));
  const shown = pool.slice(0, input.limit);
  const md = [
    `**${pool.length} dead-code candidate${pool.length === 1 ? "" : "s"} (no captured incoming references)**${filterNote(input)} — showing ${shown.length}.`,
    "",
    `Confidence: ${fmtCounts(byConfidence)}`,
    `Type: ${fmtCounts(byLabel)}`,
    `Scanned: ${coverage.scanned} of ${coverage.total}${partial ? " (incomplete)" : ""}`,
    "",
    ...shown.map(
      (d) =>
        `- ${d.qualifiedName} — ${d.confidence} ${d.score.toFixed(2)}${d.reasons.length ? ` (${d.reasons.join(", ")})` : ""}`,
    ),
  ];
  if (pool.length > shown.length) {
    md.push(
      "",
      `_${pool.length - shown.length} more not shown — ${NARROW_HINT}, or use \`export_sarif\` for the full machine-readable set._`,
    );
  }
  md.push("", `_${OUTSIDE_GRAPH}_`, ...entryMd, ...testOnlyMd);
  const confOrder = ["high", "medium", "low"];
  const conf = Object.entries(byConfidence)
    .sort((a, b) => confOrder.indexOf(a[0]) - confOrder.indexOf(b[0]))
    .map(([c, n]) => `${n} with ${c} confidence`);
  const pieces: Piece[] = shown.map((d) => ({
    name: d.qualifiedName,
    kind: labelOf(d.qualifiedName),
    // The score stays in Technical details: a low number reads as "unlikely" to most readers.
    role: `${reasonText(d.reasons)}; ${d.confidence} confidence.`,
  }));
  const extra = [...entrySentence, ...testOnlySentence(testOnly.length)];
  const confSentence = `By confidence, which comes from age: ${andList(conf)}${pool.length > shown.length ? `; ${firstListed(shown.length)}` : ""}${partial ? `; the scan was incomplete (${coverage.scanned} of ${coverage.total} inspected), so pieces in the rest are not listed` : ""}; callers outside the graph (integrations, the UI, schedules) are not captured, so none of this is proof that nothing uses a piece.`;
  const base = [
    `${countNoun(pool.length, "piece")} ${pool.length === 1 ? "has" : "have"} no captured incoming references: ${kindCounts(pool.map((d) => labelOf(d.qualifiedName)))}.`,
    confSentence,
    ...extra,
  ];
  const markdown = renderReport({
    title: TITLE,
    inShort: [
      ...base,
      // Room for the scope only within the 4-sentence budget.
      ...(base.length < 4
        ? [`Checked: ${scopeText(input)}; ${NOT_USES.charAt(0).toLowerCase()}${NOT_USES.slice(1)}`]
        : []),
    ],
    pieces,
    details: md.join("\n"),
    next: nextFor(shown.map((d) => ({ qualifiedName: d.qualifiedName, isTest: isTestRow(d) }))),
  });
  return {
    summary: `${pool.length} dead-code candidates (no captured incoming references)${cached ? " (cached)" : ""}, showing ${shown.length}${entry.length ? `; ${entry.length} known external entry points` : ""}${testOnly.length ? `; ${testOnly.length} referenced only by tests` : ""}${partial ? `; scan incomplete (${coverage.scanned} of ${coverage.total})` : ""}`,
    markdown,
    // One row shape on both paths (review N1): live rows are scored with the
    // same helper as the cache, so `reasons` (e.g. referenced_only_by_tests)
    // is in `data` either way.
    data: {
      dead: shown.map((d) => ({
        qualifiedName: d.qualifiedName,
        isTest: isTestRow(d),
        score: d.score,
        confidence: d.confidence,
        reasons: d.reasons,
      })),
      total: pool.length,
      ...entryData,
      ...testOnlyData,
      byConfidence,
      byLabel,
      cached,
      ...scanData,
    },
    follow_up_tools: ["trace_upstream", "find_similar", "freshness_report", "export_sarif"],
  };
}

defineTool({
  name: "dead_code_audit",
  description:
    "Use for 'what can I delete'. Lists code with no captured incoming references (outside callers not captured); filter by `label`, `pattern`, `confidence`.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const cached = readCachedDeadCode(ctx);
    const wantLabel = input.label?.toLowerCase();
    // Unscored = the scorer never covers this label (membership in the scored
    // set), NOT "no cached rows": a scored label with no candidates must keep
    // reporting "no dead code detected".
    const unscored = wantLabel !== undefined && !SCORED_LABELS.has(wantLabel);
    if (input.label && unscored) {
      return liveZeroInbound(ctx, input.label, input);
    }
    // A cache whose own scan stopped early cannot answer a filtered question
    // completely: scan live with the filters in the store query.
    const filtered = input.label !== undefined || input.pattern !== undefined;
    if (cached && !(filtered && !cached.coverage.complete)) {
      return renderCandidates(cached.rows, input, true, cached.coverage);
    }
    // No usable cache: score the live candidates with the same helper the
    // cache uses, so confidence, score and reasons mean the same on both paths.
    // The label and pattern go into the store query before any limit.
    const now = Date.now();
    const scan = analyze.scanDeadCode(ctx.graphStore, ctx.orgId, {
      label: input.label,
      pattern: input.pattern,
    });
    const candidates: CachedDead[] = scan.candidates
      .map(({ node, testOnlyRefs, isTest, externalEntryPoints }) => ({
        qualifiedName: String(node.qualifiedName),
        ...analyze.scoreDeadCode(node, now, testOnlyRefs, isTest, externalEntryPoints),
      }))
      .sort((a, b) => a.score - b.score || a.qualifiedName.localeCompare(b.qualifiedName));
    return renderCandidates(candidates, input, false, scan.coverage);
  },
});
