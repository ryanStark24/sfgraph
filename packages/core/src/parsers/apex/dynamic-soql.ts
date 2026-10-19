/**
 * Dynamic SOQL literal folding. Finds code-level string literals whose text
 * starts with SELECT and folds the `+` concatenation they head
 * (`'SELECT a, ' + fields + ' FROM X'`), plus directly following
 * `q += …;` statements when the literal initialises/assigns `q`.
 * Non-literal operands become PLACEHOLDER (glued to its neighbours, never
 * padded with spaces), so a query whose FROM object or a
 * field name is computed fails the identifier checks downstream and is
 * skipped (conservative). Comments are never scanned.
 * One exception: a variable right after `FROM`, inside a block guarded by
 * `if (v == 'Name')` (see guardedValue), is folded as the guard's literal.
 */

import { STANDARD_SOBJECT_WHITELIST } from "../../domain/index.js";
import { soqlFieldRefs } from "./soql-fields.js";

/** Stands in for a non-literal operand in a folded query. */
export const PLACEHOLDER = "\u0001";

/** Length-preserving mask: comment text and string contents become spaces (quotes kept). */
export function maskApex(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const s = i;
      while (i < src.length && src[i] !== "\n") i++;
      blank(s, i);
    } else if (c === "/" && d === "*") {
      const s = i;
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, src.length);
      blank(s, i);
    } else if (c === "'") {
      const s = ++i;
      while (i < src.length && src[i] !== "'") i += src[i] === "\\" ? 2 : 1;
      blank(s, i);
      i++;
    } else i++;
  }
  return out.join("");
}

function unescapeApex(raw: string): string {
  return raw.replace(/\\(.)/g, (_m, ch: string) =>
    ch === "n" || ch === "t" || ch === "r" ? " " : ch,
  );
}

/**
 * Fold every SELECT-headed concatenation in `src` (raw Apex, comments and
 * strings intact). Returns the folded query texts, whitespace-normalised.
 */
export function foldDynamicSoql(src: string): string[] {
  const masked = maskApex(src);
  // In the mask, quotes survive in strict open/close pairs.
  const close = new Map<number, number>();
  let open = -1;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== "'") continue;
    if (open < 0) open = i;
    else {
      close.set(open, i);
      open = -1;
    }
  }
  const literal = (at: number) => unescapeApex(src.slice(at + 1, close.get(at)));
  const skipWs = (i: number) => {
    let j = i;
    while (j < masked.length && /\s/.test(masked[j] ?? "")) j++;
    return j;
  };
  // Consume one non-literal operand; stops at a depth-0 `+ ; , ) } ]`.
  const operandEnd = (from: number): number => {
    let d = 0;
    for (let j = from; j < masked.length; j++) {
      const c = masked[j];
      if (c === "(" || c === "[" || c === "{") d++;
      else if (c === ")" || c === "]" || c === "}") {
        if (d === 0) return j;
        d--;
      } else if (d === 0 && (c === "+" || c === ";" || c === ",")) return j;
      else if (c === "'") j = close.get(j) ?? j;
    }
    return masked.length;
  };
  const consumed = new Set<number>();
  let guards: Guards | undefined;
  // A non-literal operand: PLACEHOLDER, or the guard's literal for a plain
  // variable right after `FROM` (cycle 3 T7).
  const operandText = (k: number, e: number, before: string): string => {
    const v = src.slice(k, e).trim();
    if (!/\bfrom\s*$/i.test(before) || !/^[A-Za-z_]\w*$/.test(v)) return PLACEHOLDER;
    guards ??= guardIndex(masked);
    return guardedValue(masked, src, guards, v, k) ?? PLACEHOLDER;
  };
  // Fold `<operand> (+ <operand>)*` starting at `from`; returns [text, endIdx].
  const foldExpr = (from: number, first: string): [string, number] => {
    let text = first;
    let pos = from;
    for (;;) {
      const j = skipWs(pos);
      if (masked[j] !== "+" || masked[j + 1] === "=" || masked[j + 1] === "+") return [text, j];
      const k = skipWs(j + 1);
      if (masked[k] === "'" && close.has(k)) {
        consumed.add(k);
        text += literal(k);
        pos = (close.get(k) ?? k) + 1;
      } else {
        const e = operandEnd(k);
        if (e === k) return [text, j];
        text += operandText(k, e, text);
        pos = e;
      }
    }
  };

  const out: string[] = [];
  for (const [at, end] of close) {
    if (consumed.has(at)) continue;
    const head = literal(at);
    if (!/^\s*select\b/i.test(head)) continue;
    let [text, stop] = foldExpr(end + 1, head);
    // `q = 'SELECT …' …;` followed by `q += …;` statements.
    const lhs = masked
      .slice(Math.max(0, at - 200), at)
      .match(/([A-Za-z_]\w*)\s*(?<![=!<>+\-*/])=\s*$/);
    const v = lhs?.[1];
    if (v) {
      const contRe = new RegExp(`^\\s*${v}\\s*\\+=\\s*`, "i");
      while (masked[skipWs(stop)] === ";") {
        const rest = masked.slice(skipWs(stop) + 1);
        const c = rest.match(contRe);
        if (!c) break;
        const k = skipWs(stop) + 1 + c[0].length;
        let piece: string;
        let next: number;
        if (masked[k] === "'" && close.has(k)) {
          consumed.add(k);
          piece = literal(k);
          next = (close.get(k) ?? k) + 1;
        } else {
          const e = operandEnd(k);
          if (e === k) break;
          piece = operandText(k, e, text);
          next = e;
        }
        const [t2, s2] = foldExpr(next, piece);
        text += t2;
        stop = s2;
      }
    }
    out.push(text.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** Each `(` / `{` index in `masked` to the index of its matching close. */
function bracketPairs(masked: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(" || c === "{") stack.push(i);
    else if (c === ")" || c === "}") {
      const o = stack.pop();
      if (o !== undefined) pairs.set(o, i);
    }
  }
  return pairs;
}

/** The bracket pairs of a masked text and the `(` of each `if (`, in order. */
type Guards = { pairs: Map<number, number>; ifOpens: number[] };

function guardIndex(masked: string): Guards {
  const ifOpens = [...masked.matchAll(/\bif\s*\(/gi)].map((m) => (m.index ?? 0) + m[0].length - 1);
  return { pairs: bracketPairs(masked), ifOpens };
}

/**
 * Splits a condition on depth-0 `&&`; null when it has a depth-0 `||` or `?`.
 * The split points come from `masked` (string contents and comments blanked),
 * so a `(`, `||` or `&&` inside a literal does not count; the parts are cut
 * from `cond` at the same offsets.
 */
function conjuncts(masked: string, cond: string): string[] | null {
  const out: string[] = [];
  let d = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i] ?? "";
    if (ch === "(") d++;
    else if (ch === ")") d--;
    if (d === 0 && (masked.startsWith("||", i) || ch === "?")) return null;
    if (d === 0 && masked.startsWith("&&", i)) {
      out.push(cond.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  out.push(cond.slice(start));
  return out.map((c) => c.trim());
}

/**
 * The literal a variable must equal at `pos` (cycle 3 T7): the innermost
 * `if (…) { … }` enclosing `pos` whose condition has a conjunct
 * `v == 'X'`, `'X' == v`, `v.equals('X')` or `v.equalsIgnoreCase('X')`
 * (no `||`), with no assignment to `v` (`=`, `+=` and the like) between the
 * block's `{` and `pos`. Null otherwise. `masked` is maskApex(`src`), `guards`
 * its guardIndex, and `name` (`v`) a plain identifier.
 *
 * Known limit: an assignment after `pos` inside a loop in the block (the next
 * pass queries another object) is not seen.
 */
function guardedValue(
  masked: string,
  src: string,
  guards: Guards,
  name: string,
  pos: number,
): string | null {
  const { pairs, ifOpens } = guards;
  const lit = "'([^'\\\\]*)'";
  const forms = [
    new RegExp(`^${name}\\s*==\\s*${lit}$`, "i"),
    new RegExp(`^${lit}\\s*==\\s*${name}$`, "i"),
    new RegExp(`^${name}\\s*\\.\\s*equals(?:IgnoreCase)?\\s*\\(\\s*${lit}\\s*\\)$`, "i"),
  ];
  const assigned = new RegExp(`(?<![\\w.])${name}\\s*(?:[-+*/%|&^]|<<|>>>?)?=(?!=)`, "i");
  for (let i = ifOpens.length - 1; i >= 0; i--) {
    const open = ifOpens[i] ?? -1;
    if (open < 0 || open >= pos) continue;
    const shut = pairs.get(open) ?? -1;
    if (shut < 0 || shut > pos) continue;
    let b = shut + 1;
    while (b < masked.length && /\s/.test(masked[b] ?? "")) b++;
    if (masked[b] !== "{") continue;
    const end = pairs.get(b) ?? -1;
    if (end < pos) continue;
    const parts = conjuncts(masked.slice(open + 1, shut), src.slice(open + 1, shut));
    let value: string | null = null;
    for (const c of parts ?? []) {
      for (const f of forms) {
        const hit = c.match(f);
        if (hit) value = hit[1] ?? null;
      }
    }
    if (value === null) continue;
    return assigned.test(masked.slice(b, pos)) ? null : value;
  }
  return null;
}

const CUSTOM_OBJECT_RE = /__(c|mdt|e|x|b|kav|share|history|feed)$/i;
const STANDARD_LOWER = new Set([...STANDARD_SOBJECT_WHITELIST].map((s) => s.toLowerCase()));
const AFTER_FROM_RE = /^(?:WHERE|WITH|GROUP|ORDER|LIMIT|OFFSET|FOR|USING|ALL|UPDATE)\b/i;

/** Index of the first paren-depth-0 `from` keyword in `inner`, or -1. */
function firstFromAt(inner: string): number {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (
      depth === 0 &&
      /^from\b/i.test(inner.slice(i, i + 5)) &&
      /[^\w$]/.test(inner[i - 1] ?? " ")
    )
      return i;
  }
  return -1;
}

/**
 * The literal FROM of `inner` (text after SELECT): the first depth-0 `from`
 * followed by a literal identifier, then end of text, a SOQL clause keyword
 * or a computed tail. Null otherwise (no FROM, a computed FROM, or text that
 * is not shaped like SOQL). The object is not checked against any list.
 */
function literalFrom(inner: string): { fromAt: number; object: string } | null {
  const fromAt = firstFromAt(inner);
  if (fromAt < 0) return null;
  const m = inner.slice(fromAt + 4).match(/^\s+([A-Za-z_]\w*)/);
  const object = m?.[1];
  if (!m || !object) return null;
  const tail = inner.slice(fromAt + 4 + m[0].length);
  if (tail.startsWith(PLACEHOLDER)) return null;
  const next = tail.trimStart();
  if (next !== "" && !next.startsWith(PLACEHOLDER) && !AFTER_FROM_RE.test(next)) return null;
  return { fromAt, object };
}

/**
 * Validate a folded query and return its FROM object and the plain (non-dotted)
 * outer SELECT fields. Null unless the text looks like SOQL:
 *   - the FIRST depth-0 FROM is followed by a literal identifier that is a
 *     custom/namespaced object (`__c`, `__mdt`, …) or a whitelisted standard
 *     object, then end of text, a SOQL clause keyword or a computed tail;
 *     a computed FROM never falls through to a later `from`;
 *   - every select item without parens or placeholders is a single field path.
 */
export function parseDynamicSoql(folded: string): { object: string; fields: string[] } | null {
  const inner = folded.replace(/^\s*select\b/i, "");
  const from = literalFrom(inner);
  if (!from) return null;
  const { fromAt, object } = from;
  if (!CUSTOM_OBJECT_RE.test(object) && !STANDARD_LOWER.has(object.toLowerCase())) return null;

  const items: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of inner.slice(0, fromAt)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  items.push(cur);
  const fields: string[] = [];
  for (const raw of items) {
    const t = raw.trim();
    if (t.includes("(") || t.includes(PLACEHOLDER)) continue;
    if (!/^[A-Za-z_][\w.]*$/.test(t)) return null;
    if (!t.includes(".")) fields.push(t);
  }
  return { object, fields };
}

/** A computed FROM operand: `FROM <placeholder>…` or `FROM Name<placeholder>…`. */
const COMPUTED_FROM_RE = new RegExp(
  `^from(?:\\s*${PLACEHOLDER}|\\s+[A-Za-z_]\\w*${PLACEHOLDER})`,
  "i",
);
const FROM_OPERAND_RE = new RegExp(`^from\\s*[\\w${PLACEHOLDER}]*`, "i");

/**
 * Folded query text made safe for the inline SOQL grammar (soql-fields):
 * string literal contents are blanked (a value such as `'a IN b'` is never
 * a comparison), and each computed operand becomes `$`, which no field
 * name contains and which blocks a field glued to it (`$Code__c`, `Kind$`).
 */
function grammarText(inner: string): string {
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'") {
      let j = i + 1;
      while (j < inner.length && inner[j] !== "'") j += inner[j] === "\\" ? 2 : 1;
      out += `'${" ".repeat(Math.max(0, Math.min(j, inner.length) - i - 1))}'`;
      i = j;
    } else out += c === PLACEHOLDER ? "$" : c;
  }
  return out;
}

/**
 * WHERE / HAVING / GROUP BY / ORDER BY field operands of a folded dynamic
 * query, by the inline SOQL grammar (soql-fields). With a literal FROM
 * (parseDynamicSoql accepts the query, and the grammar reads the same FROM
 * object) they are `fields` of `object`. Otherwise nothing is attributed and
 * the operands are only counted in `skipped`: a computed FROM, a literal FROM
 * that parseDynamicSoql rejects, or a grammar FROM that differs from the
 * parsed object. Text that is not shaped like SOQL gives no fields and no
 * skips.
 */
export function dynamicSoqlClauseFields(
  folded: string,
  parsed: { object: string } | null = parseDynamicSoql(folded),
): { object: string | null; fields: string[]; skipped: number } {
  const inner = folded.replace(/^\s*select\b/i, "");
  if (parsed) {
    const refs = soqlFieldRefs(grammarText(inner));
    const same = refs.object?.toLowerCase() === parsed.object.toLowerCase();
    return same
      ? { object: parsed.object, fields: refs.clauseFields, skipped: 0 }
      : { object: parsed.object, fields: [], skipped: refs.clauseFields.length };
  }
  // A literal FROM that parseDynamicSoql rejected (object neither custom nor
  // whitelisted, or a select item that is not a field path): not attributed,
  // counted.
  if (literalFrom(inner)) {
    return {
      object: null,
      fields: [],
      skipped: soqlFieldRefs(grammarText(inner)).clauseFields.length,
    };
  }
  const fromAt = firstFromAt(inner);
  const rest = fromAt < 0 ? "" : inner.slice(fromAt);
  if (!COMPUTED_FROM_RE.test(rest)) return { object: null, fields: [], skipped: 0 };
  const operand = rest.match(FROM_OPERAND_RE)?.[0] ?? "from";
  const stand = `${inner.slice(0, fromAt)}FROM Computed ${rest.slice(operand.length)}`;
  const refs = soqlFieldRefs(grammarText(stand));
  return { object: null, fields: [], skipped: refs.clauseFields.length };
}
