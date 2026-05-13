/**
 * Tiny selector evaluator for rule files.
 *
 * Supports:
 *   ${path.to.field}                  — interpolation, namespace-stripped if ns is set
 *   ${path.to.field | raw}            — interpolation without namespace strip
 *   ${path.to.field || other.field}   — OR fallback
 *   ${a == 'foo'} / ${a != 'foo'}     — equality with string literal
 *   ${!a}                              — negation
 *   ${stripNs(record.x)}               — explicit stripNs helper
 *   ${split(record.x,'-')[0]}          — split + index helper
 *
 * Context binds:
 *   record  — parsed input object
 *   item    — current iteration element (or null)
 *   ns      — namespace string or null
 *   caps    — capability bag
 *
 * Undefined-safe: missing fields evaluate to '' in interpolations, false in conditionals.
 * Pure non-string primitives flow through (so a boolean prop value stays boolean).
 */

export interface EvalCtx {
  record: unknown;
  item: unknown;
  ns: string | null;
  caps: Record<string, unknown>;
}

function stripNs(name: string, ns: string | null): string {
  if (!ns) return name;
  const prefix = `${ns}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function walk(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const p = path[i] as string;
    if (cur === null || cur === undefined) return undefined;
    if (p === "*") {
      // Flatten current (array-of-objects or single-object) and apply
      // the remaining path to each element, collecting results.
      const arr = Array.isArray(cur) ? cur : [cur];
      const rest = path.slice(i + 1);
      if (rest.length === 0) return arr;
      const collected: unknown[] = [];
      for (const el of arr) {
        const v = walk(el, rest);
        if (Array.isArray(v)) collected.push(...v);
        else if (v !== undefined) collected.push(v);
      }
      return collected;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function resolveRoot(name: string, ctx: EvalCtx): unknown {
  switch (name) {
    case "record":
      return ctx.record;
    case "item":
      return ctx.item;
    case "ns":
      return ctx.ns;
    case "caps":
      return ctx.caps;
    default:
      return undefined;
  }
}

/**
 * Resolve a primitive path like `record.a.b` to its underlying value.
 * Returns undefined if any segment is missing.
 */
function resolvePath(path: string, ctx: EvalCtx): unknown {
  const parts = path.split(".");
  const head = parts.shift()!;
  return walk(resolveRoot(head, ctx), parts);
}

/**
 * Evaluate a single atom: either a path reference, a string literal,
 * a number, true/false, or a function call like stripNs(record.x).
 */
function evalAtom(token: string, ctx: EvalCtx): unknown {
  const t = token.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);

  // Function calls: stripNs(...), split(...)[i]
  const fn = /^([a-zA-Z_]\w*)\((.*)\)(?:\[(\d+)\])?$/.exec(t);
  if (fn) {
    const name = fn[1] as string;
    const argsRaw = fn[2] as string;
    const idx = fn[3] !== undefined ? Number(fn[3]) : undefined;
    const args = splitArgs(argsRaw).map((a) => evalExpr(a, ctx));
    let result: unknown;
    if (name === "stripNs") {
      result = stripNs(String(args[0] ?? ""), ctx.ns);
    } else if (name === "split") {
      const s = String(args[0] ?? "");
      const sep = String(args[1] ?? "");
      result = s.split(sep);
    } else if (name === "toString") {
      result = args[0] === undefined || args[0] === null ? "" : String(args[0]);
    } else if (name === "lower") {
      result = String(args[0] ?? "").toLowerCase();
    } else if (name === "bool") {
      result = Boolean(args[0]);
    } else if (name === "match") {
      // match(text, 'regex', 'flags'?) -> first capture group or full match
      const text = String(args[0] ?? "");
      const re = new RegExp(String(args[1] ?? ""), String(args[2] ?? ""));
      const m = re.exec(text);
      result = m ? (m[1] ?? m[0]) : "";
    } else if (name === "matchAll") {
      // matchAll(text, 'regex', 'flags'?) -> array of first-capture groups
      const text = String(args[0] ?? "");
      const flagsIn = String(args[2] ?? "g");
      const flags = flagsIn.includes("g") ? flagsIn : `${flagsIn}g`;
      const re = new RegExp(String(args[1] ?? ""), flags);
      const matches: string[] = [];
      for (const m of text.matchAll(re)) {
        matches.push(m[1] ?? m[0]);
      }
      result = matches;
    } else if (name === "splitCsv") {
      // splitCsv(text) -> array of trimmed non-empty parts
      const text = String(args[0] ?? "");
      result = text
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (name === "walkAll") {
      // walkAll(root, 'key') -> deep collect all values under that key in the tree
      const out: unknown[] = [];
      const target = String(args[1] ?? "");
      const visit = (n: unknown): void => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) {
          for (const x of n) visit(x);
          return;
        }
        const obj = n as Record<string, unknown>;
        if (target in obj) {
          const v = obj[target];
          if (Array.isArray(v)) out.push(...v);
          else if (v !== undefined && v !== null) out.push(v);
        }
        for (const v of Object.values(obj)) visit(v);
      };
      visit(args[0]);
      result = out;
    } else if (name === "stripPrefix") {
      // stripPrefix(text, 'pfx') — remove leading prefix if present
      const text = String(args[0] ?? "");
      const pfx = String(args[1] ?? "");
      result = text.startsWith(pfx) ? text.slice(pfx.length) : text;
    } else {
      result = undefined;
    }
    if (idx !== undefined && Array.isArray(result)) return result[idx];
    return result;
  }

  return resolvePath(t, ctx);
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Evaluate an expression that may include the ||, &&, ==, !=, ! operators
 * and a single sub-atom. Returns the underlying value (not just boolean).
 */
function evalExpr(expr: string, ctx: EvalCtx): unknown {
  let trimmed = expr.trim();
  // Strip a matched pair of outer parens (so "(a || b)" evaluates correctly).
  while (trimmed.startsWith("(") && trimmed.endsWith(")") && matchesOuterParens(trimmed)) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  // Top-level ||
  const orParts = topSplit(trimmed, "||");
  if (orParts.length > 1) {
    for (const p of orParts) {
      const v = evalExpr(p, ctx);
      if (truthy(v)) return v;
    }
    return evalExpr(orParts[orParts.length - 1] ?? "", ctx);
  }
  const andParts = topSplit(trimmed, "&&");
  if (andParts.length > 1) {
    let last: unknown = true;
    for (const p of andParts) {
      last = evalExpr(p, ctx);
      if (!truthy(last)) return false;
    }
    return last;
  }
  // ==, !=
  const eqMatch = topSplitOp(trimmed, ["==", "!="]);
  if (eqMatch) {
    const [lhs, op, rhs] = eqMatch;
    const lv = evalExpr(lhs, ctx);
    const rv = evalExpr(rhs, ctx);
    return op === "==" ? lv === rv : lv !== rv;
  }
  // Negation
  if (trimmed.startsWith("!")) {
    return !truthy(evalExpr(trimmed.slice(1), ctx));
  }
  return evalAtom(trimmed, ctx);
}

function matchesOuterParens(s: string): boolean {
  // Returns true if the outermost '(' at index 0 matches the ')' at the end.
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0 && i !== s.length - 1) return false;
    }
  }
  return depth === 0;
}

function truthy(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (v === false) return false;
  if (v === 0) return false;
  if (v === "") return false;
  return true;
}

function topSplit(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && s.slice(i, i + sep.length) === sep) {
      out.push(cur);
      cur = "";
      i += sep.length - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function topSplitOp(s: string, ops: string[]): [string, string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0) {
      for (const op of ops) {
        if (s.slice(i, i + op.length) === op) {
          // Avoid mistaking != as ! when checking single-char
          const after = s[i + op.length];
          // Make sure we don't see === or =, etc.
          if (op === "==" && after === "=") continue;
          return [s.slice(0, i).trim(), op, s.slice(i + op.length).trim()];
        }
      }
    }
  }
  return null;
}

/** Evaluate a template string like "Profile:${record.fullName}".
 * Returns a string when the template has any literal chars or multiple refs.
 * Returns the raw underlying value when the template is a single bare `${...}`
 * (so booleans / numbers / null flow through unmodified). */
export function evaluateString(template: string, ctx: EvalCtx): unknown {
  // Detect single-expression form: ^${...}$
  const single = /^\$\{([^}]+)\}$/.exec(template);
  if (single) {
    const exprBody = single[1] as string;
    return evalInterpolation(exprBody, ctx);
  }
  // Multi-part: concatenate
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("${", i);
    if (open === -1) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = template.indexOf("}", open + 2);
    if (close === -1) {
      out += template.slice(open);
      break;
    }
    const body = template.slice(open + 2, close);
    const v = evalInterpolation(body, ctx);
    if (v !== undefined && v !== null) out += String(v);
    i = close + 1;
  }
  return out;
}

function evalInterpolation(body: string, ctx: EvalCtx): unknown {
  // Support `expr | raw` suffix to suppress namespace stripping
  const pipeIdx = topPipe(body);
  let core = body;
  let raw = false;
  if (pipeIdx !== -1) {
    core = body.slice(0, pipeIdx).trim();
    const flag = body.slice(pipeIdx + 1).trim();
    if (flag === "raw") raw = true;
  }
  const v = evalExpr(core, ctx);
  if (typeof v === "string" && !raw && ctx.ns) {
    return stripNs(v, ctx.ns);
  }
  return v;
}

function topPipe(s: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && ch === "|" && s[i + 1] !== "|" && s[i - 1] !== "|") return i;
  }
  return -1;
}

/** Evaluate a predicate (boolean) expression. Used for `when`. */
export function evaluatePredicate(expr: string, ctx: EvalCtx): boolean {
  const single = /^\$\{([^}]+)\}$/.exec(expr);
  const body = single ? (single[1] as string) : expr;
  return truthy(evalExpr(body, ctx));
}

/** Evaluate an expression, returning the raw value (for `iterate`). */
export function evaluateRaw(expr: string, ctx: EvalCtx): unknown {
  const single = /^\$\{([^}]+)\}$/.exec(expr);
  const body = single ? (single[1] as string) : expr;
  return evalExpr(body, ctx);
}
