import { analyze } from "@ryanstark24/sfgraph-core";
import type { GraphStore } from "@ryanstark24/sfgraph-core";
import { type OrgId, type QualifiedName, asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { labelOfQname, shapeTrace } from "./_reach_list.js";
import {
  aOrAn,
  code,
  kindCounts,
  kindInText,
  linkFacts,
  nameOf,
  pieceCount,
  pieceRole,
  renderReport,
  reportDiagram,
} from "./_report.js";

/** The plain report of an explain_code result. */
function codeReport(o: {
  qname: string;
  kind: string;
  refs: CodeReference[];
  inShort: string[];
  details: string;
  next: string[];
  mermaid: boolean;
}): string {
  const refs = [...new Map(o.refs.map((r) => [r.qname, r])).values()];
  const links = o.refs.map((r) => ({ from: o.qname, to: r.qname, rel: r.relType }));
  const facts = linkFacts(links, new Set([o.qname, ...refs.map((r) => r.qname)]));
  return renderReport({
    title: `What ${nameOf(o.qname)} does`,
    inShort: o.inShort,
    diagram:
      o.mermaid && refs.length
        ? reportDiagram(
            [{ id: o.qname, label: o.kind }, ...refs.map((r) => ({ id: r.qname, label: r.label }))],
            links,
          )
        : undefined,
    pieces: refs
      .filter((r) => r.role !== "standard-field")
      .map((r) => ({
        name: r.qname,
        kind: r.label,
        role: pieceRole({ kind: r.label, ...facts(r.qname) }),
      })),
    details: o.details,
    next: [
      ...o.next,
      ...(refs.length
        ? [
            "Direct references leave out its own class and pseudo endpoints (platform Apex, DML and the like).",
          ]
        : []),
    ],
  });
}

/** "Its code uses 2 pieces directly: 1 Apex class (server code) and 1 field." */
/** "Its code uses 2 pieces directly: ..."; with no source to read, "It links directly to ...". */
function usesSentence(refs: CodeReference[], hasSource = true): string {
  const units = [...new Map(refs.map((r) => [r.qname, r])).values()];
  const counted = units.filter((r) => r.role !== "standard-field");
  const std = units.length - counted.length;
  const tail = std ? `, plus ${std} standard ${std === 1 ? "field" : "fields"}` : "";
  if (!hasSource)
    return counted.length
      ? `It links directly to ${pieceCount(counted.length)}: ${kindCounts(counted.map((r) => r.label))}${tail}.`
      : `It links directly to no other pieces${tail}.`;
  return counted.length
    ? `Its code uses ${pieceCount(counted.length)} directly: ${kindCounts(counted.map((r) => r.label))}${tail}.`
    : `Its code uses no other pieces directly${tail}.`;
}

export interface CodeReference {
  qname: string;
  label: string;
  relType: string;
  /** `standard-field`: a standard field (no `__<suffix>`, e.g. `Account.Name`); listed, not a custom field. */
  role?: "standard-field";
}

/**
 * The target's direct references, component level: trace_downstream at
 * depth 1 (same filters and containment; a method target stays
 * method-scoped, a class target includes its methods' edges), each reached
 * row rolled up to its component (containment.ts `componentOf`), the
 * target's own component dropped, pseudo endpoints (platform Apex, DML, ...)
 * excluded. One entry per (component, relType) of the direct edges reaching
 * it; a component reached only by containment carries that rel. A standard
 * field (field-scope `isStandardFieldQname`) carries `role: "standard-field"`.
 * Sorted by qname, then relType (code point).
 */
function directReferences(store: GraphStore, orgId: OrgId, qname: QualifiedName): CodeReference[] {
  const r = analyze.findDependencies(store, orgId, qname, 1, {
    excludeSecurity: true,
    excludeReflection: true,
    leafStructure: true,
    rollupApexClass: true,
  });
  if (r.found === false) return [];
  const { reached } = shapeTrace(r.reached ?? [], {
    alsoPresent: [String(qname)],
    hasClass: analyze.apexTypeExists(store, orgId),
  });
  const self = String(analyze.componentOf(store, orgId, qname)).toLowerCase();
  const units = new Map<
    string,
    { qname: string; label: string; direct: Set<string>; other: Set<string> }
  >();
  for (const row of reached) {
    if (row.role) continue;
    const unit = String(analyze.componentOf(store, orgId, asQualifiedName(row.qualifiedName)));
    const key = unit.toLowerCase();
    if (key === self) continue;
    let u = units.get(key);
    if (!u) {
      const label =
        unit === row.qualifiedName
          ? row.label
          : (store.getNode(orgId, asQualifiedName(unit))?.label ??
            unit.slice(0, unit.indexOf(":")));
      u = { qname: unit, label, direct: new Set(), other: new Set() };
      units.set(key, u);
    }
    (row.via ? u.other : u.direct).add(row.relType);
  }
  const out: CodeReference[] = [];
  for (const u of units.values()) {
    for (const relType of u.direct.size ? u.direct : u.other) {
      out.push(
        analyze.isStandardFieldQname(u.qname)
          ? { qname: u.qname, label: u.label, relType, role: "standard-field" }
          : { qname: u.qname, label: u.label, relType },
      );
    }
  }
  return out.sort(
    (a, b) =>
      analyze.codePointCompare(a.qname, b.qname) || analyze.codePointCompare(a.relType, b.relType),
  );
}

/** Max references printed in the text; the rest are counted. */
const REFERENCES_TEXT_CAP = 100;

function referencesText(refs: CodeReference[]): string[] {
  if (refs.length === 0) return ["**Direct references:** none", ""];
  const shown = refs
    .slice(0, REFERENCES_TEXT_CAP)
    .map(
      (r) => `- ${r.qname} — ${r.relType}${r.role === "standard-field" ? " (standard field)" : ""}`,
    );
  const more = refs.length - shown.length;
  return [
    `**Direct references** (${refs.length}, component level; trace_downstream depth 1):`,
    ...shown,
    ...(more > 0
      ? [
          `_+${more} more (narrow the call: trace_downstream at depth 1 with \`labels\` or \`rel_types\`)_`,
        ]
      : []),
    "",
  ];
}

// Cap annotation size at 16 KiB. Cached explanations are echoed back inside
// markdown blockquotes; unbounded input bloats the SQLite row and would let
// a poisoned graph break the host's markdown renderer.
const ANNOTATION_MAX_BYTES = 16 * 1024;

const inputSchema = z.object({
  org: z.string().min(1),
  qname: z.string().min(1),
  refresh: z.boolean().default(false),
  annotation: z
    .string()
    .max(ANNOTATION_MAX_BYTES, "annotation exceeds 16 KiB cap")
    .optional()
    .describe("Saves this as the explanation."),
  /** Show the Picture (the target and what it uses); false hides it. */
  mermaid: z.boolean().default(true),
});

defineTool({
  name: "explain_code",
  description:
    "Use to explain an Apex method (`ApexMethod:Svc.run(2)`), trigger or Flow, not a class: source, cached explanation and direct references.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(input.qname);
    // In data, and listed in the markdown after the source (an MCP client sees only the text).
    const references = directReferences(ctx.graphStore, ctx.orgId, qname);
    const kind = ctx.graphStore.getNode(ctx.orgId, qname)?.label ?? labelOfQname(input.qname);
    const who = code(nameOf(input.qname));
    const report = (inShort: string[], details: string, next: string[]) =>
      codeReport({
        qname: input.qname,
        kind,
        refs: references,
        inShort,
        details,
        next,
        mermaid: input.mermaid,
      });
    const noSource = [
      "Run `analyze_field` for a field, or `trace_upstream` and `trace_downstream` for other kinds.",
      "Look up the methods of a class with `find_nodes` (for example the pattern `ApexMethod:ClassName.*`).",
    ];

    // Annotation write path
    if (typeof input.annotation === "string" && input.annotation.length > 0) {
      const now = Date.now();
      const ok = ctx.graphStore.updateSnippetExplanation(ctx.orgId, qname, input.annotation, now);
      if (!ok) {
        return {
          summary: `no snippet stored for ${input.qname} — annotation not persisted`,
          markdown: report(
            [`No source code is stored for ${who}, so the explanation was not saved.`],
            `> No snippet exists for \`${input.qname}\`. Likely a non-code metadata type, or the org has not been ingested yet.`,
            noSource,
          ),
          data: {
            qname: input.qname,
            sourceFormat: null,
            sourceText: null,
            startLine: null,
            endLine: null,
            cachedExplanation: null,
            cachedAt: null,
            stored: false,
            references,
          },
        };
      }
      const snippet = ctx.graphStore.getSnippet(ctx.orgId, qname);
      return {
        summary: `cached explanation for ${input.qname}`,
        markdown: report(
          [`The explanation of ${who} was saved; the next \`explain_code\` call shows it.`],
          `> Explanation cached for \`${input.qname}\` at ${new Date(now).toISOString()}.`,
          [
            "Run `explain_code` again without `annotation` to read the source with the explanation.",
          ],
        ),
        data: {
          qname: input.qname,
          sourceFormat: snippet?.sourceFormat ?? null,
          sourceText: snippet?.sourceText ?? null,
          startLine: snippet?.startLine ?? null,
          endLine: snippet?.endLine ?? null,
          cachedExplanation: snippet?.llmExplanation ?? input.annotation,
          cachedAt: snippet?.explainedAt ?? now,
          stored: true,
          references,
        },
      };
    }

    // Read path
    const snippet = ctx.graphStore.getSnippet(ctx.orgId, qname);
    if (!snippet) {
      return {
        summary: `no snippet stored for ${input.qname} — likely a non-code metadata type`,
        markdown: report(
          [
            kind === "ApexClass"
              ? `${who} is ${aOrAn(kindInText(kind))}. Source is stored per method; ask for one of its methods (see below).`
              : `${who} is ${aOrAn(kindInText(kind))} with no stored source code, so there is no code to explain.`,
            ...(references.length ? [usesSentence(references, false)] : []),
          ],
          `> No snippet stored for \`${input.qname}\`. Snippets are emitted only for code parsers (currently Apex methods). For declarative metadata, use \`analyze_field\` or \`trace_upstream\` instead.`,
          noSource,
        ),
        data: {
          qname: input.qname,
          sourceFormat: null,
          sourceText: null,
          startLine: null,
          endLine: null,
          cachedExplanation: null,
          cachedAt: null,
          stored: false,
          references,
        },
      };
    }

    const showCached = !input.refresh && snippet.llmExplanation;
    const md: string[] = [
      `**${input.qname}** — \`${snippet.sourceFormat}\`${
        snippet.startLine != null ? ` (lines ${snippet.startLine}–${snippet.endLine ?? "?"})` : ""
      }`,
      "",
      `\`\`\`${snippet.sourceFormat}`,
      snippet.sourceText,
      "```",
      "",
    ];
    md.push(...referencesText(references));
    if (showCached) {
      md.push("**Cached explanation:**", "", `> ${snippet.llmExplanation}`);
    } else {
      md.push(
        "> No explanation cached yet — generate one and call `explain_code` again with `annotation` to persist it.",
      );
    }
    md.push("", "_follow_up_tools: `analyze_field`, `trace_upstream`, `trace_downstream`_");
    return {
      summary: showCached
        ? `snippet + cached explanation for ${input.qname}`
        : `snippet for ${input.qname} (no cached explanation)`,
      markdown: report(
        [
          `${who} is ${aOrAn(kindInText(kind))}${
            snippet.startLine != null
              ? (snippet.endLine ?? snippet.startLine) === snippet.startLine
                ? `, at line ${snippet.startLine} of its source`
                : `, at lines ${snippet.startLine} to ${snippet.endLine} of its source`
              : ""
          }; its source is under Technical details.`,
          ...(kind === "ApexTrigger"
            ? [triggerWhen(snippet.sourceText) ?? ""].filter(Boolean)
            : []),
          usesSentence(references),
          showCached
            ? "A saved explanation is shown with the source."
            : "No explanation is saved yet.",
        ],
        md.join("\n"),
        [
          ...(showCached
            ? ["Set `refresh: true` to hide the saved explanation and write a new one."]
            : ["Save an explanation with `annotation` so the next reader sees it."]),
          `Run \`trace_upstream\` to see what relies on ${who}.`,
          "Run `analyze_field` on a field it reads or writes.",
        ],
      ),
      data: {
        qname: input.qname,
        sourceFormat: snippet.sourceFormat,
        sourceText: snippet.sourceText,
        startLine: snippet.startLine ?? null,
        endLine: snippet.endLine ?? null,
        cachedExplanation: showCached ? (snippet.llmExplanation ?? null) : null,
        cachedAt: showCached ? (snippet.explainedAt ?? null) : null,
        stored: false,
        references,
      },
    };
  },
});

const TRIGGER_VERB: Readonly<Record<string, string>> = {
  insert: "created",
  update: "updated",
  delete: "deleted",
  undelete: "restored",
};

/**
 * When an Apex trigger runs, in plain words, from its header (`trigger T on Case (before insert,
 * after update)`): "It runs before `Case` records are created, and after they are updated."
 * Undefined when the header cannot be read.
 */
export function triggerWhen(source: string): string | undefined {
  const m = /^\s*trigger\s+\w+\s+on\s+([\w.]+)\s*\(([^)]*)\)/im.exec(source);
  if (!m) return undefined;
  const byTiming = new Map<string, string[]>();
  for (const ev of m[2]!.split(",")) {
    const [timing, op] = ev.trim().toLowerCase().split(/\s+/);
    const verb = op ? TRIGGER_VERB[op] : undefined;
    if ((timing !== "before" && timing !== "after") || !verb) continue;
    const g = byTiming.get(timing) ?? byTiming.set(timing, []).get(timing)!;
    if (!g.includes(verb)) g.push(verb);
  }
  if (!byTiming.size) return undefined;
  const or = (xs: string[]) =>
    xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
  const parts = [...byTiming].map(([timing, verbs], i) =>
    i === 0 ? `${timing} \`${m[1]}\` records are ${or(verbs)}` : `${timing} they are ${or(verbs)}`,
  );
  return `It runs ${parts.join(", and ")}.`;
}
