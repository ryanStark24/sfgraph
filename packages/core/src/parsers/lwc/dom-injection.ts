/**
 * DOM injection in component JavaScript (LWC and Aura): assignments to
 * `innerHTML` / `outerHTML` and `insertAdjacentHTML(...)` calls. Run by the LWC
 * and Aura bundle parsers, which stamp the result on the component node as
 * `domInjection`; the security scan only reads that attribute.
 *
 * Not reported: reading `innerHTML`, `textContent` / `innerText` assignment, and
 * clearing (`el.innerHTML = ''`). An assignment of a plain string literal is
 * reported at `low` (static markup, no data flows in, but it still bypasses the
 * template's escaping); anything else at `high`.
 */

export interface DomInjectionSpot {
  /** The file inside the bundle (`bookingNotes.js`). */
  file: string;
  /** 1-based line of the assignment or call. */
  line: number;
  /** `innerHTML`, `outerHTML` or `insertAdjacentHTML`. */
  kind: "innerHTML" | "outerHTML" | "insertAdjacentHTML";
  severity: "high" | "low";
  /** The source line, trimmed, cut at 200 characters. */
  evidence: string;
  /** True when the component template declares `lwc:dom="manual"` (LWC only). */
  lwcDomManual?: boolean;
}

/** Most spots kept per component (a generated file must not bloat the graph). */
export const DOM_SPOTS_MAX = 50;

/** Length-preserving: comments become spaces, string and template literal text is kept. */
function stripJsComments(src: string): string {
  const out = src.split("");
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
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
    } else if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (q !== "`" && src[i] === "\n") break;
        i += src[i] === "\\" ? 2 : 1;
      }
      i++;
    } else i++;
  }
  return out.join("");
}

/**
 * Length-preserving: string literal contents and template-literal text become spaces (quotes
 * and `${...}` expressions are kept), so a sink named inside a string is not located.
 * Expects comment-stripped input.
 */
function maskStrings(src: string): string {
  const out = src.split("");
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Blank a template literal starting after its opening backtick at i; returns the index after it.
  const template = (start: number): number => {
    let i = start;
    let from = i;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") i += 2;
      else if (src[i] === "$" && src[i + 1] === "{") {
        blank(from, i);
        i = expression(i + 2);
        from = i;
      } else i++;
    }
    blank(from, Math.min(i, src.length));
    return i + 1;
  };
  // Walk a `${...}` expression body (code, so strings inside are masked); returns the index after `}`.
  const expression = (start: number): number => {
    let i = start;
    let d = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") {
        const a = i;
        while (i < src.length && src[i] !== "\n") i++;
        blank(a, i);
      } else if (c === "/" && src[i + 1] === "*") {
        const a = i;
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i = Math.min(i + 2, src.length);
        blank(a, i);
      } else if (c === "'" || c === '"') i = quoted(i);
      else if (c === "`") i = template(i + 1);
      else if (c === "{") {
        d++;
        i++;
      } else if (c === "}") {
        if (d === 0) return i + 1;
        d--;
        i++;
      } else i++;
    }
    return i;
  };
  const quoted = (at: number): number => {
    const q = src[at];
    let i = at + 1;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\n") break;
      i += src[i] === "\\" ? 2 : 1;
    }
    blank(at + 1, i);
    return i + 1;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') i = quoted(i);
    else if (c === "`") i = template(i + 1);
    else i++;
  }
  return out.join("");
}

const ASSIGN_RE = /\.\s*(innerHTML|outerHTML)\s*(\+?=)(?!=)\s*/g;
const INSERT_RE = /\.\s*insertAdjacentHTML\s*\(/g;

/**
 * A plain string literal (no `${}`), possibly concatenated only with other plain literals.
 * `masked` is the same text as `rhs` with string contents blanked, so only a `+` operator
 * outside a string literal splits it.
 */
function isLiteralOnly(rhsIn: string, maskedIn: string): boolean {
  // `'a'.concat('b', 'c')` with literal receiver and arguments reads as `'a' + 'b' + 'c'`.
  // `rhsIn` and `maskedIn` have the same length, so the same span is rewritten in both.
  let rhs = rhsIn.replace(/[\s;]+$/, "");
  let masked = maskedIn.slice(0, rhs.length);
  for (;;) {
    const m = /\.\s*concat\s*\(([^()]*)\)$/.exec(masked);
    if (!m) break;
    const argStart = m.index + m[0].indexOf("(") + 1;
    const rewrite = (t: string): string => {
      const args = [...t.slice(argStart, t.length - 1)]
        .map((ch, k) => (masked[argStart + k] === "," ? "+" : ch))
        .join("");
      return `${t.slice(0, m.index)}+${args}`;
    };
    const nextMasked = rewrite(masked);
    rhs = rewrite(rhs);
    masked = nextMasked;
  }
  const trimmed = rhs.replace(/[\s,)]+$/, "");
  if (trimmed.trim() === "") return false;
  const parts: string[] = [];
  let from = 0;
  for (let k = 0; k < trimmed.length; k++) {
    if (masked[k] === "+") {
      parts.push(trimmed.slice(from, k));
      from = k + 1;
    }
  }
  parts.push(trimmed.slice(from));
  return parts.every((raw) => {
    const p = raw.trim();
    return (
      /^'(?:[^'\\]|\\.)*'$/.test(p) ||
      /^"(?:[^"\\]|\\.)*"$/.test(p) ||
      /^`(?:[^`\\$]|\\[\s\S]|\$(?!\{))*`$/.test(p)
    );
  });
}

const isEmptyLiteral = (rhs: string): boolean => /^\s*(?:''|""|``)\s*;?\s*$/.test(rhs);

/** Operators (longest first) that join two operands, so a line starting with one continues the expression. */
const CONTINUE_START_RE =
  /^(?:\?\.(?!\d)|\.(?!\d)|\?\?|\|\||&&|===|!==|==|!=|<=|>=|\+(?!\+)|-(?!-)|[*%/?:<>|&^[(`]|(?:instanceof|in)(?![\w$]))/;
const CONTINUE_END_RE =
  /(?:\?\?|\|\||&&|===|!==|==|!=|<=|>=|[*%/?:<>|&^=([{,]|(?<!\+)\+|(?<!-)-|(?<![\w$])(?:instanceof|in))$/;

/**
 * JS automatic semicolon insertion, as far as this check needs it: a line break at bracket
 * depth 0 does not end the expression when the previous line ends in an operator (`p` is the
 * index of its last non-blank character) or the next non-blank line (starting at `n`) begins
 * with a token that cannot start a statement and joins operands (`.`, `?.`, `[`, `(`, a
 * template, a binary or logical operator). A prefix `++`/`--` starts a new statement.
 */
function lineContinues(masked: string, p: number, n: number, from: number): boolean {
  if (p >= from && CONTINUE_END_RE.test(masked.slice(from, p + 1))) return true;
  return n < masked.length && CONTINUE_START_RE.test(masked.slice(n, n + 12));
}

/**
 * End index (exclusive) of the expression that starts at `from` in comment-and-string-masked
 * code: the first `;` at depth 0, an unmatched closing bracket, or a line break at depth 0
 * unless the expression continues under JS automatic-semicolon-insertion rules (see `lineContinues`). A line break inside a template literal (text or `${...}`) never ends it.
 */
function expressionEnd(masked: string, from: number): number {
  let d = 0;
  // Template literals: the mask blanks their text but keeps the backticks, `${` and the
  // newlines, so a line break inside template text must not end the expression. `open`
  // holds the bracket depth at each `${` still open.
  let inTemplate = false;
  const open: number[] = [];
  for (let j = from; j < masked.length; j++) {
    const c = masked[j];
    if (inTemplate) {
      if (c === "`") inTemplate = false;
      else if (c === "$" && masked[j + 1] === "{") {
        open.push(d);
        d += 1;
        j += 1;
        inTemplate = false;
      }
      continue;
    }
    if (c === "`") inTemplate = true;
    else if (c === "}" && open.length > 0 && open[open.length - 1] === d - 1) {
      open.pop();
      d -= 1;
      inTemplate = true;
    } else if (c === "(" || c === "[" || c === "{") d += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (d === 0) return j;
      d -= 1;
    } else if (c === ";" && d === 0) return j;
    else if (c === "\n" && d === 0) {
      let p = j - 1;
      while (p >= from && /\s/.test(masked[p] ?? "")) p--;
      let n = j + 1;
      while (n < masked.length && /\s/.test(masked[n] ?? "")) n++;
      if (!lineContinues(masked, p, n, from)) return j;
    }
  }
  return masked.length;
}

/** The spots in one JS file. */
export function detectDomInjection(file: string, source: string): DomInjectionSpot[] {
  if (!source || !/innerHTML|outerHTML|insertAdjacentHTML/.test(source)) return [];
  const clean = stripJsComments(source);
  const masked = maskStrings(clean);
  const lineAt = (idx: number): number => {
    let n = 1;
    for (let k = 0; k < idx; k++) if (clean.charCodeAt(k) === 10) n += 1;
    return n;
  };
  const lines = source.split("\n");
  const evidenceAt = (line: number): string => (lines[line - 1] ?? "").trim().slice(0, 200);
  const out: DomInjectionSpot[] = [];
  for (const m of masked.matchAll(ASSIGN_RE)) {
    // Sink located on the masked text; the right-hand side is read from the original and
    // runs to the end of the statement, across line breaks.
    const rhsAt = (m.index ?? 0) + m[0].length;
    const rhsEnd = expressionEnd(masked, rhsAt);
    const rhs = clean.slice(rhsAt, rhsEnd);
    const rhsMasked = masked.slice(rhsAt, rhsEnd);
    if (m[2] === "=" && isEmptyLiteral(rhs)) continue;
    const line = lineAt(m.index ?? 0);
    out.push({
      file,
      line,
      kind: m[1] === "outerHTML" ? "outerHTML" : "innerHTML",
      severity: isLiteralOnly(rhs, rhsMasked) ? "low" : "high",
      evidence: evidenceAt(line),
    });
  }
  for (const m of masked.matchAll(INSERT_RE)) {
    const open = (m.index ?? 0) + m[0].length;
    // The second argument is the markup.
    let d = 0;
    let comma = -1;
    let end = masked.length;
    for (let j = open; j < masked.length; j++) {
      const c = masked[j];
      if (c === "(" || c === "[" || c === "{") d += 1;
      else if (c === ")" || c === "]" || c === "}") {
        if (d === 0) {
          end = j;
          break;
        }
        d -= 1;
      } else if (c === "," && d === 0 && comma < 0) comma = j;
    }
    const markup = comma < 0 ? "" : clean.slice(comma + 1, end);
    const maskedMarkup = comma < 0 ? "" : masked.slice(comma + 1, end);
    const line = lineAt(m.index ?? 0);
    out.push({
      file,
      line,
      kind: "insertAdjacentHTML",
      severity: isLiteralOnly(markup, maskedMarkup) ? "low" : "high",
      evidence: evidenceAt(line),
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** True when a template declares `lwc:dom="manual"`. */
export function hasLwcDomManual(html: string): boolean {
  return /\blwc:dom\s*=\s*["']manual["']/.test(html);
}
