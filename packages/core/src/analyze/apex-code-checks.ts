import { computeLoopRanges } from "../parsers/apex/class.js";
import { maskApex } from "../parsers/apex/dynamic-soql.js";

/**
 * `detectAsyncInLoop`: async work started inside a loop body of one Apex unit (a
 * method body or a whole trigger, as the parser stores it as a snippet), for the
 * governor scan (`governor.async-in-loop`). It works on the unit's text only; its limits
 * are stated on the function. Lines are 1-based within the text. (The SOQL injection
 * detector is `parsers/apex/soql-injection.ts`: it runs at parse time.)
 */

export interface CodeSpot {
  /** 1-based line within the unit's text. */
  line: number;
  /** The source line, trimmed and cut at 200 characters. */
  evidence: string;
  /** What was found (the call, for async work). */
  kind: string;
}

const lineOfIndex = (text: string, idx: number): number => {
  let n = 1;
  for (let k = 0; k < idx && k < text.length; k++) if (text.charCodeAt(k) === 10) n += 1;
  return n;
};

/** The trimmed text of the line holding `idx`. */
const lineText = (text: string, idx: number): string => {
  const s = text.lastIndexOf("\n", idx - 1) + 1;
  const e = text.indexOf("\n", idx);
  return text
    .slice(s, e < 0 ? text.length : e)
    .trim()
    .slice(0, 200);
};

// ---------------------------------------------------------------------------
// Async work in a loop
// ---------------------------------------------------------------------------

/** The async / limited calls that are always a call on a known class. */
const ASYNC_CALL_RE =
  /(?<![\w.])(System\s*\.\s*enqueueJob|Database\s*\.\s*executeBatch|EventBus\s*\.\s*publish|Messaging\s*\.\s*sendEmail)\s*\(/gi;

const ASYNC_CANON: Record<string, string> = {
  "system.enqueuejob": "System.enqueueJob",
  "database.executebatch": "Database.executeBatch",
  "eventbus.publish": "EventBus.publish",
  "messaging.sendemail": "Messaging.sendEmail",
};

export interface AsyncInLoopOpts {
  /** Lower-cased `Class.method` of every `@future` method in the org. */
  futureMethods?: ReadonlySet<string>;
  /**
   * Parameter counts of each `@future` method, keyed like `futureMethods`. A call is matched only
   * when its argument count is in the set, so a synchronous overload of another arity is not
   * reported. A key with no entry, or a call whose arguments cannot be counted, keeps reporting.
   */
  futureArities?: ReadonlyMap<string, ReadonlySet<number>>;
  /** The class the unit is in (lower-cased `Outer.Inner`), for unqualified calls. */
  ownerClass?: string;
}

/**
 * Async work started inside a `for`, `while` or `do` loop body: `System.enqueueJob`,
 * `Database.executeBatch`, `EventBus.publish`, `Messaging.sendEmail`, and a call to
 * an `@future` method written `Class.method(...)` or, inside its own class,
 * `method(...)`. Strings and comments are ignored. Direct only: a loop that calls a
 * helper which enqueues is not followed, and a call on an instance variable
 * (`svc.notify(...)`) is not matched to a method because the variable's type is not
 * resolved. A braceless one-statement loop body counts, like the other loop checks.
 */
export function detectAsyncInLoop(code: string, opts: AsyncInLoopOpts = {}): CodeSpot[] {
  if (!code) return [];
  const masked = maskApex(code);
  const ranges = computeLoopRanges(masked);
  if (ranges.length === 0) return [];
  const inLoop = (idx: number): boolean => ranges.some((r) => idx > r.start && idx < r.end);
  const out: CodeSpot[] = [];
  for (const m of masked.matchAll(ASYNC_CALL_RE)) {
    const idx = m.index ?? 0;
    if (!inLoop(idx)) continue;
    const key = (m[1] ?? "").replace(/\s+/g, "").toLowerCase();
    out.push({
      line: lineOfIndex(code, idx),
      evidence: lineText(code, idx),
      kind: ASYNC_CANON[key] ?? key,
    });
  }
  const future = opts.futureMethods;
  if (future && future.size > 0) {
    const CALL_RE = /(?<![\w.])(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/g;
    for (const m of masked.matchAll(CALL_RE)) {
      const idx = m.index ?? 0;
      if (!inLoop(idx)) continue;
      const cls = (m[1] ?? opts.ownerClass ?? "").toLowerCase();
      const name = (m[2] ?? "").toLowerCase();
      if (!cls || !future.has(`${cls}.${name}`)) continue;
      const arities = opts.futureArities?.get(`${cls}.${name}`);
      if (arities) {
        const n = countCallArguments(masked, idx + m[0].length);
        if (n !== null && !arities.has(n)) continue;
      }
      out.push({
        line: lineOfIndex(code, idx),
        evidence: lineText(code, idx),
        kind: `@future ${m[1] ? `${m[1]}.` : ""}${m[2]}`,
      });
    }
  }
  out.sort((a, b) => a.line - b.line);
  return out;
}

/**
 * Number of top-level arguments of a call whose `(` just before `from` is already consumed, on
 * masked code (strings blanked). Commas inside nested `()`, `[]`, `{}` and generic `<...>` do not
 * count. Null when the closing paren is not found (the arity is unknown).
 */
export function countCallArguments(masked: string, from: number): number | null {
  let depth = 0;
  let commas = 0;
  let sawContent = false;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i] as string;
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      sawContent = true;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return c === ")" ? (sawContent ? commas + 1 : 0) : null;
      depth--;
    } else if (c === "<" && depth === 0 && /\w/.test(masked[i - 1] ?? "")) {
      const re = /<[\w\s,.<>?]*>/y;
      re.lastIndex = i;
      const g = re.exec(masked);
      if (g) {
        i += g[0].length - 1;
        sawContent = true;
      }
    } else if (c === "," && depth === 0) {
      commas++;
    } else if (!/\s/.test(c)) {
      sawContent = true;
    }
  }
  return null;
}

export { detectSoqlInjection } from "../parsers/apex/soql-injection.js";
export type { InjectionSpot } from "../parsers/apex/soql-injection.js";
