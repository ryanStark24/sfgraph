import { REL_TYPES } from "@ryanstark24/sfgraph-core";

import { asQualifiedName } from "@ryanstark24/sfgraph-shared";
import { getToolContext } from "../context.js";
import { defineTool, z } from "./_define.js";
import { notFoundReport } from "./_not-found.js";
import { labelOfQname } from "./_reach_list.js";
import {
  andList,
  code,
  kindCounts,
  linkFacts,
  nameOf,
  pieceRole,
  renderReport,
  reportDiagram,
} from "./_report.js";

// Salesforce SObject and Field API names are letters/digits/underscore only
// (custom suffix `__c` / `__r` / etc. is allowed). Reject anything else
// up-front rather than silently returning "field not found" — agents that
// pass `object: "Account.Tier__c"` should see the validation error.
// Every rel that reads/writes a field, enumerated by suffix so new
// `<KIND>_READS_FIELD` / `<KIND>_WRITES_FIELD` rels are picked up automatically,
// plus the two field-use rels that do not follow the suffix convention.
// Deliberately excluded: DEFINES_FIELD, GRANTS_FIELD_ACCESS (own switch),
// DEPENDS_ON_FIELD, RENDERS_FIELD (structure / presentation, not data use).
const ALL_RELS = Object.values(REL_TYPES) as string[];
const READ_RELS = new Set([
  ...ALL_RELS.filter((r) => r.endsWith("READS_FIELD")),
  REL_TYPES.LWC_BINDS_FIELD as string,
]);
const WRITE_RELS = new Set([
  ...ALL_RELS.filter((r) => r.endsWith("WRITES_FIELD")),
  REL_TYPES.WORKFLOW_UPDATES_FIELD as string,
]);
/** Max reader + writer lines printed together. */
const LIST_CAP = 300;

const SF_API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:__[a-zA-Z])?$/;

const inputSchema = z.object({
  org: z.string().min(1),
  object: z
    .string()
    .min(1)
    .regex(SF_API_NAME_RE, "object must be a Salesforce SObject API name (no dots or spaces)"),
  field: z
    .string()
    .min(1)
    .regex(SF_API_NAME_RE, "field must be a Salesforce field API name (no dots or spaces)"),
  /** Also list GRANTS_FIELD_ACCESS sources (Profiles / PermissionSets). Default false. */
  include_grants: z.boolean().default(false),
  /** Show the Picture (the field, its readers and writers); false hides it. */
  mermaid: z.boolean().default(true),
});

defineTool({
  name: "analyze_field",
  description:
    "Use for 'who reads or writes Object.Field'. Lists the Apex, LWC, Flow, DataRaptor, formula, rule, report and workflow users; `include_grants` adds grants.",
  inputSchema,
  async execute(input) {
    const ctx = await getToolContext({ orgId: input.org });
    const qname = asQualifiedName(`CustomField:${input.object}.${input.field}`);
    const node = ctx.graphStore.getNode(ctx.orgId, qname);
    const incoming = ctx.graphStore.listEdgesTo(ctx.orgId, qname);
    if (!node && incoming.length === 0) {
      return {
        summary: "field not found",
        markdown: notFoundReport({
          title: `Where ${input.object}.${input.field} is used`,
          names: [qname],
          what: "and nothing in the graph reads or writes it",
          details: `> no node \`${qname}\``,
          next: ["Check the object and field API names (a custom field ends in `__c`)."],
        }),
        data: { found: false },
        follow_up_tools: ["trace_upstream", "trace_downstream", "security_audit", "find_similar"],
      };
    }
    const readers = incoming.filter((e) => READ_RELS.has(e.relType));
    const writers = incoming.filter((e) => WRITE_RELS.has(e.relType));
    const grants = incoming.filter((e) => e.relType === REL_TYPES.GRANTS_FIELD_ACCESS);
    // No field node (no field metadata in the source) but edges still target
    // the qname: report them, plus any other inbound rel (layouts etc.),
    // since those edges are the only evidence the field exists.
    const others = node
      ? []
      : incoming.filter(
          (e) =>
            !READ_RELS.has(e.relType) &&
            !WRITE_RELS.has(e.relType) &&
            e.relType !== REL_TYPES.GRANTS_FIELD_ACCESS,
        );
    const shownGrants = input.include_grants ? grants : [];
    const line = (e: { srcQualifiedName: string; relType: string }): string =>
      `- ${e.srcQualifiedName} — ${e.relType}`;
    const sorted = <T extends { srcQualifiedName: string }>(xs: T[]): T[] =>
      [...xs].sort((a, b) => a.srcQualifiedName.localeCompare(b.srcQualifiedName));
    const writersShown = sorted(writers).slice(
      0,
      readers.length + writers.length > LIST_CAP
        ? Math.min(writers.length, LIST_CAP / 2)
        : writers.length,
    );
    const readersShown = sorted(readers).slice(0, Math.max(0, LIST_CAP - writersShown.length));
    const omitted = readers.length - readersShown.length + (writers.length - writersShown.length);
    const md = [
      ...(node
        ? []
        : [
            `> no node \`${qname}\` (no field metadata in the source); ${incoming.length} inbound edge(s) target it`,
            "",
          ]),
      `**${qname}** — readers ${readers.length} · writers ${writers.length} · grants ${grants.length}${
        input.include_grants || grants.length === 0
          ? ""
          : " (hidden; pass `include_grants: true` to list them)"
      }`,
      "",
      `### Readers (${readers.length})`,
      ...readersShown.map(line),
      "",
      `### Writers (${writers.length})`,
      ...writersShown.map(line),
    ];
    if (omitted > 0) {
      md.push(
        "",
        `_${omitted} more readers/writers omitted (cap ${LIST_CAP}); narrow with trace_upstream \`labels\` / \`rel_types\` on the field qname, e.g. labels:["ApexClass"]._`,
      );
    }
    if (others.length > 0) {
      md.push("", `### Other inbound (${others.length})`, ...sorted(others).map(line));
    }
    if (input.include_grants) {
      md.push("", `### Grants (${grants.length})`, ...sorted(grants).map(line));
    }
    // The report: the sources that use the field, by kind.
    const labelOf = (q: string): string =>
      ctx.graphStore.getNode(ctx.orgId, asQualifiedName(q))?.label ?? labelOfQname(q);
    const uniq = (xs: readonly { srcQualifiedName: string }[]) => [
      ...new Set(xs.map((e) => e.srcQualifiedName)),
    ];
    const who = code(nameOf(qname));
    const r = uniq(readers);
    const w = uniq(writers);
    const uses = [
      ...(w.length ? [`written by ${kindCounts(w.map(labelOf))}`] : []),
      ...(r.length ? [`read by ${kindCounts(r.map(labelOf))}`] : []),
    ];
    const inShort = [
      uses.length ? `${who} is ${andList(uses)}.` : `Nothing in the graph reads or writes ${who}.`,
    ];
    if (!w.length && r.length) inShort.push("Nothing writes it.");
    if (!r.length && w.length) inShort.push("Nothing reads it.");
    if (!node)
      inShort.push(
        "No field definition was found in the source; the links that name it are under Technical details.",
      );
    if (grants.length && !input.include_grants)
      inShort.push(
        `${grants.length} access ${grants.length === 1 ? "grant" : "grants"} (profiles and permission sets) ${grants.length === 1 ? "is" : "are"} hidden.`,
      );
    const used = [...writersShown, ...readersShown, ...shownGrants];
    const links = used.map((e) => ({
      from: e.srcQualifiedName,
      to: String(qname),
      rel: e.relType,
    }));
    const sources = [...new Set(used.map((e) => e.srcQualifiedName))];
    const facts = linkFacts(links, new Set([String(qname), ...sources]));
    const report = renderReport({
      title: `Where ${nameOf(qname)} is used`,
      inShort,
      diagram: input.mermaid
        ? reportDiagram(
            [
              { id: String(qname), label: "CustomField" },
              ...sources.map((q) => ({ id: q, label: labelOf(q) })),
            ],
            links,
          )
        : undefined,
      pieces: sources.map((q) => ({
        name: q,
        kind: labelOf(q),
        role: pieceRole({ kind: labelOf(q), ...facts(q) }),
      })),
      details: md.join("\n"),
      next: [
        ...(grants.length && !input.include_grants
          ? [
              "Set `include_grants: true` to list the profiles and permission sets that give access.",
            ]
          : []),
        ...(omitted > 0
          ? ["Run `trace_upstream` on the field with `labels` to see the rest."]
          : []),
        "Not tracked directly: OmniScript, Integration Procedure and FlexCard field use; check the DataRaptors they call.",
        "Flow field references are tracked (READS_FIELD/WRITES_FIELD from Flow).",
        "The graph excludes commented-out code and string-only mentions, so a text-search hit missing here is usually one of those.",
        "Run `trace_upstream` on the field to see what relies on its readers and writers.",
      ],
    });
    return {
      summary: `${readers.length} readers / ${writers.length} writers`,
      markdown: report,
      data: {
        ...(node ? {} : { found: false, other: others.map((e) => e.srcQualifiedName) }),
        readers: readersShown.map((e) => e.srcQualifiedName),
        writers: writersShown.map((e) => e.srcQualifiedName),
        grants: shownGrants.map((e) => e.srcQualifiedName),
        grants_count: grants.length,
      },
      follow_up_tools: ["trace_upstream", "trace_downstream", "security_audit", "find_similar"],
    };
  },
});
