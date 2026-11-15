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
  /^(?:system\s*\.\s*)?(?:integer|long|double|decimal|boolean|id|date|datetime|time|sobjecttype|sobjectfield|schema\s*\.\s*\w+)$/i;
const SAFE_GENERIC_RE =
  /^(?:system\s*\.\s*)?(?:list|set)\s*<\s*(?:system\s*\.\s*)?(?:integer|long|double|decimal|boolean|id)\s*>$/i;
/** `Map<K, Integer>`: a value read out of it (`.get(k)`) is a number, whatever the key type. */
const SAFE_MAP_VALUE_RE =
  /^(?:system\s*\.\s*)?map\s*<[^<>]*,\s*(?:system\s*\.\s*)?(?:integer|long|double|decimal|boolean|id|date|datetime|time)\s*>$/i;
const MAP_READ_RE = /^\s*\.\s*(?:get|getOrDefault)\s*\(/i;
const NOT_A_TYPE = new Set(["return", "new", "else", "throw", "in", "instanceof", "case", "when"]);
/** Methods of any value that return a number or a boolean. */
const NUMERIC_MEMBER_RE =
  /\.\s*(?:size|length|isEmpty|hashCode|getTime|year|month|day)\s*\(\s*\)\s*$/i;
const ESCAPE_CALL_RE = /^(?:String\s*\.\s*)?escapeSingleQuotes\s*\(/i;
const ALLCAPS_RE = /^[A-Z][A-Z0-9_]*$/;
/** Conversions to a type that cannot carry a quote (`Integer.valueOf(x)` throws on text). */
const SAFE_CONVERSION_RE =
  /^(?:Integer|Long|Double|Decimal|Boolean|Id|Date|Datetime|Time)\s*\.\s*valueOf\s*\(/i;
/**
 * `String.valueOf(x)` keeps x's text, so it carries x's taint when x is text. When x is a
 * variable of a type in SAFE_TYPE_RE (Integer, Long, Decimal, Double, Boolean, Id, Date,
 * Datetime, Time...) the argument is judged safe by `variable()`, so nothing propagates.
 */
const STRING_VALUEOF_RE = /^String\s*\.\s*valueOf\s*\(/i;

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
function splitTopLevel(masked: string, a: number, b: number, sep: "+" | "," | ";"): number[] {
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
  /** Taint of each variable (lower-case name) after the assignments processed so far. */
  private readonly state = new Map<string, string | null>();
  /** True while a variable's value is still the caller's parameter (no assignment yet). */
  private readonly fromParam = new Set<string>();
  private readonly decls = new Map<string, { type: string; index: number } | null>();
  /** Every assignment to a declared variable, in source order, with how it is reached. */
  private assignments: Array<{
    name: string;
    plus: boolean;
    from: number;
    to: number;
    definite: boolean;
  }> | null = null;
  private applied = 0;

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
      this.applyAssignmentsBefore(m.index ?? 0);
      const tainted = this.withLoopTaint(m.index ?? 0, () => this.expr(first[0], first[1]));
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

  /** `[start, end)` of every loop body (for, while, do; braced or not), found once. */
  private loops: Array<[number, number]> | null = null;

  private loopBodies(): Array<[number, number]> {
    if (this.loops) return this.loops;
    const m = this.masked;
    const out: Array<[number, number]> = [];
    for (const hit of m.matchAll(/(?<![\w.])(for|while|do)\b/gi)) {
      let at = (hit.index ?? 0) + hit[0].length;
      if (hit[1]?.toLowerCase() !== "do") {
        while (/\s/.test(m[at] ?? "")) at++;
        if (m[at] !== "(") continue;
        const close = matchClose(m, at);
        if (close < 0) continue;
        at = close + 1;
      }
      while (/\s/.test(m[at] ?? "")) at++;
      const end = m[at] === "{" ? matchClose(m, at) + 1 : statementEnd(m, at) + 1;
      if (end > at) out.push([at, end]);
    }
    this.loops = out;
    return out;
  }

  /**
   * Run `check` with loop-carried taint: for a call inside a loop body, a tainting assignment
   * anywhere in the outermost enclosing loop body counts, even after the call (the next pass
   * reads it). A safe reassignment later in the loop never clears the taint.
   */
  private withLoopTaint<T>(at: number, check: () => T): T {
    const enclosing = this.loopBodies().filter(([a, b]) => a <= at && at < b);
    if (enclosing.length === 0 || !this.assignments) return check();
    const start = Math.min(...enclosing.map(([a]) => a));
    const end = Math.max(...enclosing.map(([, b]) => b));
    const savedState = new Map(this.state);
    const savedParam = new Set(this.fromParam);
    for (const a of this.assignments.slice(this.applied)) {
      if (a.from < start || a.from >= end) continue;
      const t = this.expr(a.from, a.to);
      if (t) {
        this.state.set(a.name.toLowerCase(), t);
        this.fromParam.delete(a.name.toLowerCase());
      }
    }
    try {
      return check();
    } finally {
      this.state.clear();
      for (const [k, v] of savedState) this.state.set(k, v);
      this.fromParam.clear();
      for (const k of savedParam) this.fromParam.add(k);
    }
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
    // Only the sanitizer call's own result is safe, not an expression that merely contains one.
    const esc = ESCAPE_CALL_RE.exec(raw);
    if (esc && matchClose(m, s + esc[0].length - 1) === e - 1) return null;
    if (/\bSchema\s*\./i.test(raw) || /getDescribe\s*\(|getSObjectType\s*\(/i.test(raw))
      return null;
    if (SAFE_CONVERSION_RE.test(raw)) return null;
    const sv = STRING_VALUEOF_RE.exec(raw);
    if (sv) {
      const open = s + sv[0].length - 1;
      const close = matchClose(m, open);
      if (close < 0 || close !== e - 1) return null;
      const arg = pieces(m, open + 1, close, ",")[0];
      return arg ? this.expr(arg[0], arg[1]) : null;
    }
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
      return this.formatArgs(open + 1, close);
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
    // `terms[0]` on a tainted collection is tainted like `terms.get(0)`.
    if (/^\s*\[/.test(rest)) return this.variable(name);
    // `numbers.get(k)` on a Map<K, Integer>: the value is a number even when the key is text.
    if (MAP_READ_RE.test(rest)) {
      const decl = this.declaration(name);
      if (decl && SAFE_MAP_VALUE_RE.test(decl.type)) return null;
    }
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

  /**
   * `String.format(template, args)`: each argument is judged as an expression, so a
   * conversion (`Integer.valueOf(x)`), an `escapeSingleQuotes(x)` call or a describe name makes
   * only its own argument safe. A `new List<String>{ a, b }` argument is judged element by element.
   */
  private formatArgs(a: number, b: number): string | null {
    const m = this.masked;
    for (const [s, e] of pieces(m, a, b, ",")) {
      if (s >= e) continue;
      if (/^new\b/i.test(this.clean.slice(s, e))) {
        // `new List<String>{ a, b }` (elements) or `new List<String>(copy)` (constructor
        // arguments): safe only when every element or argument is.
        const brace = m.indexOf("{", s);
        const paren = m.indexOf("(", s);
        let inner: [number, number] | null = null;
        if (brace >= 0 && brace < e && matchClose(m, brace) === e - 1) inner = [brace + 1, e - 1];
        else if (paren >= 0 && paren < e && matchClose(m, paren) === e - 1)
          inner = [paren + 1, e - 1];
        if (!inner) continue;
        for (const [es, ee] of pieces(m, inner[0], inner[1], ",")) {
          const t = this.expr(es, ee);
          if (t) return t;
        }
        continue;
      }
      const t = this.expr(s, e);
      if (t) return t;
    }
    return null;
  }

  private declaration(name: string): { type: string; index: number } | null {
    const key = name.toLowerCase();
    const cached = this.decls.get(key);
    if (cached !== undefined) return cached;
    const found = this.findDeclaration(name);
    this.decls.set(key, found);
    return found;
  }

  private findDeclaration(name: string): { type: string; index: number } | null {
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

  /**
   * Every assignment to a declared variable, in source order. A plain assignment is definite
   * when it sits at the method body's own brace depth and is not the body of a braceless
   * `if`/`else`/`for`/`while`; anything else is conditional.
   */
  private collectAssignments(): NonNullable<InjectionAnalyzer["assignments"]> {
    const m = this.masked;
    const out: NonNullable<InjectionAnalyzer["assignments"]> = [];
    const base = m.indexOf("{") < 0 ? 0 : 1;
    let depth = 0;
    let pos = 0;
    // The condition and update clauses of a `for (init; cond; update)` header run only
    // conditionally (the update never runs when the body does not); the init clause always runs
    // once, so it stays definite.
    const headerClauses: Array<[number, number]> = [];
    for (const f of m.matchAll(/(?<![\w.])for\s*\(/gi)) {
      const open = (f.index ?? 0) + f[0].length - 1;
      const close = matchClose(m, open);
      if (close < 0) continue;
      const cuts = splitTopLevel(m, open + 1, close, ";");
      if (cuts[0] !== undefined) headerClauses.push([cuts[0], close]);
    }
    const re = /(?<![\w.])([A-Za-z_]\w*)\s*(\+?)=(?!=)/g;
    for (const hit of m.matchAll(re)) {
      const name = hit[1] ?? "";
      if (!this.isDeclared(name)) continue;
      const at = hit.index ?? 0;
      for (; pos < at; pos++) {
        const ch = m[pos];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      const stmt = Math.max(m.lastIndexOf(";", at), m.lastIndexOf("{", at), m.lastIndexOf("}", at));
      const prefix = m.slice(stmt + 1, at).trim();
      const braceless = /(?:\)|\belse|\bdo)$/i.test(prefix);
      const from = at + hit[0].length;
      out.push({
        name,
        plus: hit[2] === "+",
        from,
        to: statementEnd(m, from),
        definite:
          depth === base && !braceless && !headerClauses.some(([a, b]) => a <= at && at < b),
      });
    }
    return out;
  }

  /**
   * Apply, in source order, the assignments that end before `limit` (an assignment whose own right-hand side holds the query call is applied after that call is checked). The last definite plain
   * assignment wins (`v = term; v = escapeSingleQuotes(v);` is safe). A tainted value stays
   * tainted through a conditional assignment, and a conditional safe assignment clears only a
   * parameter's own text (the documented rule: a parameter escaped on one branch is treated as
   * escaped). `+=` only ever adds taint. One forward pass, no recursion, so a chain of
   * thousands of aliases costs time and no stack.
   */
  private applyAssignmentsBefore(limit: number): void {
    this.assignments ??= this.collectAssignments();
    while (this.applied < this.assignments.length) {
      const a = this.assignments[this.applied];
      if (!a || a.to > limit) break;
      this.applied += 1;
      const key = a.name.toLowerCase();
      const t = this.expr(a.from, a.to);
      const current = this.variable(a.name);
      if (t) {
        this.state.set(key, t);
        this.fromParam.delete(key);
      } else if (a.plus) {
        // an append of safe text keeps what the variable held
      } else if (a.definite) {
        this.state.set(key, null);
        this.fromParam.delete(key);
      } else if (current && this.fromParam.has(key)) {
        this.state.set(key, null);
        this.fromParam.delete(key);
      }
    }
  }

  /** `name` when the variable can carry unescaped text into a query, else null. */
  private variable(name: string): string | null {
    const key = name.toLowerCase();
    const decl = this.declaration(name);
    if (!decl) return null;
    if (SAFE_TYPE_RE.test(decl.type) || SAFE_GENERIC_RE.test(decl.type)) return null;
    if (this.state.has(key)) return this.state.get(key) ?? null;
    if (this.isParam(decl)) {
      this.fromParam.add(key);
      this.state.set(key, name);
      return name;
    }
    this.state.set(key, null);
    return null;
  }
}

/**
 * SOQL / SOSL injection: `Database.query`, `queryWithBinds`, `countQuery`,
 * `getQueryLocator` and `Search.query` whose query string is built by
 * concatenating a variable that is a method parameter or was assigned from one,
 * and that did not pass through `String.escapeSingleQuotes`. Not flagged: string
 * literals and numbers; a variable (or an assignment) from `escapeSingleQuotes`;
 * `Integer`/`Long`/`Decimal`/`Id`/`Date`... `valueOf` conversions (`String.valueOf(x)` carries x's taint only when x is text: an Integer, Long, Decimal, Double, Boolean, Id, Date, Datetime or Time x stays safe through it, through `+` and through `String.format` arguments); values read from a `Map<K, Integer>`; variables of type Integer, Long, Decimal, Boolean, Id, Date,
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
