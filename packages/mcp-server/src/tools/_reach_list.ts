import { analyze } from "@ryanstark24/sfgraph-core";
import {
  andList,
  code,
  kindCounts,
  linkFacts,
  methodCountNote,
  nameOf,
  notCountedPhrase,
  pieceCount,
  pieceRole,
  renderReport,
  reportDiagram,
} from "./_report.js";

type ReachedEntry = analyze.ReachedEntry;
type PseudoEntry = ReachedEntry & { pseudoKind: analyze.PseudoKind };

/**
 * Output shaping shared by trace_downstream / trace_upstream: pseudo
 * endpoints (platform Apex, DML, LWC properties/events, a Remote duplicating
 * a reached ApexClass, a managed-package type with no node) move from
 * `reached` to `pseudo`; with `markStandardFields`, reached standard fields
 * (no `__<suffix>`, e.g. `__c`, `__pc`, `__s`) stay in `reached` with `role: "standard-field"`.
 * `counted` is the component count (rows without a role: not the root's own
 * members, not standard fields).
 */
export function shapeTrace(
  reached: ReachedEntry[],
  opts: analyze.PseudoEndpointOpts & { markStandardFields?: boolean } = {},
): {
  reached: ReachedEntry[];
  pseudo: PseudoEntry[];
  counted: number;
} {
  const { kept, pseudo } = analyze.partitionPseudoEndpoints(reached, opts);
  const rows = opts.markStandardFields
    ? kept.map((e) =>
        !e.role && analyze.isStandardFieldQname(e.qualifiedName)
          ? { ...e, role: "standard-field" as const }
          : e,
      )
    : kept;
  return { reached: rows, pseudo, counted: rows.filter((e) => !e.role).length };
}

/** A dynamic SOQL/SOSL platform call (`ApexMethod:Database.query(1)`, ...). */
const DYNAMIC_QUERY =
  /^ApexMethod:(Database|Search)\.(query|queryWithBinds|countQuery|countQueryWithBinds|getQueryLocator|getQueryLocatorWithBinds)\(/i;

/** Max list entries printed in the text body. */
export const REACH_LIST_CAP = 300;

export interface RenderReachListOpts {
  direction: "downstream" | "upstream";
  target: string;
  depth: number;
  reached: ReachedEntry[];
  /** Pseudo endpoints moved out of `reached` (listed compactly after it). */
  pseudo?: PseudoEntry[];
  /** Only print entries whose label is in this set (case-insensitive). */
  labels?: string[];
  cap?: number;
}

/**
 * Lossless plain-list rendering of a traversal: full qnames (never
 * truncated) grouped by label, each with its min hop and the rel it was
 * reached by. Dangling qnames (edge endpoint with no node row) are listed
 * with the label taken from the qname prefix and marked `(no node)`.
 */
export function renderReachList(opts: RenderReachListOpts): string {
  const cap = opts.cap ?? REACH_LIST_CAP;
  // The root's own members are part of the root, not something it reaches:
  // listed apart, not counted.
  const rootMembers = opts.reached.filter((e) => e.role === "root-member");
  // Standard fields: kept visible, listed apart, not counted.
  const standardFields = opts.reached.filter((e) => e.role === "standard-field");
  const components = opts.reached.filter((e) => !e.role);
  const counts = countByLabel(components);
  const wanted = opts.labels?.length ? new Set(opts.labels.map((l) => l.toLowerCase())) : undefined;
  const shown = wanted ? components.filter((e) => wanted.has(e.label.toLowerCase())) : components;

  const lines: string[] = [];
  const total = components.length;
  lines.push(
    `${opts.direction} of \`${opts.target}\` (depth ${opts.depth}): ${total} component${total === 1 ? "" : "s"}${
      total ? ` — ${[...counts].map(([l, c]) => `${l} ${c}`).join(", ")}` : ""
    }`,
  );
  const dangling = components.filter((e) => !e.hasNode).length;
  if (dangling > 0) {
    lines.push(`${dangling} of them have no node row (edge target only), marked \`(no node)\`.`);
  }
  if (wanted) {
    lines.push(`Showing labels: ${[...wanted].join(", ")} (${shown.length} entries).`);
  }

  // Roll-up sibling methods are collapsed under their ApexClass line so they
  // cannot crowd other labels out of the cap (unless ApexMethod is asked for).
  const collapse = !wanted?.has("apexmethod");
  const rollupCount = new Map<string, number>();
  const visible = collapse
    ? shown.filter((e) => {
        if (e.via !== "class-rollup" || e.label !== "ApexMethod") return true;
        const cls = owningClass(e.qualifiedName).toLowerCase();
        rollupCount.set(cls, (rollupCount.get(cls) ?? 0) + 1);
        return false;
      })
    : shown;

  const ordered = [...visible].sort(
    (a, b) =>
      // roll-up siblings sort after direct entries so they cannot crowd the cap
      Number(a.via === "class-rollup") - Number(b.via === "class-rollup") ||
      a.hop - b.hop ||
      a.qualifiedName.localeCompare(b.qualifiedName),
  );
  const kept = ordered.slice(0, cap);
  const omitted = ordered.length - kept.length;

  const groups = new Map<string, ReachedEntry[]>();
  for (const e of kept) {
    const g = groups.get(e.label);
    if (g) g.push(e);
    else groups.set(e.label, [e]);
  }
  for (const label of [...groups.keys()].sort()) {
    const group = groups.get(label) ?? [];
    lines.push("", `### ${label} (${group.length})`);
    for (const e of group) {
      const via = e.via === "class-rollup" ? `${e.relType} (class roll-up)` : e.relType;
      const k = rollupCount.get(e.qualifiedName.toLowerCase());
      const rolled = k ? ` (+${k} method${k === 1 ? "" : "s"} via roll-up)` : "";
      const folded = e.folded?.length ? ` (+${e.folded.join(", ")})` : "";
      const owner = isMethodRow(e) ? ` (in ${owningClass(e.qualifiedName)})` : "";
      lines.push(
        `- ${e.qualifiedName}${owner}${rolled}${folded} — hop ${e.hop} via ${via}${e.hasNode ? "" : " (no node)"}`,
      );
    }
  }
  // A reached method is a member of its class: list the classes of the listed
  // methods that are not listed themselves (nor the target).
  const listed = new Set(
    [opts.target, ...components.map((e) => e.qualifiedName)].map((q) => q.toLowerCase()),
  );
  const owners = new Map<string, string>();
  for (const e of kept) {
    if (!isMethodRow(e)) continue;
    const cls = owningClass(e.qualifiedName);
    if (!listed.has(cls.toLowerCase())) owners.set(cls.toLowerCase(), cls);
  }
  if (owners.size > 0) {
    const sorted = [...owners.values()].sort((a, b) => a.localeCompare(b));
    lines.push(
      "",
      `### Classes of the listed methods (${sorted.length} not listed above)`,
      ...sorted.map((q) => `- ${q}`),
    );
  }
  if (rootMembers.length > 0) {
    lines.push(
      "",
      `### Root members (${rootMembers.length}, part of \`${opts.target}\`, not counted)`,
      ...rootMembers.map((e) => `- ${e.qualifiedName}`),
    );
  }
  if (standardFields.length > 0) {
    lines.push(
      "",
      `### Standard fields (${standardFields.length}, no \`__c\` suffix, not counted)`,
      ...standardFields.map((e) => `- ${e.qualifiedName} — hop ${e.hop} via ${e.relType}`),
    );
  }
  const pseudo = opts.pseudo ?? [];
  if (pseudo.length > 0) {
    const byKind = new Map<string, string[]>();
    for (const p of pseudo) {
      const g = byKind.get(p.pseudoKind);
      if (g) g.push(p.qualifiedName);
      else byKind.set(p.pseudoKind, [p.qualifiedName]);
    }
    lines.push(
      "",
      `_${pseudo.length} pseudo endpoint${pseudo.length === 1 ? "" : "s"} not counted_ (platform Apex, DML operations, LWC properties/events, Remote calls duplicating a listed ApexClass, managed-package types with no node):`,
      ...[...byKind].map(
        ([k, qs]) =>
          `- ${k} (${qs.length}): ${qs.slice(0, 20).join(", ")}${qs.length > 20 ? `, +${qs.length - 20} more (narrow the call: a lower \`depth\` or \`rel_types\`)` : ""}`,
      ),
    );
  }
  // Dynamic queries: their objects and fields are in a run-time string, so no
  // edge reaches them (packages/core parsers/apex class.ts DYNAMIC_QUERY).
  const dynamic = pseudo
    .map((p) => p.qualifiedName)
    .filter((q) => DYNAMIC_QUERY.test(q))
    .map((q) => q.slice(q.indexOf(":") + 1));
  if (dynamic.length > 0) {
    lines.push(
      "",
      `_Dynamic queries reached_ (${[...new Set(dynamic)].map((q) => `\`${q}\``).join(", ")}): objects and fields named in a query string built at run time have no edge, so they are not listed — read the calling methods' source (\`explain_code\`) for them.`,
    );
  }
  if (omitted > 0) {
    lines.push(
      "",
      `_${omitted} more entries omitted_ (list capped at ${cap}, nearest hops first). Narrow with a lower \`depth\`, a \`labels\` filter (e.g. \`labels: ["ApexClass"]\`), or \`rel_types\`.`,
    );
  }
  return lines.join("\n");
}

/** An Apex method row (ApexMethod or TestMethod label, `ApexMethod:` qname). */
export function isMethodRow(e: { label: string; qualifiedName: string }): boolean {
  return (
    (e.label === "ApexMethod" || e.label === "TestMethod") &&
    e.qualifiedName.startsWith("ApexMethod:")
  );
}

/** `ApexMethod:Cls.m(0)` -> `ApexClass:Cls`. */
export function owningClass(methodQname: string): string {
  const body = methodQname.slice(methodQname.indexOf(":") + 1);
  const paren = body.indexOf("(");
  const head = paren >= 0 ? body.slice(0, paren) : body;
  const dot = head.lastIndexOf(".");
  return `ApexClass:${dot >= 0 ? head.slice(0, dot) : head}`;
}

function countByLabel(reached: ReachedEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of reached) m.set(e.label, (m.get(e.label) ?? 0) + 1);
  return new Map([...m].sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Cycle 3 T3: the component a row is drawn and described as. A method is part of its class; the
 * root is itself (a method root stays a method).
 */
export function unitOf(
  e: { qualifiedName: string; label: string },
  root?: string,
): { qualifiedName: string; label: string } {
  if (e.qualifiedName === root) return e;
  return isMethodRow(e) ? { qualifiedName: owningClass(e.qualifiedName), label: "ApexClass" } : e;
}

/** The label of a qname from its `Label:` prefix ("component" when there is none). */
export const labelOfQname = (q: string): string => {
  const i = q.indexOf(":");
  return i > 0 ? q.slice(0, i) : "component";
};

export interface TraceReportOpts {
  direction: "downstream" | "upstream";
  target: string;
  depth: number;
  reached: ReachedEntry[];
  pseudo: PseudoEntry[];
  /** Row edges, as core returns them (`rowEdges ?? edges`). */
  edges: readonly { srcQualifiedName: string; dstQualifiedName: string; relType: string }[];
  truncated: boolean;
  filtered: number;
  structural: number;
  labels?: string[] | undefined;
  mermaid: boolean;
  /** The lossless text: the reach list and its notes, unchanged. */
  details: string;
}

/** The human report of a trace_downstream / trace_upstream result. */
export function traceReport(o: TraceReportOpts): string {
  const root = o.target;
  const rootLabel = labelOfQname(root);
  const down = o.direction === "downstream";
  // Pieces: counted rows (no role), drawn as their component, nearest first.
  const units = new Map<
    string,
    { qualifiedName: string; label: string; hop: number; via: string }
  >();
  for (const e of o.reached) {
    if (e.role) continue;
    const u = unitOf(e, root);
    if (u.qualifiedName === root) continue;
    const had = units.get(u.qualifiedName);
    if (!had || e.hop < had.hop)
      units.set(u.qualifiedName, { ...u, hop: e.hop, via: had?.via ?? e.relType });
  }
  const pieces = [...units.values()].sort(
    (a, b) => a.hop - b.hop || a.qualifiedName.localeCompare(b.qualifiedName),
  );
  const labelOf = new Map<string, string>(o.reached.map((e) => [e.qualifiedName, e.label]));
  // The root's own members (a flow's versions) are the root: their links are the root's links.
  const rootMembers = new Set(
    o.reached.filter((e) => e.role === "root-member").map((e) => e.qualifiedName),
  );
  const mapQ = (q: string) =>
    rootMembers.has(q)
      ? root
      : unitOf({ qualifiedName: q, label: labelOf.get(q) ?? labelOfQname(q) }, root).qualifiedName;
  const unitEdges = o.edges
    .map((e) => ({ from: mapQ(e.srcQualifiedName), to: mapQ(e.dstQualifiedName), rel: e.relType }))
    .filter((e) => e.from !== e.to);
  const known = new Set([
    root,
    ...units.keys(),
    ...o.reached.filter((e) => e.role === "standard-field").map((e) => e.qualifiedName),
  ]);
  const facts = linkFacts(unitEdges, known);

  const standard = o.reached.filter((e) => e.role === "standard-field").length;
  const steps = `up to ${o.depth} ${o.depth === 1 ? "step" : "steps"} away`;
  const who = code(nameOf(root));
  const inShort: string[] = [];
  if (pieces.length === 0) {
    inShort.push(
      down
        ? `${who} relies on no other pieces within ${o.depth} ${o.depth === 1 ? "step" : "steps"}.`
        : `No other pieces rely on ${who} within ${o.depth} ${o.depth === 1 ? "step" : "steps"}.`,
    );
  } else {
    const counts = kindCounts(pieces.map((p) => p.label));
    inShort.push(
      down
        ? `${who} relies on ${pieceCount(pieces.length)}, ${steps}: ${counts}.`
        : `${pieceCount(pieces.length)} ${pieces.length === 1 ? "relies" : "rely"} on ${who}, ${steps}: ${counts}.`.replace(
            /^./,
            (c) => c.toUpperCase(),
          ),
    );
  }
  const left: string[] = [];
  if (standard) left.push(`${standard} standard ${standard === 1 ? "field" : "fields"}`);
  if (o.pseudo.length) left.push(notCountedPhrase(o.pseudo.map((p) => p.pseudoKind)));
  if (left.length) inShort.push(`Not counted: ${andList(left)}.`);
  const notes: string[] = [];
  if (o.truncated)
    notes.push("the search stopped at its size limit, so the list may be incomplete");
  if (o.filtered)
    notes.push(
      `${o.filtered} access or guessed ${o.filtered === 1 ? "link is" : "links are"} hidden`,
    );
  if (o.labels?.length)
    notes.push("only some kinds are listed in the details (the `labels` option)");
  if (notes.length) inShort.push(`${andList(notes).replace(/^./, (c) => c.toUpperCase())}.`);

  const diagram = o.mermaid
    ? reportDiagram(
        [
          { id: root, label: rootLabel },
          ...pieces.map((p) => ({ id: p.qualifiedName, label: p.label })),
          // Standard fields are not counted, but they are real components: drawn, not described.
          ...o.reached
            .filter((e) => e.role === "standard-field")
            .map((e) => ({ id: e.qualifiedName, label: e.label })),
        ],
        unitEdges,
      )
    : undefined;

  // The In short counts a method as part of its class; the list counts each method row.
  const listed = o.reached.filter((e) => !e.role);
  const countNote =
    listed.length !== pieces.length &&
    listed.some((e) => isMethodRow(e) && e.qualifiedName !== root)
      ? methodCountNote(listed.length)
      : "";

  const next: string[] = [];
  if (o.truncated) next.push("Lower `depth` or start from a narrower piece to get the full list.");
  if (o.structural)
    next.push(
      down
        ? "Set `include_structure: true` to open objects into their fields, rules and record types."
        : "Set `include_structure: true` to also trace everything that uses the containing objects.",
    );
  if (o.filtered)
    next.push("Set `include_security: true` or `include_inferred: true` to show the hidden links.");
  if (o.pseudo.some((p) => DYNAMIC_QUERY.test(p.qualifiedName)))
    next.push("Some queries are built while the code runs; read that code with `explain_code`.");
  next.push(
    down
      ? `Run \`trace_upstream\` to see what relies on ${who} instead.`
      : `Run \`trace_downstream\` to see what ${who} relies on instead.`,
  );
  if (pieces.length) next.push("Use `explain_code` on a piece to read its code.");

  return renderReport({
    title: down ? `What ${nameOf(root)} relies on` : `What relies on ${nameOf(root)}`,
    inShort,
    diagram,
    pieces: pieces.map((p) => {
      const f = facts(p.qualifiedName);
      const any = f.callers.length + f.usedBy.length + f.callees.length + f.does.length > 0;
      return {
        name: p.qualifiedName,
        kind: p.label,
        role: pieceRole({ kind: p.label, ...f, ...(any ? {} : { via: p.via }) }),
      };
    }),
    details: countNote ? `${countNote}\n\n${o.details}` : o.details,
    next,
  });
}
