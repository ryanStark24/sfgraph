import { maskApex } from "./dynamic-soql.js";

/**
 * SOQL / SOSL injection detector over one Apex unit's text (a method body or a
 * trigger). It lives with the parsers because the Apex parsers run it at parse time
 * (the method's parameters are not in its stored body) and stamp the result on the
 * node as `soqlInjection`; `analyze/code-security.ts` reads that attribute.
 */

export interface InjectionSpot {
  /** 1-based line within the unit's text. */
  line: number;
  /** The source line, trimmed and cut at 200 characters. */
  evidence: string;
  /** The call (`Database.query`). */
  kind: string;
  /** The variable that carries unescaped text into the query. */
  variable?: string;
}

const lineOfIndex = (text: string, idx: number): number => {
  let n = 1;
  for (let k = 0; k < idx && k < text.length; k++) if (text.charCodeAt(k) === 10) n += 1;
  return n;
};

const lineText = (text: string, idx: number): string => {
  const s = text.lastIndexOf("\n", idx - 1) + 1;
  const e = text.indexOf("\n", idx);
  return text
    .slice(s, e < 0 ? text.length : e)
    .trim()
    .slice(0, 200);
};

/** Length-preserving: comment text becomes spaces, string literals are kept. */
function stripComments(src: string): string {
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
      i++;
      while (i < src.length && src[i] !== "'") i += src[i] === "\\" ? 2 : 1;
      i++;
    } else i++;
  }
  return out.join("");
}

const DYNAMIC_CALL_RE =
  /(?<![\w.])(Database\s*\.\s*(?:query|queryWithBinds|countQuery|countQueryWithBinds|getQueryLocator|getQueryLocatorWithBinds)|Search\s*\.\s*query)\s*\(/gi;

/** Types whose values cannot carry a quote: a variable of one of these is safe in a query string. */
const SAFE_TYPE_RE =
  /^(?:integer|long|double|decimal|boolean|id|date|datetime|time|sobjecttype|sobjectfield|schema\s*\.\s*\w+)$/i;
const SAFE_GENERIC_RE = /^(?:list|set)\s*<\s*(?:integer|long|double|decimal|boolean|id)\s*>$/i;
const NOT_A_TYPE = new Set(["return", "new", "else", "throw", "in", "instanceof", "case", "when"]);
/** Methods of any value that return a number or a boolean. */
const NUMERIC_MEMBER_RE =
  /\.\s*(?:size|length|isEmpty|hashCode|getTime|year|month|day)\s*\(\s*\)\s*$/i;
const ALLCAPS_RE = /^[A-Z][A-Z0-9_]*$/;
const CONVERSION_RE =
  /^(?:String|Integer|Long|Double|Decimal|Boolean|Id|Date|Datetime|Time)\s*\.\s*valueOf\s*\(/i;

/** Index of the delimiter matching the opener at `open` in `masked`, or -1. */
function matchClose(masked: string, open: number): number {
  const opener = masked[open] ?? "";
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
  let d = 0;
  for (let j = open; j < masked.length; j++) {
    const c = masked[j];
    if (c === opener) d += 1;
    else if (c === closer && --d === 0) return j;
  }
  return -1;
}

/** Positions of `sep` at nesting depth 0 in masked[a, b). `+` ignores `++` and `+=`. */
function splitTopLevel(masked: string, a: number, b: number, sep: "+" | ","): number[] {
  const cuts: number[] = [];
  let d = 0;
  for (let j = a; j < b; j++) {
    const c = masked[j];
    if (c === "(" || c === "[" || c === "{") d += 1;
    else if (c === ")" || c === "]" || c === "}") d -= 1;
    else if (d === 0 && c === sep) {
      if (sep === "+" && (masked[j + 1] === "+" || masked[j + 1] === "=" || masked[j - 1] === "+"))
        continue;
      cuts.push(j);
    }
  }
  return cuts;
}

/** End (exclusive) of the statement whose expression starts at `from`: the `;` at depth 0. */
function statementEnd(masked: string, from: number): number {
  let d = 0;
  for (let j = from; j < masked.length; j++) {
    const c = masked[j];
    if (c === "(" || c === "[" || c === "{") d += 1;
    else if (c === ")" || c === "]" || c === "}") {
      d -= 1;
      if (d < 0) return j;
    } else if (c === ";" && d === 0) return j;
  }
  return masked.length;
}

/** `[start, end)` of each top-level piece of masked[a, b) split at `sep`, trimmed. */
function pieces(masked: string, a: number, b: number, sep: "+" | ","): Array<[number, number]> {
  const bounds = [a - 1, ...splitTopLevel(masked, a, b, sep), b];
  const out: Array<[number, number]> = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    let s = (bounds[k] ?? 0) + 1;
    let e = bounds[k + 1] ?? b;
    while (s < e && /\s/.test(masked[s] ?? "")) s++;
    while (e > s && /\s/.test(masked[e - 1] ?? "")) e--;
    out.push([s, e]);
  }
  return out;
}

class InjectionAnalyzer {
  private readonly clean: string;
  private readonly masked: string;
  private readonly headerEnd: number;
  private readonly visiting = new Set<string>();
  private readonly memo = new Map<string, string | null>();

  constructor(code: string) {
    this.clean = stripComments(code);
    this.masked = maskApex(code);
    const brace = this.masked.indexOf("{");
    this.headerEnd = brace < 0 ? 0 : brace;
  }

  /** The call sites and the tainted variable of each unsafe one. */
  run(code: string): InjectionSpot[] {
    const out: InjectionSpot[] = [];
    for (const m of this.masked.matchAll(DYNAMIC_CALL_RE)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = matchClose(this.masked, open);
      if (close < 0) continue;
      const first = pieces(this.masked, open + 1, close, ",")[0];
      if (!first || first[0] >= first[1]) continue;
      const tainted = this.expr(first[0], first[1]);
      if (!tainted) continue;
      const call = (m[1] ?? "").replace(/\s+/g, "");
      out.push({
        line: lineOfIndex(code, m.index ?? 0),
        evidence: lineText(code, m.index ?? 0),
        kind: call,
        variable: tainted,
      });
    }
    return out;
  }

  /** The name of a tainted variable used in the expression masked[a, b), else null. */
  private expr(a: number, b: number): string | null {
    for (const [s, e] of pieces(this.masked, a, b, "+")) {
      const t = this.operand(s, e);
      if (t) return t;
    }
    return null;
  }

  private operand(s: number, e: number): string | null {
    if (s >= e) return null;
    const m = this.masked;
    const raw = this.clean.slice(s, e);
    const first = m[s];
    // A string literal, a number, `null`, `true`/`false`.
    if (first === "'" || /^[\d.]/.test(raw) || /^(?:null|true|false)$/i.test(raw)) return null;
    if (first === "(" && matchClose(m, s) === e - 1) {
      // `(cond ? a : b)` or a parenthesised expression.
      return this.ternaryOrExpr(s + 1, e - 1);
    }
    if (/escapeSingleQuotes\s*\(/i.test(raw)) return null;
    if (/\bSchema\s*\./i.test(raw) || /getDescribe\s*\(|getSObjectType\s*\(/i.test(raw))
      return null;
    if (CONVERSION_RE.test(raw)) return null;
    if (NUMERIC_MEMBER_RE.test(raw)) return null;
    if (/^new\b/i.test(raw)) return null;
    const ternary = this.ternary(s, e);
    if (ternary !== undefined) return ternary;
    const call = /^(String)\s*\.\s*(join|format)\s*\(/i.exec(raw);
    if (call) {
      const open = s + call[0].length - 1;
      const close = matchClose(m, open);
      if (close < 0) return null;
      if ((call[2] ?? "").toLowerCase() === "join") {
        const arg = pieces(m, open + 1, close, ",")[0];
        return arg ? this.operand(arg[0], arg[1]) : null;
      }
      return this.anyIdentifier(open + 1, close);
    }
    const root = /^([A-Za-z_]\w*)/.exec(raw);
    if (!root) return null;
    const name = root[1] ?? "";
    const rest = raw.slice(name.length);
    if (!this.isDeclared(name)) {
      // A constant (`MAX`, `Cls.MAX`), a field or another class's member: not judged.
      return null;
    }
    if (rest === "") return this.variable(name);
    // `var.member...` / `var.method(...)`: tainted when the variable is.
    if (/^\s*\.\s*\w+/.test(rest)) {
      const last = /([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*$/.exec(rest);
      if (last && ALLCAPS_RE.test(last[1] ?? "")) return null;
      return this.variable(name);
    }
    return null;
  }

  private ternaryOrExpr(a: number, b: number): string | null {
    const t = this.ternary(a, b);
    return t !== undefined ? t : this.expr(a, b);
  }

  /** `cond ? x : y`: the taint of x or y (the condition is not a value). undefined: not a ternary. */
  private ternary(a: number, b: number): string | null | undefined {
    const m = this.masked;
    let d = 0;
    let q = -1;
    let c = -1;
    for (let j = a; j < b; j++) {
      const ch = m[j];
      if (ch === "(" || ch === "[" || ch === "{") d += 1;
      else if (ch === ")" || ch === "]" || ch === "}") d -= 1;
      else if (d === 0 && ch === "?" && m[j + 1] !== "." && q < 0) q = j;
      else if (d === 0 && ch === ":" && q >= 0 && c < 0) c = j;
    }
    if (q < 0 || c < 0) return undefined;
    return this.expr(q + 1, c) ?? this.expr(c + 1, b);
  }

  /** The first declared variable among the identifiers of masked[a, b) that is tainted. */
  private anyIdentifier(a: number, b: number): string | null {
    for (const m of this.masked.slice(a, b).matchAll(/(?<![\w.])[A-Za-z_]\w*/g)) {
      const name = m[0];
      if (this.isDeclared(name)) {
        const t = this.variable(name);
        if (t) return t;
      }
    }
    return null;
  }

  private declaration(name: string): { type: string; index: number } | null {
    const re = new RegExp(
      `(?<![\\w.])([A-Za-z_][\\w.]*(?:\\s*<[^;=()]*>)?(?:\\s*\\[\\s*\\])?)\\s+${name}\\s*(?=[=;,):])`,
      "gi",
    );
    for (const m of this.masked.matchAll(re)) {
      const type = (m[1] ?? "").replace(/\s+/g, "");
      if (NOT_A_TYPE.has(type.toLowerCase())) continue;
      return { type, index: m.index ?? 0 };
    }
    return null;
  }

  private isDeclared(name: string): boolean {
    return this.declaration(name) !== null;
  }

  private isParam(decl: { index: number }): boolean {
    return decl.index < this.headerEnd;
  }

  /** `name` when the variable can carry unescaped text into a query, else null. */
  private variable(name: string): string | null {
    const key = name.toLowerCase();
    const decl = this.declaration(name);
    if (!decl) return null;
    const param = this.isParam(decl);
    if (this.visiting.has(key)) return param ? name : null;
    if (this.memo.has(key)) return this.memo.get(key) ?? null;
    const type = decl.type;
    if (SAFE_TYPE_RE.test(type) || SAFE_GENERIC_RE.test(type)) {
      this.memo.set(key, null);
      return null;
    }
    this.visiting.add(key);
    let result: string | null = null;
    let assigned = false;
    const re = new RegExp(`(?<![\\w.])${name}\\s*(\\+?)=(?!=)`, "gi");
    for (const m of this.masked.matchAll(re)) {
      // A declaration's own `=` and a plain assignment are both a value flowing in.
      const from = (m.index ?? 0) + m[0].length;
      const to = statementEnd(this.masked, from);
      assigned = true;
      const t = this.expr(from, to);
      if (t) {
        result = t === name ? name : t;
        break;
      }
    }
    if (result === null && !assigned && param) result = name;
    this.visiting.delete(key);
    this.memo.set(key, result);
    return result;
  }
}

/**
 * SOQL / SOSL injection: `Database.query`, `queryWithBinds`, `countQuery`,
 * `getQueryLocator` and `Search.query` whose query string is built by
 * concatenating a variable that is a method parameter or was assigned from one,
 * and that did not pass through `String.escapeSingleQuotes`. Not flagged: string
 * literals and numbers; a variable (or an assignment) from `escapeSingleQuotes`;
 * `valueOf` conversions; variables of type Integer, Long, Decimal, Boolean, Id, Date,
 * Datetime and lists or sets of them; names derived from `Schema` describe calls;
 * ALL_CAPS constants; and bind variables (`:var` sits inside the literal, so it
 * is not a concatenation at all).
 *
 * `opts.params` are the method's parameter declarations (`String term`), which are not in
 * the stored body; without them a parameter is not known to be tainted.
 *
 * Limits: the analysis is per unit and flow-insensitive. A class field, a value
 * returned by another method, a for-each variable and an instance call
 * (`helper.build(x)`) are not traced, so those are not reported (low false positives
 * over completeness). `String.format` arguments are checked by name only.
 */
export function detectSoqlInjection(
  code: string,
  opts: { params?: readonly string[] } = {},
): InjectionSpot[] {
  if (!code || !/\b(?:Database|Search)\s*\.\s*\w*query\w*\s*\(|getQueryLocator/i.test(code)) {
    return [];
  }
  // A method's stored text has no header, so its parameters (`String term`) are put in front on
  // the first line, which keeps every line number of `code`.
  const text = opts.params ? `(${opts.params.join(", ")}) {${code}` : code;
  return new InjectionAnalyzer(text).run(text);
}
