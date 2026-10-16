/**
 * SOQL grammar helpers for the regex Apex path: the field references of one
 * inline query, taken from the outer query only (parenthesised subqueries
 * and semi-joins are blanked first).
 *
 *   - SELECT list: plain identifiers and dotted paths (an alias after a
 *     field is ignored; aggregate / function items and `*` are skipped).
 *   - WHERE / HAVING: the field operand of each comparison
 *     (`F = …`, `F != …`, `F <> …`, `F < …`, `F LIKE …`, `F IN …`,
 *     `F NOT IN …`, `F INCLUDES …`, `F EXCLUDES …`), also wrapped in a date
 *     function (`CALENDAR_YEAR(F) = 2020`). Bind expressions (`:x.y`) and
 *     literal values are never fields.
 *   - GROUP BY (incl. ROLLUP / CUBE) and ORDER BY lists.
 *
 * A SELECT-list `TYPEOF Rel WHEN T THEN f1, f2 … [ELSE …] END` reads the
 * polymorphic lookup field (`What` -> `WhatId`, `Foo__r` -> `Foo__c`) of the
 * FROM object and each branch's fields on that branch's type (`typeOf`); the
 * ELSE branch's object is unknown and is skipped.
 *
 * A leading FROM alias (`FROM Contact c` … `c.Name`) is stripped. Single
 * names are `fields` of the FROM object; dotted names are relationship
 * `paths` (`Account.Name`), resolved later through lookup metadata.
 */

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const PATH_RE = new RegExp(`^${IDENT}(?:\\.${IDENT})*$`);
const CLAUSE_KW = new Set([
  "where",
  "with",
  "group",
  "order",
  "limit",
  "offset",
  "for",
  "using",
  "having",
  "all",
  "update",
]);
const NON_FIELD = new Set(["not", "and", "or", "null", "true", "false", "asc", "desc", "nulls"]);
const OP =
  "(?:=|!=|<>|<=|>=|<|>|\\bLIKE\\b|\\bNOT\\s+IN\\b|\\bIN\\b|\\bINCLUDES\\b|\\bEXCLUDES\\b)";
const CMP_RE = new RegExp(`(?<![\\w.:$])(${IDENT}(?:\\.${IDENT})*)\\s*${OP}`, "gi");
const FN_CMP_RE = new RegExp(
  `(?<![\\w.:$])${IDENT}\\s*\\(\\s*(${IDENT}(?:\\.${IDENT})*)\\s*\\)\\s*${OP}`,
  "gi",
);

export interface SoqlFieldRefs {
  /** Outer FROM object as written (namespace not stripped), or null. */
  object: string | null;
  /** Plain field names of the FROM object, first-seen order, deduped (case-insensitive). */
  fields: string[];
  /** Dotted relationship paths (`Account.Name`), first-seen order, deduped. */
  paths: string[];
  /** The plain field operands of WHERE / HAVING / GROUP BY / ORDER BY only
   *  (a subset of `fields` plus any also in the SELECT list), deduped. */
  clauseFields: string[];
  /** Fields read per WHEN type of SELECT-list `TYPEOF` blocks, one entry per type. */
  typeOf: SoqlTypeOfBranch[];
}

/** One `WHEN <object> THEN …` type of a `TYPEOF` block. */
export interface SoqlTypeOfBranch {
  object: string;
  fields: string[];
  paths: string[];
}

const TYPEOF_RE = new RegExp(`(?<![\\w.])typeof\\s+(${IDENT})\\s+([\\s\\S]*?)\\bend\\b`, "gi");
const WHEN_RE = new RegExp(
  `\\bwhen\\s+(${IDENT})\\s+then\\s+([\\s\\S]*?)(?=\\bwhen\\b|\\belse\\b|$)`,
  "gi",
);

/**
 * Replace each depth-0 `TYPEOF … END` of a SELECT list with its lookup field
 * name (`What` -> `WhatId`), keeping the list's item order, and collect the
 * WHEN branches' fields into `into`.
 */
function extractTypeOf(selectClause: string, into: SoqlTypeOfBranch[]): string {
  const flat = blankParens(selectClause);
  let out = "";
  let last = 0;
  for (const m of flat.matchAll(TYPEOF_RE)) {
    const rel = m[1] ?? "";
    const lookup = /__r$/i.test(rel) ? rel.replace(/__r$/i, "__c") : `${rel}Id`;
    out += `${selectClause.slice(last, m.index ?? 0)}${lookup}`;
    last = (m.index ?? 0) + m[0].length;
    for (const w of (m[2] ?? "").matchAll(WHEN_RE)) {
      const object = w[1] ?? "";
      let branch = into.find((b) => b.object.toLowerCase() === object.toLowerCase());
      if (!branch) {
        branch = { object, fields: [], paths: [] };
        into.push(branch);
      }
      for (const item of (w[2] ?? "").split(",")) {
        const f = item.trim();
        if (!PATH_RE.test(f)) continue;
        const list = f.includes(".") ? branch.paths : branch.fields;
        if (!list.some((x) => x.toLowerCase() === f.toLowerCase())) list.push(f);
      }
    }
  }
  return out + selectClause.slice(last);
}

/** Blank every parenthesised group (keeps length; nested subqueries vanish). */
function blankParens(s: string): string {
  let out = "";
  let depth = 0;
  for (const c of s) {
    if (c === "(") {
      depth += 1;
      out += depth === 1 ? "(" : " ";
    } else if (c === ")") {
      if (depth > 0) depth -= 1;
      out += depth === 0 ? ")" : " ";
    } else out += depth > 0 ? " " : c;
  }
  return out;
}

/** Blank only parenthesised groups that are subqueries (`(SELECT …)`). */
function blankSubqueries(s: string): string {
  const chars = s.split("");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "(" || !/^\(\s*select\b/i.test(s.slice(i))) continue;
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth += 1;
      else if (s[j] === ")" && --depth === 0) break;
    }
    for (let k = i + 1; k < j && k < s.length; k++) chars[k] = " ";
    i = j;
  }
  return chars.join("");
}

/** Index of `kw` (a keyword sequence) at paren depth 0 of `s`, or -1. */
function topLevelIndex(s: string, re: RegExp): number {
  const flat = blankParens(s);
  const m = re.exec(flat);
  return m ? m.index : -1;
}

/**
 * Field references of a query's inner text (everything after `[SELECT`, up
 * to but excluding the closing `]`).
 */
export function soqlFieldRefs(inner: string): SoqlFieldRefs {
  const fields: string[] = [];
  const paths: string[] = [];
  const clauseFields: string[] = [];
  const seenF = new Set<string>();
  const seenP = new Set<string>();
  const seenC = new Set<string>();
  let alias: string | null = null;
  const add = (raw: string, clause = false) => {
    let p = raw.trim();
    if (!PATH_RE.test(p)) return;
    const segs = p.split(".");
    if (alias && segs.length > 1 && (segs[0] ?? "").toLowerCase() === alias) {
      segs.shift();
      p = segs.join(".");
    }
    if (segs.length === 1) {
      const f = segs[0] ?? "";
      if (NON_FIELD.has(f.toLowerCase())) return;
      if (clause && !seenC.has(f.toLowerCase())) {
        seenC.add(f.toLowerCase());
        clauseFields.push(f);
      }
      if (seenF.has(f.toLowerCase())) return;
      seenF.add(f.toLowerCase());
      fields.push(f);
    } else {
      if (seenP.has(p.toLowerCase())) return;
      seenP.add(p.toLowerCase());
      paths.push(p);
    }
  };

  const typeOf: SoqlTypeOfBranch[] = [];
  const fromAt = topLevelIndex(inner, /(?<![\w.])from\s+/i);
  if (fromAt < 0) return { object: null, fields, paths, clauseFields, typeOf };
  const selectClause = extractTypeOf(inner.slice(0, fromAt), typeOf);
  const afterFrom = inner.slice(fromAt).replace(/^from\s+/i, "");
  const objM = afterFrom.match(new RegExp(`^(${IDENT}(?:\\.${IDENT})*)`));
  const object = objM?.[1] ?? null;
  if (!object) return { object: null, fields, paths, clauseFields, typeOf: [] };
  let tail = afterFrom.slice(object.length);
  const aliasM = tail.match(new RegExp(`^\\s+(?:as\\s+)?(${IDENT})\\b`, "i"));
  if (aliasM?.[1] && !CLAUSE_KW.has(aliasM[1].toLowerCase())) {
    alias = aliasM[1].toLowerCase();
    tail = tail.slice(aliasM[0].length);
  }

  // SELECT list (outer only: subquery items contain parens and are skipped).
  for (const item of blankParens(selectClause).split(",")) {
    const s = item.trim();
    if (!s || /[()*]/.test(s)) continue;
    add(s.split(/\s+/)[0] ?? "");
  }

  const body = blankSubqueries(tail);
  const flat = blankParens(body);
  const at = (re: RegExp) => {
    const m = re.exec(flat);
    return m ? m.index : -1;
  };
  const marks = [
    { kind: "where", i: at(/\bwhere\b/i) },
    { kind: "with", i: at(/\bwith\b/i) },
    { kind: "group", i: at(/\bgroup\s+by\b/i) },
    { kind: "having", i: at(/\bhaving\b/i) },
    { kind: "order", i: at(/\border\s+by\b/i) },
    { kind: "limit", i: at(/\b(?:limit|offset|for|all\s+rows|update)\b/i) },
  ]
    .filter((m) => m.i >= 0)
    .sort((a, b) => a.i - b.i);
  const clause = (kind: string): string => {
    const k = marks.findIndex((m) => m.kind === kind);
    if (k < 0) return "";
    const start = marks[k]?.i ?? 0;
    const end = marks[k + 1]?.i ?? body.length;
    return body.slice(start, end);
  };

  for (const cond of [clause("where"), clause("having")]) {
    if (!cond) continue;
    const text = cond.replace(/^\s*(?:where|having)\b/i, " ");
    const hits: Array<{ i: number; f: string }> = [];
    for (const m of text.matchAll(FN_CMP_RE)) hits.push({ i: m.index ?? 0, f: m[1] ?? "" });
    for (const m of text.matchAll(CMP_RE)) hits.push({ i: m.index ?? 0, f: m[1] ?? "" });
    hits.sort((a, b) => a.i - b.i);
    for (const h of hits) add(h.f, true);
  }
  const group = clause("group").replace(/^\s*group\s+by\b/i, " ");
  if (group.trim()) {
    const inner2 = group.replace(/\b(?:rollup|cube)\s*\(([^)]*)\)/gi, "$1");
    for (const item of inner2.split(",")) add(item.trim().split(/\s+/)[0] ?? "", true);
  }
  const order = clause("order").replace(/^\s*order\s+by\b/i, " ");
  if (order.trim()) {
    for (const item of order.split(",")) add(item.trim().split(/\s+/)[0] ?? "", true);
  }
  return { object, fields, paths, clauseFields, typeOf };
}

/** One inline query found by findInlineQueries. */
export interface InlineQuery {
  /** Offset of the opening `[`. */
  index: number;
  /** Full text from `[` to the matching `]`, inclusive. */
  text: string;
  /** Text after the start keyword, up to but excluding the closing `]`. */
  inner: string;
}

/** End of the `'…'` literal opening at `at` (index of its closing quote), or -1. */
function stringEnd(code: string, at: number): number {
  for (let j = at + 1; j < code.length; j++) {
    if (code[j] === "\\") j++;
    else if (code[j] === "'") return j;
  }
  return -1;
}

/**
 * Inline `[SELECT …]` queries (or `[FIND …]` with `keyword = "FIND"`) in
 * Apex code, in start order. A query ends at the `]` that brings bracket
 * depth back to 0, counted outside `'…'` string literals (`\'` escapes), so
 * a bind expression that indexes (`:ids[0]`, `:m.get(k)[1]`) or holds
 * another inline query does not end it early. An inline query nested in a
 * bind is returned too, after its outer query. A query whose closing
 * bracket (or a string inside it) never closes is not returned.
 *
 * Precondition: `code` has its comments masked or removed (`maskApex` or
 * `stripCommentsAndStrings`). The scanner does not recognise `//` or
 * `/* *\/` comments: on raw text a quote inside a comment (`// don't`)
 * opens a literal that swallows the queries after it, and a `]` inside a
 * comment within a query ends that query early.
 */
export function findInlineQueries(code: string, keyword = "SELECT"): InlineQuery[] {
  const out: InlineQuery[] = [];
  const startRe = new RegExp(`\\[\\s*${keyword}\\b`, "iy");
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "'") {
      // A literal outside any query: skip it (a `[SELECT` inside is text).
      const e = stringEnd(code, i);
      if (e < 0) break;
      i = e;
      continue;
    }
    if (c !== "[") continue;
    startRe.lastIndex = i;
    const head = startRe.exec(code);
    if (!head) continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < code.length; j++) {
      const d = code[j];
      if (d === "'") {
        const e = stringEnd(code, j);
        if (e < 0) break;
        j = e;
      } else if (d === "[") depth++;
      else if (d === "]" && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    out.push({
      index: i,
      text: code.slice(i, end + 1),
      inner: code.slice(i + head[0].length, end),
    });
  }
  return out;
}

/** Blank (length-preserving) the contents of every `[…]` group in `s`, brackets kept. */
export function blankBracketGroups(s: string): string {
  const chars = s.split("");
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const e = stringEnd(s, i);
      const stop = e < 0 ? s.length - 1 : e;
      if (depth > 0) for (let k = i; k <= stop; k++) if (chars[k] !== "\n") chars[k] = " ";
      i = stop;
    } else if (c === "[") {
      depth++;
      if (depth > 1) chars[i] = " ";
    } else if (c === "]" && depth > 0) {
      depth--;
      if (depth > 0) chars[i] = " ";
    } else if (depth > 0 && c !== "\n") chars[i] = " ";
  }
  return chars.join("");
}
