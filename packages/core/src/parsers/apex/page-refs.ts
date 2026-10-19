import { type EdgeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";

// `Page.MyPage`, `Page.MyPage.getUrl()`, `new PageReference(Page.X…)`; not
// `page.getParameters()` (a PageReference variable's method).
const PAGE_REF_RE = /(?<![\w.$])page\s*\.\s*([A-Za-z][A-Za-z0-9_]*)\b(?!\s*\()/gi;
// A variable or parameter named `page`, capturing its declared type.
const PAGE_DECL_RE =
  /(?<![\w.$])([A-Za-z_][\w.]*)\s*(?:<[^;=(){}]*>)?\s*(?:\[\s*\])?\s+page\s*[=;,):]/gi;
const NOT_TYPES = new Set(["return", "new", "else", "throw"]);

/**
 * `Page.<name>` in Apex → REFERENCES `ApexPage:<name>` (`via: "Page"`), so a
 * Visualforce page reached only from a controller redirect is not dead code.
 * `code` is comment- and string-stripped. Apex is case-insensitive, so when
 * the file declares a variable `page` of a type other than PageReference,
 * `page.x` there is that variable's member and nothing is emitted.
 */
export function emitPageRefEdges(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  edges: EdgeFact[],
): void {
  for (const d of code.matchAll(PAGE_DECL_RE)) {
    const type = (d[1] ?? "").toLowerCase();
    if (NOT_TYPES.has(type)) continue;
    if (type !== "pagereference" && type !== "system.pagereference") return;
  }
  const seen = new Set<string>();
  for (const m of code.matchAll(PAGE_REF_RE)) {
    const dst = `ApexPage:${stripNs(m[1] ?? "", ctx.namespace)}`;
    const key = dst.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(makeEdge(ctx, srcQname, REL_TYPES.REFERENCES, dst, { via: "Page" }));
  }
}
