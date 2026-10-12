import type { OrgId } from "@ryanstark24/sfgraph-shared";
import type { NodeFact } from "../domain/index.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * Glob-pattern node lookup, case-insensitive (like every other lookup):
 *
 *   - `*` / `**`  any run of characters, dots and slashes included
 *                 (`CustomField:Account.*`, `ApexMethod:Svc*`)
 *   - `?`         a single character
 *   - `[abc]` / `[a-z]` / `[!a]`  character classes
 *   - `{a,b}`     alternatives, nesting allowed (`{a}` without a comma is
 *                 literal braces, its inner groups still expand, as in bash)
 *   - `\x`        a literal `x`
 *
 * The whole pattern, every alternative included, compiles once into one
 * position automaton (Glushkov NFA, at most one state per pattern atom) that
 * runs as a lazily built DFA: each name is one pass over its characters, and
 * each DFA transition is computed once and then reused for every name. There
 * is no backtracking (audit sec-02: picomatch compiled `*?*?…` into nested
 * lazy groups and a 30-char pattern blocked the server for 24 s; a later
 * per-alternative matcher still took 8 s on `{,}`x8 patterns).
 *
 * Limits, each failing with a clear error instead of running long:
 *   - pattern length <= MAX_GLOB_PATTERN_LENGTH;
 *   - distinct brace expansions <= MAX_GLOB_ALTERNATIVES (deduplicated, so
 *     `{,}{,}` is one alternative);
 *   - DFA construction work <= MAX_GLOB_DFA_WORK (bounds a pattern whose DFA
 *     would blow up exponentially).
 *
 * Result ordering: lexicographic by qualifiedName. The cap defaults to
 * 500 with `truncated: true` set on overflow — at that scale the agent
 * should refine the pattern rather than scan further.
 */

export const MAX_GLOB_ALTERNATIVES = 64;
export const MAX_GLOB_PATTERN_LENGTH = 512;
/** Work units (position visits) allowed for building DFA transitions. */
export const MAX_GLOB_DFA_WORK = 1_000_000;

type GlobToken =
  | { kind: "lit"; ch: string }
  | { kind: "one" }
  | { kind: "star" }
  | { kind: "class"; negate: boolean; items: Array<[string, string]> };

type GlobAst =
  | { t: "atom"; tok: GlobToken }
  | { t: "seq"; items: GlobAst[] }
  | { t: "alt"; alts: GlobAst[] };

const lit = (ch: string): GlobAst => ({ t: "atom", tok: { kind: "lit", ch: ch.toLowerCase() } });

/** Index of the `]` closing a class opened at `i`, or -1. */
function classEnd(s: string, i: number): number {
  if (s[i] !== "[") return -1;
  const end = s.indexOf("]", i + 2);
  return end > i ? end : -1;
}

/** Index of the `}` closing a brace opened at `i`, or -1. */
function braceEnd(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "[" && classEnd(s, j) > 0) j = classEnd(s, j);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return j;
  }
  return -1;
}

/** Split a brace body on its top-level commas. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (c === "\\") j++;
    else if (c === "[" && classEnd(body, j) > 0) j = classEnd(body, j);
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, j));
      start = j + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function parseGlob(s: string): GlobAst {
  const items: GlobAst[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "\\" && i + 1 < s.length) {
      items.push(lit(s[++i] as string));
    } else if (c === "*") {
      const prev = items[items.length - 1];
      if (!(prev?.t === "atom" && prev.tok.kind === "star")) {
        items.push({ t: "atom", tok: { kind: "star" } });
      }
    } else if (c === "?") {
      items.push({ t: "atom", tok: { kind: "one" } });
    } else if (c === "[" && classEnd(s, i) > 0) {
      const end = classEnd(s, i);
      let body = s.slice(i + 1, end);
      const negate = body[0] === "!" || body[0] === "^";
      if (negate) body = body.slice(1);
      const ranges: Array<[string, string]> = [];
      for (let j = 0; j < body.length; j++) {
        const lo = (body[j] as string).toLowerCase();
        if (body[j + 1] === "-" && j + 2 < body.length) {
          ranges.push([lo, (body[j + 2] as string).toLowerCase()]);
          j += 2;
        } else {
          ranges.push([lo, lo]);
        }
      }
      items.push({ t: "atom", tok: { kind: "class", negate, items: ranges } });
      i = end;
    } else if (c === "{" && braceEnd(s, i) > 0) {
      const end = braceEnd(s, i);
      const parts = splitAlternatives(s.slice(i + 1, end));
      if (parts.length === 1) {
        items.push(lit("{"), parseGlob(parts[0] as string), lit("}"));
      } else {
        items.push({ t: "alt", alts: parts.map(parseGlob) });
      }
      i = end;
    } else {
      items.push(lit(c));
    }
  }
  return { t: "seq", items };
}

const tokenKey = (tok: GlobToken): string =>
  tok.kind === "lit"
    ? `l${tok.ch}`
    : tok.kind === "class"
      ? `c${tok.negate ? "!" : ""}${tok.items.map((r) => r.join("-")).join("")}]`
      : tok.kind === "one"
        ? "?"
        : "*";

const tooManyAlternatives = () =>
  new Error(
    `glob pattern expands to more than ${MAX_GLOB_ALTERNATIVES} distinct {a,b} alternatives; use a more specific pattern`,
  );

/** Distinct brace expansions of `ast` (canonical token strings), capped. */
function expansions(ast: GlobAst): Set<string> {
  if (ast.t === "atom") return new Set([tokenKey(ast.tok)]);
  if (ast.t === "alt") {
    const out = new Set<string>();
    for (const a of ast.alts) {
      for (const e of expansions(a)) {
        out.add(e);
        if (out.size > MAX_GLOB_ALTERNATIVES) throw tooManyAlternatives();
      }
    }
    return out;
  }
  let acc = new Set<string>([""]);
  for (const item of ast.items) {
    const next = new Set<string>();
    for (const tail of expansions(item)) {
      for (const head of acc) {
        // Adjacent stars are one star.
        next.add(head.endsWith("*") && tail.startsWith("*") ? head + tail.slice(1) : head + tail);
        if (next.size > MAX_GLOB_ALTERNATIVES) throw tooManyAlternatives();
      }
    }
    acc = next;
  }
  return acc;
}

function tokenMatches(t: GlobToken, ch: string): boolean {
  switch (t.kind) {
    case "lit":
      return t.ch === ch;
    case "one":
    case "star":
      return true;
    case "class": {
      const hit = t.items.some(([lo, hi]) => ch >= lo && ch <= hi);
      return t.negate ? !hit : hit;
    }
  }
}

interface DfaState {
  accept: boolean;
  /** Active positions (the atoms that consumed the last character). */
  active: number[];
  next: Map<string, DfaState | null>;
}

/** Compile a case-insensitive glob into a predicate over qualified names. */
export function compileGlob(pattern: string): (qname: string) => boolean {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) {
    throw new Error(
      `glob pattern is longer than ${MAX_GLOB_PATTERN_LENGTH} characters; use a more specific pattern`,
    );
  }
  const ast = parseGlob(pattern);
  expansions(ast);

  // Glushkov construction: one position per atom; `follow[p]` = positions
  // that may consume the character after the one `p` consumed.
  const atoms: GlobToken[] = [];
  const follow: Array<Set<number>> = [];
  const build = (node: GlobAst): { nullable: boolean; first: number[]; last: number[] } => {
    if (node.t === "atom") {
      const p = atoms.length;
      atoms.push(node.tok);
      follow.push(new Set());
      const star = node.tok.kind === "star";
      if (star) follow[p]?.add(p);
      return { nullable: star, first: [p], last: [p] };
    }
    if (node.t === "alt") {
      const parts = node.alts.map(build);
      return {
        nullable: parts.some((x) => x.nullable),
        first: parts.flatMap((x) => x.first),
        last: parts.flatMap((x) => x.last),
      };
    }
    let acc = { nullable: true, first: [] as number[], last: [] as number[] };
    for (const item of node.items) {
      const b = build(item);
      for (const l of acc.last) for (const f of b.first) follow[l]?.add(f);
      acc = {
        nullable: acc.nullable && b.nullable,
        first: acc.nullable ? [...acc.first, ...b.first] : acc.first,
        last: b.nullable ? [...acc.last, ...b.last] : b.last,
      };
    }
    return acc;
  };
  const root = build(ast);
  const isLast = new Uint8Array(atoms.length);
  for (const p of root.last) isLast[p] = 1;
  const followArr = follow.map((f) => [...f]);
  const firstArr = [...new Set(root.first)];

  const interned = new Map<string, DfaState>();
  const intern = (active: number[], accept: boolean): DfaState => {
    const key = active.join(",");
    let st = interned.get(key);
    if (!st) {
      st = { accept, active, next: new Map() };
      interned.set(key, st);
    }
    return st;
  };
  const start: DfaState = { accept: root.nullable, active: [], next: new Map() };
  let work = 0;
  const mark = new Uint8Array(atoms.length);
  const step = (st: DfaState, ch: string): DfaState | null => {
    const candidates = st === start ? [firstArr] : st.active.map((p) => followArr[p] ?? []);
    const out: number[] = [];
    for (const list of candidates) {
      work += list.length;
      for (const q of list) {
        if (mark[q] === 0 && tokenMatches(atoms[q] as GlobToken, ch)) {
          mark[q] = 1;
          out.push(q);
        }
      }
    }
    for (const q of out) mark[q] = 0;
    if (work > MAX_GLOB_DFA_WORK) {
      throw new Error(
        "glob pattern is too complex to match efficiently; use a more specific pattern",
      );
    }
    if (out.length === 0) return null;
    out.sort((a, b) => a - b);
    return intern(
      out,
      out.some((q) => isLast[q] === 1),
    );
  };

  return (qname) => {
    const text = qname.toLowerCase();
    let st: DfaState = start;
    for (const ch of text) {
      let nx = st.next.get(ch);
      if (nx === undefined) {
        nx = step(st, ch);
        st.next.set(ch, nx);
      }
      if (nx === null) return false;
      st = nx;
    }
    return st.accept;
  };
}

export interface FindNodesOpts {
  /** When set, restrict matching to nodes of this label (e.g. `ApexClass`,
   *  `CustomField`; case-insensitive). Faster than scanning every label table when the
   *  pattern is type-anchored. */
  label?: string;
  /** Result cap. Default 500. */
  limit?: number;
}

export interface FindNodesResult {
  matches: NodeFact[];
  truncated: boolean;
  /** Total matched before truncation (when truncated=false, equals
   *  matches.length). */
  total: number;
}

export function findNodesByGlob(
  store: GraphStore,
  orgId: OrgId,
  pattern: string,
  opts: FindNodesOpts = {},
): FindNodesResult {
  const limit = Math.max(1, opts.limit ?? 500);
  const matcher = compileGlob(pattern);

  const stored = listAllLabels(store, orgId);
  // Labels are matched case-insensitively against the stored spelling.
  const labels = opts.label
    ? [stored.find((l) => l.toLowerCase() === opts.label?.toLowerCase()) ?? opts.label]
    : stored;
  const allMatches: NodeFact[] = [];

  for (const label of labels) {
    // listNodesByLabel pages internally; passing a generous cap avoids
    // truncation at the label level while still bounding memory on
    // pathologically large labels (Salesforce orgs with 50k+ ApexClass
    // nodes exist).
    const nodes = store.listNodesByLabel(orgId, label, 50_000);
    for (const n of nodes) {
      if (matcher(String(n.qualifiedName))) allMatches.push(n);
    }
  }

  allMatches.sort((a, b) => String(a.qualifiedName).localeCompare(String(b.qualifiedName)));
  const truncated = allMatches.length > limit;
  return {
    matches: truncated ? allMatches.slice(0, limit) : allMatches,
    truncated,
    total: allMatches.length,
  };
}

/**
 * List every distinct label the store knows about for this org. The
 * GraphStore interface doesn't expose this directly; we read the
 * label registry table that ensureNodeTable populates. Falls back to
 * an empty list when the store doesn't expose the helper — caller can
 * pass an explicit `label` to bypass.
 */
function listAllLabels(store: GraphStore, _orgId: OrgId): string[] {
  // The SqliteGraphStore exposes a private nodeLabelCache; we read it
  // through the public `listAllLabels()` method if present. Stores that
  // don't implement it (test mocks) return [].
  const s = store as unknown as { listAllLabels?: () => string[] };
  if (typeof s.listAllLabels === "function") return s.listAllLabels();
  return [];
}
