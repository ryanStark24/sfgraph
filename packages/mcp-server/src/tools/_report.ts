import { render } from "@ryanstark24/sfgraph-core";
import {
  KIND_SHORT,
  PLAIN_KINDS,
  layerOfKind,
  plainKind,
  plainRel,
  pluralGloss,
  spacedLower,
} from "./_plain.js";

/**
 * Cycle 3 T2: the human report every tool result is built from, for a mixed reader (a business
 * analyst and a developer). Sections, in order: `## <title>`, In short, Picture (when the picture
 * rule holds), What each piece does (at most 15 lines), Technical details (the lossless developer
 * text), What to check next. fitText (server.ts) cuts only inside Technical details.
 */

/** Mermaid source (no fence), as `reportDiagram` returns it. */
export type MermaidSpec = string;

export interface HumanReport {
  title: string; // "What CaseTrigger depends on"
  inShort: string[]; // 1-4 plain sentences: the answer, counts in words, certainty
  diagram?: MermaidSpec | undefined; // nodes with friendly labels, focused on the key path, ≤ 25 nodes
  pieces?: Piece[]; // "What each piece does": one plain line per main component
  details: string; // today's lossless technical text, unchanged in content
  next?: string[]; // "What to check next": plain suggestions, each naming the tool option
}
export interface Piece {
  name: string;
  kind: string;
  role: string;
}

/** The section headings, exactly as fitText and the jargon lint look for them. */
export const HEADINGS = {
  inShort: "**In short**",
  picture: "**Picture**",
  pieces: "**What each piece does**",
  details: "**Technical details**",
  next: "**What to check next**",
} as const;

export const PIECES_MAX = 15;
export const DIAGRAM_MAX = 25;
const NAMES_MAX = 3;
/** A merged piece line names every piece in it: the line holds at most PIECES_MAX, and a name left
 *  out of What each piece does is a component the reader misses (cycle 3 T9 fix 2). */
const MERGED_NAMES_MAX = PIECES_MAX;

/** `Foo` for `ApexClass:Foo`; a name with no `Label:` prefix is kept. */
export function nameOf(qnameOrName: string): string {
  const m = /^([A-Za-z][A-Za-z0-9_]*):(.+)$/.exec(qnameOrName);
  // A known label, or a label-shaped (PascalCase) prefix such as an opaque `EntityFilter:`; a
  // lowercase namespace such as `c:myCmp` or `lightning:card` is part of the name.
  if (m && (m[1]! in PLAIN_KINDS || /^[A-Z][A-Za-z0-9]+$/.test(m[1]!))) return m[2]!;
  return qnameOrName;
}

/** One line: any run of whitespace holding a newline becomes one space. */
export const oneLine = (t: string): string => t.replace(/\s*\n\s*/g, " ");

/** Free text safe in a markdown table cell: one line, `|` escaped, backticks made quotes. */
export const tableCell = (t: string): string =>
  t.replace(/\s+/g, " ").trim().replace(/`/g, "'").replace(/\|/g, "\\|");

/** An API name in code style; a backtick inside it becomes a quote so the span stays closed. */
export const code = (name: string): string => `\`${name.replace(/`/g, "'")}\``;

/** "`A`, `B`, `C` and 2 others". */
function nameList(names: readonly string[], max = NAMES_MAX): string {
  // "and 1 other" takes as much room as the name it hides, so one over the limit is named (fix 3).
  const shown = names
    .slice(0, names.length === max + 1 ? max + 1 : max)
    .map((n) => code(nameOf(n)));
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** Containment links: drawn dotted, and told as "part of" rather than as a use. */
const STRUCTURAL = new Set([
  "CONTAINS",
  "CONTAINS_METHOD",
  "CONTAINS_COMPONENT",
  "DEFINES_FIELD",
  "HAS_RECORD_TYPE",
  "HAS_VALIDATION_RULE",
]);
export const isStructuralRel = (rel: string): boolean => STRUCTURAL.has(rel);

/** An incoming link in the passive voice: "read by", "written by", "part of". */
function passiveOf(rel: string, kind?: string): string {
  if (STRUCTURAL.has(rel)) return "part of";
  if (rel === "INSTANCE_OF" && kind === "ApexClass") return "created by";
  if (/READS_FIELD$/.test(rel)) return "read by";
  if (/WRITES_FIELD$|UPDATES_FIELD$/.test(rel)) return "written by";
  if (/BINDS_|RENDERS_FIELD/.test(rel)) return "shown by";
  if (/^(QUERIES|EXECUTES_SOQL|EXECUTES_SOSL)$/.test(rel)) return "looked up by";
  if (rel === "EXECUTES_DML") return "saved by";
  if (rel === "IS_TEST_FOR") return "tested by";
  if (rel === "EXTENDS") return "extended by";
  if (rel === "IMPLEMENTS") return "implemented by";
  if (/^GRANTS/.test(rel)) return "given access by";
  return "used by";
}
const isTriggerRel = (rel: string): boolean => rel === "TRIGGERS_ON" || rel === "TRIGGER_FIRES_ON";

/**
 * One plain sentence on a piece, from graph facts only: its kind, the link that reached it, and its
 * direct callers and callees (at most 3 of each named). No facts: "role not recorded in the graph.".
 * `into` lists the links into it that are not calls, by relationship type ("read by `CaseService`",
 * "the trigger `CaseTrigger` runs when `Case` records change"); without it, `usedBy` names them
 * as one "used by". `does` lists its own links that are not calls ("it reads the field
 * `Priority__c`"). With its `name`, a field says which object it is on.
 */
export function pieceRole(facts: {
  kind: string;
  name?: string;
  via?: string;
  callers?: string[];
  callees?: string[];
  usedBy?: string[];
  into?: { rel: string; names: string[] }[];
  does?: { rel: string; names: string[] }[];
}): string {
  const callers = facts.callers ?? [];
  const callees = facts.callees ?? [];
  const does = (facts.does ?? []).filter((d) => d.names.length > 0);
  const kind = facts.kind ? plainKind(facts.kind) : "";
  // A field's object, from its name (`CustomField:Case.Priority__c` is on `Case`).
  const fieldOn =
    facts.kind === "CustomField" && facts.name && nameOf(facts.name).includes(".")
      ? nameOf(facts.name).split(".")[0]!
      : undefined;
  const passive = new Map<string, string[]>();
  const triggers: string[] = [];
  if (facts.into) {
    for (const i of facts.into) {
      const names = i.names.filter((q) => !(fieldOn && q === `CustomObject:${fieldOn}`));
      if (!names.length) continue;
      if (isTriggerRel(i.rel)) {
        triggers.push(...names.filter((q) => !triggers.includes(q)));
        continue;
      }
      const phrase = passiveOf(i.rel, facts.kind);
      const g = passive.get(phrase) ?? passive.set(phrase, []).get(phrase)!;
      for (const q of names) if (!g.includes(q) && !callers.includes(q)) g.push(q);
    }
  } else if (facts.usedBy?.length) passive.set("used by", [...facts.usedBy]);
  for (const [k, v] of passive) if (!v.length) passive.delete(k);
  if (
    !facts.via &&
    !callers.length &&
    !callees.length &&
    !passive.size &&
    !triggers.length &&
    !does.length
  ) {
    if (fieldOn) return `${kind || "Field"} on ${code(fieldOn)}.`;
    return kind ? `${kind}; role not recorded in the graph.` : "role not recorded in the graph.";
  }
  const parts: string[] = [];
  let head = kind || "A component";
  if (fieldOn) head += ` on ${code(fieldOn)}`;
  if (facts.via) head += `, reached through a "${plainRel(facts.via)}" link`;
  if (callers.length) head += `, called by ${nameList(callers)}`;
  for (const [phrase, names] of passive) head += `, ${phrase} ${nameList(names)}`;
  parts.push(head);
  if (triggers.length) {
    const on = facts.name ? code(nameOf(facts.name)) : "its";
    // A flow can run on record changes too: name what each one is.
    const flows = triggers.every((q) => labelIn(q) === "Flow");
    const mixed = !flows && triggers.some((q) => labelIn(q) === "Flow");
    const one = triggers.length === 1;
    const what = mixed
      ? "the triggers and flows"
      : `the ${flows ? "flow" : "trigger"}${one ? "" : "s"}`;
    parts.push(`${what} ${nameList(triggers)} ${one ? "runs" : "run"} when ${on} records change`);
  }
  const acts: string[] = [];
  if (callees.length) acts.push(`calls ${nameList(callees)}`);
  for (const d of does.slice(0, NAMES_MAX))
    acts.push(`${plainRel(d.rel, facts.kind)} ${nameList(d.names)}`);
  if (does.length > NAMES_MAX) acts.push(`has ${does.length - NAMES_MAX} other kinds of link`);
  if (acts.length) parts.push(`it ${andList(acts)}`);
  return `${parts.join("; ")}.`;
}

/**
 * How a set of pieces stands for Apex tests, true to what a test can cover: "1 Apex trigger has no
 * test, 1 is covered by a test and 1 is a test class; 1 flow and 1 Lightning web component cannot
 * carry Apex test coverage". Only Apex classes and triggers that are not tests count as having no
 * test. `noTest` and `notApplicable` are labels; `word` is "test" or "tests".
 */
export function testSplit(
  o: {
    noTest: readonly string[];
    covered: number;
    tests: number;
    notApplicable: readonly string[];
  },
  word: "test" | "tests" = "test",
): string {
  const parts: string[] = [];
  const n = o.noTest.length;
  if (n) parts.push(`${kindCounts(o.noTest)} ${n === 1 ? "has" : "have"} no ${word}`);
  if (o.covered)
    parts.push(
      `${o.covered} ${o.covered === 1 ? "is" : "are"} covered by ${word === "test" ? "a test" : "tests"}`,
    );
  if (o.tests) parts.push(`${o.tests} ${o.tests === 1 ? "is a test class" : "are test classes"}`);
  // The kinds that cannot carry coverage, named in full (with their gloss on first use), apart
  // from the counts above by a semicolon.
  const na = o.notApplicable.length;
  const apart = na ? `${kindCounts(o.notApplicable)} cannot carry Apex test coverage` : "";
  return [andList(parts), apart].filter(Boolean).join("; ");
}

/** "a field", "an Apex trigger", "an OmniScript": a kind with its article. */
export const aOrAn = (kind: string): string => `${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind}`;

/**
 * The line that opens Technical details when its list counts Apex methods one by one while the
 * report above counts each method as part of its class (so the two totals differ).
 */
export const methodCountNote = (listed: number): string =>
  `The list below counts each Apex method on its own (a method is part of its class above), so it shows ${listed} ${listed === 1 ? "entry" : "entries"}.`;

/** "a", "a and b", "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A call-like relationship type (a call, a run or an invocation), told apart from a use. */
export const isCallRel = (rel: string): boolean => /CALL|INVOKE|RUNS?_/.test(rel);

/** Product names keep their capital mid-sentence ("Apex class"); common words do not ("field"). */
const PROPER =
  /^(Apex|Lightning|Visualforce|Aura|Omni|OmniScript|Integration|DataRaptor|FlexCard|Agent)s?\b/;
const midSentence = (kind: string): string =>
  PROPER.test(kind) ? kind : kind.charAt(0).toLowerCase() + kind.slice(1);

/** A label in plain words for the middle of a sentence: "field", "Apex class (server code)". */
export const kindInText = (label: string, opts: { plural?: boolean } = {}): string =>
  midSentence(plainKind(label, opts));

/** "1 Apex class (server code)" / "2 Apex classes (server code)" / "2 fields". */
export const countOf = (n: number, label: string): string =>
  `${n} ${kindInText(label, { plural: n !== 1 })}`;

/**
 * Counts by kind in plain words, the largest first: "2 Apex classes (server code), 2 fields and 1
 * object (a table of records)". Over `max` kinds, the rest are one "N other pieces".
 */
export function kindCounts(labels: readonly string[], max = 4): string {
  const m = new Map<string, number>();
  for (const l of labels) m.set(l, (m.get(l) ?? 0) + 1);
  const sorted = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, sorted.length > max ? max - 1 : max).map(([l, n]) => countOf(n, l));
  const rest = sorted.slice(shown.length).reduce((s, [, n]) => s + n, 0);
  if (rest > 0) shown.push(`${rest} other ${rest === 1 ? "piece" : "pieces"}`);
  return andList(shown);
}

/** "1 piece" / "3 pieces". */
export const pieceCount = (n: number): string => `${n} ${n === 1 ? "piece" : "pieces"}`;

/**
 * `A, B, C and N more`: a list cut at `max`, saying how many were left out. One over `max` is
 * named instead: "and 1 more" takes as much room as the name it hides (as in nameList).
 */
export function listWithMore(items: readonly string[], max: number, sep = ", "): string {
  if (items.length <= max + 1) return items.join(sep);
  return `${items.slice(0, max).join(sep)} and ${items.length - max} more`;
}

/** Plain words for each kind of not-counted endpoint: [singular, plural]. */
const PSEUDO_PLAIN: Readonly<Record<string, [string, string]>> = {
  "apex-platform": ["call to built-in Salesforce code", "calls to built-in Salesforce code"],
  dml: ["record save or delete", "record saves or deletes"],
  "lwc-property": ["screen value", "screen values"],
  "lwc-event": ["screen event", "screen events"],
  "remote-duplicate": [
    "repeat entry for server code already listed",
    "repeat entries for server code already listed",
  ],
  "managed-package": [
    "part of an installed managed package",
    "parts of installed managed packages",
  ],
};

/** "3 calls to built-in Salesforce code and 1 record save or delete", by kind, in a fixed order. */
export function notCountedPhrase(kinds: readonly string[]): string {
  const m = new Map<string, number>();
  for (const k of kinds) m.set(k, (m.get(k) ?? 0) + 1);
  const order = Object.keys(PSEUDO_PLAIN);
  return andList(
    [...m]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([k, n]) => {
        const w = PSEUDO_PLAIN[k] ?? [spacedLower(k), spacedLower(k)];
        return `${n} ${n === 1 ? w[0] : w[1]}`;
      }),
  );
}

/** A piece name for prose: the name in code style, its label prefix dropped. */
export const shown = (qname: string): string => code(nameOf(qname));

/** "the Apex class `CaseService`": a piece in prose, kind first (no gloss). */
export const theKind = (label: string, qname: string): string =>
  `the ${midSentence(KIND_SHORT[label] ?? (spacedLower(label) || "component"))} ${shown(qname)}`;

/**
 * Roles for pieces from the links among them: each piece's callers and users (links into it) and
 * its own calls and other links (links out of it), from `edges` whose ends are in `known`.
 */
export function linkFacts(
  edges: readonly { from: string; to: string; rel: string }[],
  known: ReadonlySet<string>,
): (id: string) => {
  name: string;
  callers: string[];
  usedBy: string[];
  into: { rel: string; names: string[] }[];
  callees: string[];
  does: { rel: string; names: string[] }[];
} {
  const into = new Map<string, { from: string; rel: string }[]>();
  const out = new Map<string, { to: string; rel: string }[]>();
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to)) continue;
    const k = `${e.from}\u0000${e.to}\u0000${e.rel}`;
    if (seen.has(k)) continue;
    seen.add(k);
    (into.get(e.to) ?? into.set(e.to, []).get(e.to)!).push({ from: e.from, rel: e.rel });
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push({ to: e.to, rel: e.rel });
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  return (id) => {
    const ins = into.get(id) ?? [];
    const outs = out.get(id) ?? [];
    const callers = uniq(ins.filter((e) => isCallRel(e.rel)).map((e) => e.from));
    const usedBy = uniq(ins.filter((e) => !isCallRel(e.rel)).map((e) => e.from)).filter(
      (q) => !callers.includes(q),
    );
    const callees = uniq(outs.filter((e) => isCallRel(e.rel)).map((e) => e.to));
    const byRel = new Map<string, string[]>();
    for (const e of outs) {
      if (isCallRel(e.rel)) continue;
      const verb = plainRel(e.rel, labelIn(id));
      const g = byRel.get(verb);
      if (g) {
        if (!g.includes(e.to)) g.push(e.to);
      } else byRel.set(verb, [e.to]);
    }
    // Grouped by the plain verb, so two relationship types that read the same are one phrase.
    const relOf = new Map(outs.map((e) => [plainRel(e.rel, labelIn(id)), e.rel]));
    const does = [...byRel].map(([verb, names]) => ({ rel: relOf.get(verb)!, names }));
    // Links into it that are not calls, by relationship type, in the order met.
    const intoBy = new Map<string, string[]>();
    for (const e of ins) {
      if (isCallRel(e.rel)) continue;
      const g = intoBy.get(e.rel) ?? intoBy.set(e.rel, []).get(e.rel)!;
      if (!g.includes(e.from)) g.push(e.from);
    }
    return {
      name: id,
      callers,
      usedBy,
      into: [...intoBy].map(([rel, names]) => ({ rel, names })),
      callees,
      does,
    };
  };
}

/** The label in a qname's `Label:` prefix, if any. */
const labelIn = (q: string): string | undefined => {
  const i = q.indexOf(":");
  return i > 0 ? q.slice(0, i) : undefined;
};

/** Technical-details lines listing links in full: "- `A` -> `B` (CALLS)", capped with a count. */
export function linkLines(
  edges: readonly { from: string; to: string; rel?: string | undefined }[],
  cap = 100,
): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of edges) {
    const line = `- ${e.from} -> ${e.to}${e.rel ? ` (${e.rel})` : ""}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const more = lines.length - cap;
  return more > 0
    ? [...lines.slice(0, cap), `- _and ${more} more (narrow the call to see them)_`]
    : lines;
}

/** A mermaid edge label: plain words with no character that ends the `|...|` span. */
const edgeText = (rel: string, fromLabel?: string): string =>
  plainRel(rel, fromLabel)
    .replace(/[|"[\](){}<>;#]/g, " ")
    .trim();

/**
 * A focused `flowchart LR` of the nodes (`id` a qname, `label` its node label) and their links, or
 * undefined when the picture rule says no: 2 or fewer components, all in one layer. Over `max`
 * nodes (default 25), the nodes nearest the first node (breadth-first) are kept and a note node
 * counts the rest. Node ids are generated (n0, n1, ...); node text is `Kind: Name`; containment
 * links are dotted.
 */
export function reportDiagram(
  nodes: { id: string; label: string }[],
  edges: { from: string; to: string; rel: string }[],
  opts: { max?: number } = {},
): string | undefined {
  const max = Math.max(1, opts.max ?? DIAGRAM_MAX);
  const byId = new Map<string, { id: string; label: string }>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const all = [...byId.values()];
  const layers = new Set(all.map((n) => layerOfKind(n.label)));
  if (all.length <= 2 && layers.size <= 1) return undefined;

  const links = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  let kept = all;
  if (all.length > max) {
    const adj = new Map<string, string[]>();
    for (const e of links) {
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
      (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
    }
    const seen = new Set<string>([all[0]!.id]);
    const order: string[] = [all[0]!.id];
    for (let i = 0; i < order.length && order.length < max; i++)
      for (const nb of adj.get(order[i]!) ?? []) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        order.push(nb);
      }
    for (const n of all) if (!seen.has(n.id)) order.push(n.id);
    kept = order.slice(0, max).map((id) => byId.get(id)!);
  }
  const ids = new Map(kept.map((n, i) => [n.id, `n${i}`]));
  const out = ["flowchart LR"];
  for (const n of kept) {
    const kind = KIND_SHORT[n.label] ?? (spacedLower(n.label) || "component");
    out.push(`  ${ids.get(n.id)}[${render.fenceLabel(`${kind}: ${nameOf(n.id)}`)}]`);
  }
  if (all.length > kept.length) out.push(`  nMore["and ${all.length - kept.length} more"]`);
  // One link per pair of boxes, naming each kind of link between them in the order met; it is
  // dotted only when every link of the pair is containment.
  const pairs = new Map<string, { a: string; b: string; texts: string[]; structural: boolean }>();
  for (const e of links) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (!a || !b) continue;
    const k = `${a} ${b}`;
    const p = pairs.get(k) ?? pairs.set(k, { a, b, texts: [], structural: true }).get(k)!;
    const text = edgeText(e.rel, byId.get(e.from)?.label);
    if (text && !p.texts.includes(text)) p.texts.push(text);
    if (!STRUCTURAL.has(e.rel)) p.structural = false;
  }
  for (const { a, b, texts, structural } of pairs.values()) {
    const arrow = structural ? "-.->" : "-->";
    const text = andList(texts);
    out.push(text ? `  ${a} ${arrow}|${text}| ${b}` : `  ${a} ${arrow} ${b}`);
  }
  return out.join("\n");
}

/** Each gloss (singular and plural) as " (gloss)", mapped to its singular form. */
const GLOSSES: ReadonlyMap<string, string> = new Map(
  Object.values(PLAIN_KINDS).flatMap((e) =>
    e.gloss
      ? [[` (${e.gloss})`, e.gloss] as const, [` (${pluralGloss(e.gloss)})`, e.gloss] as const]
      : [],
  ),
);
const GLOSS_RE = new RegExp(
  [...GLOSSES.keys()]
    .sort((a, b) => b.length - a.length)
    .map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "g",
);

/** Drops a kind's gloss after its first use across `texts` (the house style: define on first use). */
function glossOnce(texts: string[]): string[] {
  const seen = new Set<string>();
  return texts.map((t) =>
    t.replace(GLOSS_RE, (m) => {
      const key = GLOSSES.get(m) ?? m;
      if (seen.has(key)) return "";
      seen.add(key);
      return m;
    }),
  );
}

/** The text holds a count: a whole number token outside `code` spans. */
function hasCount(text: string): boolean {
  return /(?:^|[\s(])\d+(?=[\s.,;:)]|$)/.test(text.replace(/`[^`]*`/g, ""));
}

/** The report as markdown, sections in the fixed order. */
export function renderReport(r: HumanReport): string {
  // Pieces of one kind whose sentence is the same are one line ("`a`, `b` and `c`: Lightning web
  // components; each shows ..."), placed where the first of them is.
  const groups = new Map<string, Piece[]>();
  for (const p of (r.pieces ?? []).slice(0, PIECES_MAX)) {
    const said = oneLine(p.role);
    const kind = p.kind ? plainKind(p.kind) : "";
    const mergeable = kind && said.toLowerCase().startsWith(kind.toLowerCase());
    const key = mergeable ? `${p.kind}\u0000${said}` : `\u0001${groups.size}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  }
  const pieceLines: string[] = [];
  for (const g of groups.values()) {
    const p = g[0]!;
    const kind = p.kind ? plainKind(p.kind) : "";
    const said = oneLine(p.role);
    if (g.length > 1) {
      const rest = said
        .slice(kind.length)
        .replace(/^; it /, "; each ")
        .replace(/^, (?!each )/, ", each ")
        // A count in a merged line is per piece, not a total ("Apex classes, each with 2 ...").
        // Only a standalone number outside code spans counts: `Handler2` is a name, not a count.
        .replace(/^ (?=\S)/, (m, _i, all: string) => (hasCount(all) ? ", each " : m));
      const names = nameList(
        g.map((x) => oneLine(x.name)),
        MERGED_NAMES_MAX,
      );
      pieceLines.push(`- ${names}: ${plainKind(p.kind, { plural: true })}${rest}`);
      continue;
    }
    const role =
      kind && !said.toLowerCase().startsWith(kind.toLowerCase()) ? `${kind}: ${said}` : said;
    pieceLines.push(`- ${code(oneLine(nameOf(p.name)))}: ${role}`);
  }
  // Each section glosses a kind on its own first use: In short, then the pieces apart.
  const [inShort = ""] = glossOnce([r.inShort.map(oneLine).join(" ")]);
  const lines = glossOnce(pieceLines);
  const out: string[] = [`## ${oneLine(r.title)}`, "", HEADINGS.inShort, inShort];
  if (r.diagram) out.push("", HEADINGS.picture, "", "```mermaid", r.diagram, "```");
  const pieces = r.pieces ?? [];
  if (pieces.length) {
    out.push("", HEADINGS.pieces, ...lines);
    if (pieces.length > PIECES_MAX)
      out.push(`- and ${pieces.length - PIECES_MAX} more, listed under Technical details`);
  }
  out.push("", HEADINGS.details, "", r.details);
  const next = r.next ?? [];
  if (next.length) out.push("", HEADINGS.next, ...next.map((n) => `- ${oneLine(n)}`));
  return out.join("\n");
}

/**
 * The house style, sent as the MCP server's `instructions` and in the `present_for_people` prompt.
 * At most 1,200 characters; no tool names and no internal constants.
 */
export const PRESENTATION_GUIDE = [
  "Present these results for a mixed team: a business analyst and a developer.",
  "1. Lead with the answer in plain words: what was found, counts in words, and how sure it is. Every count must match the list you give.",
  "2. List only pieces on the path asked about, not every piece a result names.",
  "3. When 3 or more components or 2 or more layers (screen, logic, data) are involved, include one focused mermaid diagram of the main path, at most 12 boxes.",
  "4. Say once, in one plain line, what each main piece does: its business purpose and what its code decides or writes; never repeat it. When a result can show a piece's code, read it first.",
  '5. Define every Salesforce or Vlocity term on first use, as "an OmniScript (a guided screen flow)"; spell out short forms such as SOQL or DML; say "steps away", not "hops".',
  "6. Put full technical names, in code style, in a final technical section, each once.",
  "7. Say what was not checked in terms of the code, not your own steps or tools, and what to check next.",
  "Write only the finished answer: no drafting notes. Each result holds these sections (In short, Picture, What each piece does, Technical details, What to check next); build on them, do not paste them.",
].join("\n");

/** The fill-in-the-blank outline the prompt adds to the guide. */
export const PRESENTATION_OUTLINE = [
  "## <a title that answers the question>",
  "**In short**",
  "<1 to 4 plain sentences: the answer, counts in words, how sure it is>",
  "**Picture**",
  "<one mermaid diagram, only when 3 or more components or 2 or more layers are involved>",
  "**What each piece does**",
  "- `<API name>`: <what it does, in plain words>",
  "**Technical details**",
  "<full API names and lists>",
  "**What to check next**",
  "- <what was not checked; a next step>",
].join("\n");

/**
 * A utility tool's text: one plain In short line on top of its unchanged text, with no other
 * sections (cycle 3: utility tools get a plain "In short" line only).
 */
export const withInShort = (line: string, text: string): string =>
  `${HEADINGS.inShort}\n${oneLine(line)}\n\n${text}`;

/** "1 spot" / "3 spots": a count and its noun, the plural when it is not 1. */
export const countNoun = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Cycle 3 T5: caveats about results that used to sit in tool descriptions (sent on every call);
 * they now go in the results they describe, under What to check next.
 */
export const NOTES = {
  triggerCoverage:
    "Triggers show as not covered: `IS_TEST_FOR` links test classes to classes only, and trigger coverage via DML is not modelled.",
  componentLevel:
    "Changes are counted per component: a method as its class, a Flow version as its Flow, an LWC file as its component.",
} as const;
