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

const ASSIGN_RE = /\.\s*(innerHTML|outerHTML)\s*(\+?=)(?!=)\s*([^;\n]*)/g;
const INSERT_RE = /\.\s*insertAdjacentHTML\s*\(/g;

/** A plain string literal (no `${}`), possibly concatenated only with other plain literals. */
function isLiteralOnly(rhs: string): boolean {
  const t = rhs.trim().replace(/[,)]+$/, "");
  if (t === "") return false;
  const parts = t.split(/\s*\+\s*/);
  return parts.every(
    (p) => /^'(?:[^'\\]|\\.)*'$/.test(p) || /^"(?:[^"\\]|\\.)*"$/.test(p) || /^`[^`$]*`$/.test(p),
  );
}

const isEmptyLiteral = (rhs: string): boolean => /^\s*(?:''|""|``)\s*;?\s*$/.test(rhs);

/** The spots in one JS file. */
export function detectDomInjection(file: string, source: string): DomInjectionSpot[] {
  if (!source || !/innerHTML|outerHTML|insertAdjacentHTML/.test(source)) return [];
  const clean = stripJsComments(source);
  const lineAt = (idx: number): number => {
    let n = 1;
    for (let k = 0; k < idx; k++) if (clean.charCodeAt(k) === 10) n += 1;
    return n;
  };
  const lines = source.split("\n");
  const evidenceAt = (line: number): string => (lines[line - 1] ?? "").trim().slice(0, 200);
  const out: DomInjectionSpot[] = [];
  for (const m of clean.matchAll(ASSIGN_RE)) {
    const rhs = m[3] ?? "";
    if (m[2] === "=" && isEmptyLiteral(rhs)) continue;
    const line = lineAt(m.index ?? 0);
    out.push({
      file,
      line,
      kind: m[1] === "outerHTML" ? "outerHTML" : "innerHTML",
      severity: isLiteralOnly(rhs) ? "low" : "high",
      evidence: evidenceAt(line),
    });
  }
  for (const m of clean.matchAll(INSERT_RE)) {
    const open = (m.index ?? 0) + m[0].length;
    // The second argument is the markup.
    let d = 0;
    let comma = -1;
    let end = clean.length;
    for (let j = open; j < clean.length; j++) {
      const c = clean[j];
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
    const line = lineAt(m.index ?? 0);
    out.push({
      file,
      line,
      kind: "insertAdjacentHTML",
      severity: isLiteralOnly(markup) ? "low" : "high",
      evidence: evidenceAt(line),
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** True when a template declares `lwc:dom="manual"`. */
export function hasLwcDomManual(html: string): boolean {
  return /\blwc:dom\s*=\s*["']manual["']/.test(html);
}
