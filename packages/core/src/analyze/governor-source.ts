import type { OrgId, QualifiedName } from "@ryanstark24/sfgraph-shared";
import { maskApex } from "../parsers/apex/dynamic-soql.js";
import { blankBracketGroups, findInlineQueries } from "../parsers/apex/soql-fields.js";
import type { GraphStore } from "../storage/interfaces.js";

/**
 * The two governor checks that read Apex source text, in one place: the live
 * scan (`findGovernorRisks`) and the cache (`populateGovernorRisks`) both call
 * these, so they cannot drift. The text is a stored snippet (an Apex method's
 * body or a trigger's whole text, as the parser keeps it) or, for graphs
 * written by older tools, a node's `source` / `body` attribute.
 *
 * `unbounded_query`: an inline `[SELECT ...]` that has no `LIMIT` and no
 * `WHERE` in its own (outermost) clause. Calibration:
 *  - `return [SELECT Id FROM Account];` is unbounded.
 *  - Any `LIMIT`, or any `WHERE` (`WHERE Id = :id`, `WHERE Id IN :ids`, a
 *    filter on any field), is not: selectivity is not judged.
 *  - A `WHERE` or `LIMIT` inside a parenthesised subquery or a bound
 *    `[SELECT ...]` does not bound the outer query; each bound query is
 *    checked on its own.
 *  - `SELECT COUNT() FROM ...` returns a number, not rows, and is not flagged;
 *    nor is a Custom Metadata Type (`FROM Name__mdt`), a small configuration
 *    table.
 *  - Queries in comments or string literals are ignored; dynamic SOQL built
 *    from strings is not looked at.
 *
 * `no_bulk` (triggers only): the trigger reads a single record of
 * `Trigger.new` / `Trigger.old` by a literal position (`Trigger.new[0]`,
 * `Trigger.new.get(0)`), has no `for` loop over `Trigger.new`, `Trigger.old`,
 * `Trigger.newMap` or `Trigger.oldMap`, and uses those collections nowhere
 * else (passing `Trigger.new` to a handler counts as handling the collection).
 * A trigger that never mentions them, or only delegates, is not flagged: the
 * check cannot see inside the handler.
 */

export interface SourceRisk {
  risk: "unbounded_query" | "no_bulk";
  evidence: string;
  /** 1-based line within the text, -1 when the risk has no single line. */
  line: number;
}

const lineOf = (text: string, idx: number): number => {
  let n = 1;
  for (let k = 0; k < idx && k < text.length; k++) if (text[k] === "\n") n += 1;
  return n;
};

/** Blank (length-preserving) every `( ... )` group, so only the outermost clause is left. */
function blankParenGroups(s: string): string {
  const chars = s.split("");
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") {
      depth++;
      if (depth > 1) chars[i] = " ";
    } else if (c === ")" && depth > 0) {
      depth--;
      if (depth > 0) chars[i] = " ";
    } else if (depth > 0 && c !== "\n") chars[i] = " ";
  }
  return chars.join("");
}

/** Is this query (the text after `[SELECT`, comments and strings masked) unbounded? */
export function isUnboundedQuery(inner: string): boolean {
  const own = blankParenGroups(blankBracketGroups(inner));
  if (/\bLIMIT\b/i.test(own) || /\bWHERE\b/i.test(own)) return false;
  if (/^\s*count\s*\(\s*\)\s+from\b/i.test(own)) return false;
  if (/\bfrom\s+\w+__mdt\b/i.test(own)) return false;
  return true;
}

export function detectUnboundedQueries(code: string): SourceRisk[] {
  if (!code) return [];
  const out: SourceRisk[] = [];
  for (const q of findInlineQueries(maskApex(code))) {
    if (!isUnboundedQuery(q.inner)) continue;
    out.push({
      risk: "unbounded_query",
      evidence: code
        .slice(q.index, q.index + q.text.length)
        .trim()
        .slice(0, 200),
      line: lineOf(code, q.index),
    });
  }
  return out;
}

const TRIGGER_COLLECTION = "Trigger\\s*\\.\\s*(?:new|old|newMap|oldMap)\\b";
const TRIGGER_COLLECTION_RE = new RegExp(TRIGGER_COLLECTION, "i");
const SINGLE_RECORD_RE =
  /\bTrigger\s*\.\s*(?:new|old)\s*(?:\[\s*\d+\s*\]|\.\s*get\s*\(\s*\d+\s*\))/gi;

/** The text inside the parentheses of each `for (...)` header (balanced). */
function forHeaders(masked: string): string[] {
  const out: string[] = [];
  const re = /\bfor\s*\(/gi;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    let depth = 1;
    let j = m.index + m[0].length;
    const start = j;
    for (; j < masked.length && depth > 0; j++) {
      if (masked[j] === "(") depth++;
      else if (masked[j] === ")") depth--;
    }
    out.push(masked.slice(start, j - 1));
  }
  return out;
}

export function detectNotBulkTrigger(code: string): SourceRisk | null {
  if (!code || !/\btrigger\s+\w+\s+on\s+\w+/i.test(code)) return null;
  const masked = maskApex(code);
  const first = new RegExp(SINGLE_RECORD_RE.source, "i").exec(masked);
  if (!first) return null;
  if (forHeaders(masked).some((h) => TRIGGER_COLLECTION_RE.test(h))) return null;
  // Any other use of the trigger collections (a handler call, `.size()`, a map
  // lookup) means the whole collection is in play: not judged.
  if (TRIGGER_COLLECTION_RE.test(masked.replace(SINGLE_RECORD_RE, " "))) return null;
  return {
    risk: "no_bulk",
    evidence: `${code.slice(first.index, first.index + first[0].length).replace(/\s+/g, "")} used without a loop over the trigger's records`,
    line: lineOf(code, first.index),
  };
}

/** Both source checks on one unit's text; `isTrigger` adds the trigger-only one. */
export function detectSourceRisks(code: string, opts: { isTrigger: boolean }): SourceRisk[] {
  const out = detectUnboundedQueries(code);
  if (opts.isTrigger) {
    const nb = detectNotBulkTrigger(code);
    if (nb) out.push(nb);
  }
  return out;
}

/**
 * The source risks of one stored unit (an ApexMethod, TestMethod or
 * ApexTrigger) as the live scan and the cache both read them: from its stored
 * snippet. A unit with no snippet has none. The query text on EXECUTES_SOQL
 * edges is not used: one edge stands for every query on the same object in the
 * unit and the text is cut at 500 characters, so it cannot show that a query is
 * unbounded.
 */
export function unitSourceRisks(
  store: GraphStore,
  orgId: OrgId,
  qname: QualifiedName,
  opts: { isTrigger: boolean },
): SourceRisk[] {
  const text = store.getSnippet(orgId, qname)?.sourceText;
  return text ? detectSourceRisks(text, opts) : [];
}
