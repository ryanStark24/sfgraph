import { maskApex } from "./dynamic-soql.js";
import { detectSoqlInjectionBaseline } from "./soql-injection-baseline.js";

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
const ESCAPE_ANYWHERE_RE = /(?<![\w.])(?:String\s*\.\s*)?escapeSingleQuotes\s*\(/gi;
const NUMERIC_VALUEOF_ANYWHERE_RE =
  /(?<![\w.])(?:Integer|Long|Double|Decimal|Boolean|Id|Date|Datetime|Time)\s*\.\s*valueOf\s*\(/gi;
const ESCAPE_CALL_RE = /^(?:String\s*\.\s*)?escapeSingleQuotes\s*\(/i;
/** A describe chain (`Schema.SObjectType.Account.getName()`, `x.getSObjectType().getDescribe().getName()`). */
const DESCRIBE_CHAIN_RE =
  /^(?:Schema\s*\.\s*[\w.]+\s*(?:\([^()]*\))?(?:\s*\.\s*\w+\s*\([^()]*\))*|[\w.]+(?:\s*\([^()]*\))?\s*\.\s*(?:getDescribe|getSObjectType)\s*\(\s*\)(?:\s*\.\s*\w+\s*\(\s*\))*)$/i;
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

/** One assignment (or declaration with an initializer) to a declared variable. */
interface Assignment {
  name: string;
  plus: boolean;
  /** Offset of the assigned name. */
  at: number;
  from: number;
  to: number;
  /** Declared variables named anywhere in the right-hand side (a plain scan of its text). */
  ids: string[];
  /** Straight-line at the body's own brace depth: not in a branch, loop, header or call. */
  simple: boolean;
}

/**
 * Two analyses over one unit. The default is the flow-insensitive one: a variable is tainted
 * when it is a parameter that was not replaced, or when any assignment to it anywhere carries
 * taint (alias chains are followed with a worklist, not recursion). A finding that rule reports
 * is dropped only in the provably simple case: the call is not in a loop, and every assignment
 * to the variables the argument reads is a straight-line statement at the body's own depth, and
 * in source order the last one before the call is safe. Anything else keeps the finding.
 */
class InjectionAnalyzer {
  private readonly clean: string;
  private readonly masked: string;
  private readonly headerEnd: number;
  private readonly decls = new Map<string, { type: string; index: number } | null>();
  private assignments: Assignment[] | null = null;
  /** Flow-insensitive taint of each variable (lower-case name). */
  private fixed: Map<string, string | null> | null = null;
  /** Source-order taint, after the assignments applied so far. */
  private readonly state = new Map<string, string | null>();
  private applied = 0;
  private mode: "fixed" | "ordered" = "fixed";
  /** Variables read (lower-case) while an expression is evaluated, when not null. */
  private reads: Set<string> | null = null;
  /** The variable whose assignment is being evaluated by the fixpoint. */
  private target: string | null = null;

  constructor(code: string) {
    this.clean = stripComments(code);
    this.masked = maskApex(code);
    const brace = this.masked.indexOf("{");
    this.headerEnd = brace < 0 ? 0 : brace;
  }

  /** Every dynamic-query call site found by `run`, reported or not. */
  readonly sinks: Array<{ line: number; kind: string; at: number; a: number; b: number }> = [];
  /** Offsets of the calls `run` reported. */
  readonly reportedAt = new Set<number>();

  /** The call sites and the tainted variable of each unsafe one. */
  run(code: string): InjectionSpot[] {
    const out: InjectionSpot[] = [];
    for (const m of this.masked.matchAll(DYNAMIC_CALL_RE)) {
      const at = m.index ?? 0;
      const open = at + m[0].length - 1;
      const close = matchClose(this.masked, open);
      if (close < 0) continue;
      const first = pieces(this.masked, open + 1, close, ",")[0];
      if (!first || first[0] >= first[1]) continue;
      const call = (m[1] ?? "").replace(/\s+/g, "");
      this.sinks.push({ line: lineOfIndex(code, at), kind: call, at, a: first[0], b: first[1] });
      this.solve();
      this.mode = "fixed";
      const tainted = this.expr(first[0], first[1]);
      if (!tainted) continue;
      if (this.provablySafe(at, first[0], first[1])) continue;
      this.reportedAt.add(at);
      out.push({
        line: lineOfIndex(code, at),
        evidence: lineText(code, at),
        kind: call,
        variable: tainted,
      });
    }
    return out;
  }

  /**
   * True only in the simple case: the call is outside every loop (header and body), every
   * assignment to the variables its argument reads (and to the ones they were copied from) is
   * straight-line, and the source-order value at the call is safe.
   */
  private provablySafe(at: number, a: number, b: number): boolean {
    const loops = this.loopRanges();
    if (loops.some(([ls, le]) => ls <= at && at < le)) return false;
    // The parent's rule implicates every declared variable named in the argument and, through
    // the right-hand sides of their assignments, every variable those were copied from. This
    // closure is a plain scan of the text, never the result of evaluating it.
    const seen = new Set<string>();
    const work: string[] = [];
    const add = (name: string): void => {
      if (!seen.has(name)) {
        seen.add(name);
        work.push(name);
      }
    };
    for (const hit of this.masked.slice(a, b).matchAll(/(?<![\w.])[A-Za-z_]\w*/g)) {
      if (this.isDeclared(hit[0])) add(hit[0].toLowerCase());
    }
    const all = this.assignments ?? [];
    for (let i = 0; i < work.length; i++) {
      for (const asg of all) {
        if (asg.name.toLowerCase() !== work[i]) continue;
        // Final guard: only straight-line assignments, none inside a loop.
        if (!asg.simple || loops.some(([ls, le]) => ls <= asg.at && asg.at < le)) return false;
        for (const id of asg.ids) add(id);
      }
    }
    // Text-level backstop, no evaluation: flatten the argument through the effective assignments
    // of the variables it names, drop the allow-listed safe substrings, and keep the finding when
    // a parameter the parent's rule leaves tainted is still named in what is left.
    if (this.taintedLeafRemains(at, a, b)) return false;
    this.applyAssignmentsBefore(at);
    this.mode = "ordered";
    const ordered = this.expr(a, b);
    this.mode = "fixed";
    return !ordered;
  }

  /**
   * `text` with the exact allow-listed safe substrings blanked (same length). A substring is
   * blanked only when it is the whole operand: an escape call, a numeric `.valueOf(...)`, a
   * describe chain or a numeric Map read followed by nothing, or by calls without arguments.
   * A chained call that takes arguments breaks the match and leaves the text in place.
   */
  private stripSafe(text: string): string {
    const chars = text.split("");
    const blank = (from: number, to: number): void => {
      for (let k = from; k <= to && k < chars.length; k++) chars[k] = " ";
    };
    // The end of `close` plus only no-argument calls after it, or -1 when anything else follows.
    const exactEnd = (close: number): number => {
      let end = close;
      for (;;) {
        const next = /^\s*\.\s*\w+\s*\(\s*\)/.exec(text.slice(end + 1));
        if (!next) break;
        end += next[0].length;
      }
      return /^\s*[.[]/.test(text.slice(end + 1)) ? -1 : end;
    };
    for (const hit of text.matchAll(ESCAPE_ANYWHERE_RE)) {
      // Whatever follows an escaped call stays in the text and is scanned like any other text.
      const start = hit.index ?? 0;
      const close = matchClose(text, start + hit[0].length - 1);
      blank(start, close < 0 ? chars.length - 1 : close);
    }
    for (const hit of text.matchAll(NUMERIC_VALUEOF_ANYWHERE_RE)) {
      const start = hit.index ?? 0;
      const close = matchClose(text, start + hit[0].length - 1);
      const end = close < 0 ? -1 : exactEnd(close);
      if (end >= 0) blank(start, end);
    }
    const describe = /(?<![\w.])Schema\s*\.\s*[\w.]+(?:\s*\(\s*\))?(?:\s*\.\s*\w+\s*\(\s*\))*/gi;
    for (const hit of text.matchAll(describe)) {
      const start = hit.index ?? 0;
      const end = start + hit[0].length - 1;
      if (!/^\s*[.[(]/.test(text.slice(end + 1))) blank(start, end);
    }
    for (const hit of text.matchAll(
      /(?<![\w.])([A-Za-z_]\w*)\s*\.\s*(?:get|getOrDefault)\s*\(/gi,
    )) {
      const type = this.declaration(hit[1] ?? "")?.type ?? "";
      if (!SAFE_MAP_VALUE_RE.test(type)) continue;
      const start = hit.index ?? 0;
      const close = matchClose(text, start + hit[0].length - 1);
      const end = close < 0 ? -1 : exactEnd(close);
      if (end >= 0) blank(start, end);
    }
    return chars.join("");
  }

  /**
   * Pure text check, and the backstop's explicit rule: a baseline finding may be dropped only
   * when the flattened text contains no parameter identifier at all, other than inside blanked
   * allow-listed spans (and parameters of a safe type). The argument's text is flattened
   * position by position: a variable read at some position is replaced by its effective
   * assignments before that position (the last plain one and every `+=` after it), and inside
   * that right-hand side each variable is read at the assignment's own position, recursively.
   * A variable whose position is ambiguous (any assignment not straight-line, inside a loop, or
   * the call inside a loop) is replaced by all of its assignments, and an ambiguous parameter
   * keeps the finding. When in doubt, keep.
   */
  private taintedLeafRemains(at: number, a: number, b: number): boolean {
    const all = this.assignments ?? [];
    const loops = this.loopRanges();
    const inLoop = (pos: number): boolean => loops.some(([ls, le]) => ls <= pos && pos < le);
    const callInLoop = inLoop(at);
    const queue: Array<{ text: string; pos: number }> = [
      { text: this.masked.slice(a, b), pos: at },
    ];
    const expanded = new Set<Assignment>();
    const expand = (x: Assignment): void => {
      if (expanded.has(x)) return;
      expanded.add(x);
      queue.push({ text: this.masked.slice(x.from, x.to), pos: x.at });
    };
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (!item) continue;
      const text = this.stripSafe(item.text);
      for (const hit of text.matchAll(/(?<![\w.])[A-Za-z_]\w*/g)) {
        const name = hit[0];
        if (!this.isDeclared(name)) continue;
        const decl = this.declaration(name);
        if (!decl || this.safeType(decl.type)) continue;
        const key = name.toLowerCase();
        const own = all.filter((x) => x.name.toLowerCase() === key);
        const straight = !callInLoop && own.every((x) => x.simple && !inLoop(x.at));
        if (!straight) {
          if (this.isParam(decl)) return true;
          for (const x of own) expand(x);
          continue;
        }
        const mine = own.filter((x) => x.to <= item.pos);
        const lastPlain = mine.map((x) => x.plus).lastIndexOf(false);
        // Before any plain assignment a parameter still holds the caller's text.
        if (this.isParam(decl) && lastPlain < 0) return true;
        for (const x of mine.slice(Math.max(lastPlain, 0))) expand(x);
      }
    }
    return false;
  }

  /** True when a tainted parameter's text may still reach sink `i` (the lexical backstop). */
  backstop(i: number): boolean {
    const sink = this.sinks[i];
    if (!sink) return true;
    this.solve();
    return this.taintedLeafRemains(sink.at, sink.a, sink.b);
  }

  /** `[start, end)` of every loop (for, while, do) from its keyword to the end of its body. */
  private loops: Array<[number, number]> | null = null;

  private loopRanges(): Array<[number, number]> {
    if (this.loops) return this.loops;
    const m = this.masked;
    const out: Array<[number, number]> = [];
    for (const hit of m.matchAll(/(?<![\w.])(for|while|do)\b/gi)) {
      const keyword = hit[1]?.toLowerCase();
      const start = hit.index ?? 0;
      let at = start + hit[0].length;
      if (keyword !== "do") {
        while (/\s/.test(m[at] ?? "")) at++;
        if (m[at] !== "(") continue;
        const close = matchClose(m, at);
        if (close < 0) continue;
        at = close + 1;
      }
      while (/\s/.test(m[at] ?? "")) at++;
      let end = m[at] === "{" ? matchClose(m, at) + 1 : statementEnd(m, at) + 1;
      if (keyword === "do") {
        // `do { ... } while (cond);`: the condition is part of the loop.
        const tail = /^\s*while\s*\(/i.exec(m.slice(end));
        if (tail) {
          const open = end + tail[0].length - 1;
          const close = matchClose(m, open);
          if (close >= 0) end = close + 1;
        }
      }
      if (end > at) out.push([start, end]);
    }
    this.loops = out;
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

  /**
   * One operand of a `+` chain. An operand is judged safe only when it matches a known-safe
   * shape exactly (a literal, a numeric conversion, an `escapeSingleQuotes(...)` wrapper, a
   * describe chain, a safe-typed variable); any other shape is read by the parent's rule: a
   * tainted variable named anywhere in it, outside `escapeSingleQuotes` arguments, taints it.
   */
  private operand(s: number, e: number): string | null {
    if (s >= e) return null;
    const m = this.masked;
    const raw = this.clean.slice(s, e);
    // A whole string literal, a number, `null`, `true`/`false`.
    if (m[s] === "'" && m.indexOf("'", s + 1) === e - 1) return null;
    if (/^(?:\d[\d_]*\.?\d*[lLdD]?|\.\d+|null|true|false)$/i.test(raw)) return null;
    if (m[s] === "(" && matchClose(m, s) === e - 1) {
      // `(cond ? a : b)` or a parenthesised expression.
      return this.ternaryOrExpr(s + 1, e - 1);
    }
    const ternary = this.ternary(s, e);
    if (ternary !== undefined) return ternary;
    // Only the sanitizer call's own result is safe, not an expression that merely contains one.
    const esc = ESCAPE_CALL_RE.exec(raw);
    if (esc && matchClose(m, s + esc[0].length - 1) === e - 1) return null;
    if (DESCRIBE_CHAIN_RE.test(raw)) return null;
    // `Integer.valueOf(x)` (then only calls without arguments) cannot carry a quote.
    const conv = SAFE_CONVERSION_RE.exec(raw);
    if (conv) {
      const close = matchClose(m, s + conv[0].length - 1);
      if (
        close === e - 1 ||
        (close > 0 && /^(?:\s*\.\s*\w+\s*\(\s*\))+$/.test(raw.slice(close - s + 1)))
      )
        return null;
      return this.anyIdentifier(s, e);
    }
    if (NUMERIC_MEMBER_RE.test(raw)) return null;
    const sv = STRING_VALUEOF_RE.exec(raw);
    if (sv) {
      const open = s + sv[0].length - 1;
      const close = matchClose(m, open);
      if (close < 0 || close !== e - 1) return this.anyIdentifier(s, e);
      const arg = pieces(m, open + 1, close, ",")[0];
      return arg ? this.expr(arg[0], arg[1]) : null;
    }
    if (/^new\b/i.test(raw)) return this.anyIdentifier(s, e);
    const call = /^(String)\s*\.\s*(join|format)\s*\(/i.exec(raw);
    if (call) {
      const open = s + call[0].length - 1;
      const close = matchClose(m, open);
      if (close < 0 || close !== e - 1) return this.anyIdentifier(s, e);
      // `join(list, separator)` and `format(template, args)`: every argument counts.
      return this.formatArgs(open + 1, close);
    }
    const root = /^([A-Za-z_]\w*)/.exec(raw);
    if (!root) return this.anyIdentifier(s, e);
    const name = root[1] ?? "";
    const rest = raw.slice(name.length);
    if (!this.isDeclared(name)) {
      // A constant (`MAX`, `Cls.MAX`) or a field is not judged; a call on any receiver
      // (`Helper.pick(term)`) is read by its arguments.
      return raw.includes("(") ? this.anyIdentifier(s, e) : null;
    }
    if (rest === "") return this.variable(name);
    // `terms[0]` on a tainted collection is tainted like `terms.get(0)`.
    if (/^\s*\[/.test(rest))
      return this.variable(name) ?? (rest.includes("(") ? this.anyIdentifier(s, e) : null);
    // `numbers.get(k)` on a Map<K, Integer>: the value is a number even when the key is text.
    if (MAP_READ_RE.test(rest)) {
      const decl = this.declaration(name);
      const open = s + name.length + rest.indexOf("(");
      if (decl && SAFE_MAP_VALUE_RE.test(decl.type) && matchClose(m, open) === e - 1) return null;
    }
    // `var.member...` / `var.method(...)`: tainted when the variable is.
    if (/^\s*\.\s*\w+/.test(rest)) {
      const last = /([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*$/.exec(rest);
      if (last && ALLCAPS_RE.test(last[1] ?? "")) return null;
      // The receiver's own taint, then the arguments of the call (`fixed.replace('a', term)`).
      return this.variable(name) ?? (rest.includes("(") ? this.anyIdentifier(s, e) : null);
    }
    return this.anyIdentifier(s, e);
  }

  private ternaryOrExpr(a: number, b: number): string | null {
    const t = this.ternary(a, b);
    return t !== undefined ? t : this.expr(a, b);
  }

  /** `cond ? x : y`: the taint of x or y (the condition is not a value). undefined: not a ternary. */
  private ternary(a: number, b: number): string | null | undefined {
    const split = this.ternarySplit(a, b);
    if (!split) return undefined;
    return this.expr(split[0] + 1, split[1]) ?? this.expr(split[1] + 1, b);
  }

  /** Positions of the top-level `?` and `:` of a ternary in masked[a, b), or null. */
  private ternarySplit(a: number, b: number): [number, number] | null {
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
    return q < 0 || c < 0 ? null : [q, c];
  }

  /**
   * `String.format(template, args)`: each argument is judged as an expression, so a
   * conversion (`Integer.valueOf(x)`), an `escapeSingleQuotes(x)` call or a describe name makes
   * only its own argument safe. A collection argument is judged by what is inside it (see
   * `collectionArg`).
   */
  private formatArgs(a: number, b: number): string | null {
    for (const [s, e] of pieces(this.masked, a, b, ",")) {
      const t = this.collectionArg(s, e);
      if (t) return t;
    }
    return null;
  }

  /**
   * One `String.format` argument. Redundant parentheses and a cast are removed, both branches
   * of a ternary are inspected, `new X{ a, b }` is judged element by element and `new X(args)`
   * by its arguments. Any other expression that holds a `new` is not understood here, so it
   * falls back to the parent's view: any tainted variable named inside it (minus the arguments
   * of `escapeSingleQuotes`) taints it. An expression without `new` is judged as usual.
   */
  private collectionArg(s0: number, e0: number): string | null {
    const m = this.masked;
    let s = s0;
    let e = e0;
    for (;;) {
      while (s < e && /\s/.test(m[s] ?? "")) s++;
      while (e > s && /\s/.test(m[e - 1] ?? "")) e--;
      if (s >= e) return null;
      if (m[s] !== "(") break;
      const close = matchClose(m, s);
      if (close < 0) break;
      if (close === e - 1) {
        s += 1;
        e -= 1;
        continue;
      }
      // `(List<String>) value`: a cast.
      if (/^[A-Za-z_][\w.]*(?:\s*<[^()]*>)?(?:\s*\[\s*\])?$/.test(m.slice(s + 1, close).trim())) {
        s = close + 1;
        continue;
      }
      break;
    }
    const text = this.clean.slice(s, e);
    if (!/\bnew\b/i.test(text)) return this.expr(s, e);
    const ternary = this.ternarySplit(s, e);
    if (ternary) {
      return (
        this.collectionArg(ternary[0] + 1, ternary[1]) ?? this.collectionArg(ternary[1] + 1, e)
      );
    }
    if (/^new\b/i.test(text)) {
      // `new List<String>{ a, b }` (elements) or `new List<String>(copy)` (constructor arguments).
      const brace = m.indexOf("{", s);
      const paren = m.indexOf("(", s);
      let inner: [number, number] | null = null;
      // The `new Type<...>` header must come right before the opener (not `new X{...}.clone()`).
      const header = (at: number): boolean =>
        /^new\s+[A-Za-z_][\w.]*(?:\s*<[^()]*>)?(?:\s*\[\s*\])?\s*$/i.test(m.slice(s, at));
      if (brace >= 0 && brace < e && header(brace) && matchClose(m, brace) === e - 1)
        inner = [brace + 1, e - 1];
      else if (paren >= 0 && paren < e && header(paren) && matchClose(m, paren) === e - 1)
        inner = [paren + 1, e - 1];
      if (inner) {
        for (const [es, ee] of pieces(m, inner[0], inner[1], ",")) {
          const t = this.collectionArg(es, ee);
          if (t) return t;
        }
        return null;
      }
    }
    return this.anyIdentifier(s, e);
  }

  /** The first declared, tainted variable named in masked[a, b), ignoring escaped arguments. */
  private anyIdentifier(a: number, b: number): string | null {
    const slice = this.masked.slice(a, b);
    const chars = slice.split("");
    for (const esc of slice.matchAll(ESCAPE_ANYWHERE_RE)) {
      const open = (esc.index ?? 0) + esc[0].length - 1;
      const close = matchClose(slice, open);
      for (let k = esc.index ?? 0; k <= (close < 0 ? chars.length - 1 : close); k++) chars[k] = " ";
    }
    for (const hit of chars.join("").matchAll(/(?<![\w.])[A-Za-z_]\w*/g)) {
      if (!this.isDeclared(hit[0])) continue;
      const t = this.variable(hit[0]);
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
   * Every assignment to a declared variable, in source order. An assignment is `simple` when it
   * sits at the method body's own brace depth, outside every parenthesis (a `for` header, a
   * condition, a call argument) and is not the body of a braceless `if`/`else`/loop.
   */
  private collectAssignments(): Assignment[] {
    const m = this.masked;
    const out: Assignment[] = [];
    const base = m.indexOf("{") < 0 ? 0 : 1;
    let depth = 0;
    let parens = 0;
    let pos = 0;
    const re = /(?<![\w.])([A-Za-z_]\w*)\s*(\+?)=(?!=)/g;
    for (const hit of m.matchAll(re)) {
      const name = hit[1] ?? "";
      if (!this.isDeclared(name)) continue;
      const at = hit.index ?? 0;
      for (; pos < at; pos++) {
        const ch = m[pos];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        else if (ch === "(") parens += 1;
        else if (ch === ")") parens -= 1;
      }
      const stmt = Math.max(m.lastIndexOf(";", at), m.lastIndexOf("{", at), m.lastIndexOf("}", at));
      const prefix = m.slice(stmt + 1, at).trim();
      const braceless = /(?:\)|\belse|\bdo)$/i.test(prefix);
      const from = at + hit[0].length;
      const to = statementEnd(m, from);
      const ids = [...m.slice(from, to).matchAll(/(?<![\w.])[A-Za-z_]\w*/g)]
        .map((x) => x[0].toLowerCase())
        .filter((x) => this.isDeclared(x));
      out.push({
        name,
        plus: hit[2] === "+",
        at,
        from,
        to,
        ids,
        simple: depth === base && parens === 0 && !braceless,
      });
    }
    return out;
  }

  /**
   * The flow-insensitive taint of every variable, by a worklist: an assignment is re-evaluated
   * when a variable its right-hand side read changes. Taint only ever grows, and a chain of
   * thousands of aliases costs no stack. A parameter keeps its caller's text unless a plain
   * assignment replaced it; `+=` only appends; the parameter itself read inside its own
   * assignment is still the caller's text.
   */
  private solve(): void {
    if (this.fixed) return;
    this.assignments = this.collectAssignments();
    const fixed = new Map<string, string | null>();
    this.fixed = fixed;
    const all = this.assignments;
    const plainTo = new Set(all.filter((x) => !x.plus).map((x) => x.name.toLowerCase()));
    const readers = new Map<string, number[]>();
    this.mode = "fixed";
    const queue = all.map((_, i) => i);
    const queued = new Set(queue);
    const names = new Set(all.map((x) => x.name.toLowerCase()));
    for (const n of names) {
      const decl = this.declaration(n);
      const param = decl !== null && this.isParam(decl);
      fixed.set(n, param && !plainTo.has(n) && !this.safeType(decl?.type ?? "") ? n : null);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi] as number;
      queued.delete(i);
      const asg = all[i] as Assignment;
      const key = asg.name.toLowerCase();
      const seen = new Set<string>();
      this.reads = seen;
      this.target = key;
      const t = this.expr(asg.from, asg.to);
      this.reads = null;
      this.target = null;
      for (const r of [...seen, ...asg.ids]) {
        const list = readers.get(r);
        if (!list) readers.set(r, [i]);
        else if (!list.includes(i)) list.push(i);
      }
      if (t && !this.safeType(this.declaration(asg.name)?.type ?? "") && !fixed.get(key)) {
        fixed.set(key, t);
        for (const j of readers.get(key) ?? []) {
          if (!queued.has(j)) {
            queued.add(j);
            queue.push(j);
          }
        }
      }
    }
  }

  private safeType(type: string): boolean {
    return SAFE_TYPE_RE.test(type) || SAFE_GENERIC_RE.test(type);
  }

  /** Apply, in source order, the assignments that end before `limit` (see `provablySafe`). */
  private applyAssignmentsBefore(limit: number): void {
    const all = this.assignments ?? [];
    this.mode = "ordered";
    while (this.applied < all.length) {
      const a = all[this.applied];
      if (!a || a.to > limit) break;
      this.applied += 1;
      const key = a.name.toLowerCase();
      const t = this.expr(a.from, a.to);
      if (t) this.state.set(key, t);
      else if (!a.plus && a.simple) this.state.set(key, null);
    }
    this.mode = "fixed";
  }

  /** `name` when the variable can carry unescaped text into a query, else null. */
  private variable(name: string): string | null {
    const key = name.toLowerCase();
    const decl = this.declaration(name);
    if (!decl) return null;
    if (this.safeType(decl.type)) return null;
    this.reads?.add(key);
    if (this.mode === "ordered") {
      if (this.state.has(key)) return this.state.get(key) ?? null;
      return this.isParam(decl) ? name : null;
    }
    if (this.target === key && this.isParam(decl)) return name;
    if (this.fixed?.has(key)) return this.fixed.get(key) ?? null;
    return this.isParam(decl) ? name : null;
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
  const analyzer = new InjectionAnalyzer(text);
  const spots = analyzer.run(text);
  // Monotone by construction: run the released flow-insensitive analysis beside this one and keep
  // each finding it reports unless the lexical backstop proves no tainted parameter text is left.
  let baseline: ReturnType<typeof detectSoqlInjectionBaseline> = [];
  try {
    baseline = detectSoqlInjectionBaseline(code, opts);
  } catch {
    // A pathological unit (a very long alias chain) overflows the recursive baseline; the
    // current analysis alone stands.
    return spots;
  }
  if (baseline.length === 0) return spots;
  const kept: InjectionSpot[] = [...spots];
  for (const base of baseline) {
    // Match by the exact call offset; a finding that cannot be matched is kept.
    const i = base.at === undefined ? -1 : analyzer.sinks.findIndex((x) => x.at === base.at);
    if (i >= 0 && base.at !== undefined && analyzer.reportedAt.has(base.at)) continue;
    if (i >= 0 && !analyzer.backstop(i)) continue;
    const { at: _at, ...spot } = base;
    kept.push(spot);
  }
  return kept.sort((x, y) => x.line - y.line);
}
