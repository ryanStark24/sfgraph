import { createHash } from "node:crypto";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import type { SnippetRecord } from "../../storage/interfaces.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { APEX_NODE_HASH_SALT } from "../hash-salts.js";
import {
  type ClassRefScope,
  NEW_INSTANCE_RE,
  STATIC_CALL_RE,
  emitClassRefEdges,
  emitDescribeRefEdges,
  emitStaticCallEdges,
  emitTypeRefEdges,
  isUserClassName,
  localVarNames,
} from "./class-refs.js";
import { parseAnnotations, stripCommentsAndStrings } from "./common.js";
import {
  PLACEHOLDER,
  dynamicSoqlClauseFields,
  foldDynamicSoql,
  maskApex,
  parseDynamicSoql,
} from "./dynamic-soql.js";
import {
  type FieldAccess,
  classScopes,
  collectDecls,
  extractFieldAccesses,
  paramDecls,
} from "./field-access.js";
import { blankBracketGroups, findInlineQueries, soqlFieldRefs } from "./soql-fields.js";
import {
  classStringConstants,
  extractVlocityCalls,
  extractVlocityDispatch,
  stripCommentsOnly,
} from "./vlocity-calls.js";
export { APEX_NODE_HASH_SALT } from "../hash-salts.js";

/**
 * apex-parser (antlr4ts) keeps a DFA cache on each grammar's static ATN. It is
 * per isolate, it is never trimmed, and it grows with every distinct input:
 * over a large Vlocity corpus it held ~190 MB live (and a 2-4x larger V8 heap) in each
 * parse worker. The cache is only a memo for prediction, so dropping it does
 * not change any parse result. Release it after this many syntax checks in the
 * current isolate (each parse worker, or the main thread in serial mode).
 * Measured on a large Vlocity repo, 4 workers: 50 cut peak RSS by ~1.07 GB for ~5% more parse
 * time.
 */
export const APEX_DFA_CLEAR_INTERVAL = 50;
let apexChecksSinceDfaClear = 0;

/** Count one apex-parser syntax check; clear the lexer and parser DFA when due. */
function noteApexSyntaxCheck(lexer: any, parser: any): void {
  apexChecksSinceDfaClear++;
  if (apexChecksSinceDfaClear < APEX_DFA_CLEAR_INTERVAL) return;
  apexChecksSinceDfaClear = 0;
  lexer?.interpreter?.clearDFA();
  parser?.interpreter?.clearDFA();
}

/** Test hook: restart the DFA-release counter for this isolate. */
export function resetApexDfaCounterForTest(): void {
  apexChecksSinceDfaClear = 0;
}

export interface ApexClassInput {
  className: string;
  body: string;
  metaXml?: string;
  isTrigger?: boolean;
}

interface MethodInfo {
  name: string;
  params: string[];
  returnType: string;
  modifiers: string[];
  annotations: string[];
  body: string;
  startIdx: number;
  endIdx: number;
}

// Modifiers are optional (`*`, not `+`): a method with NO explicit access
// modifier is implicitly private in Apex and is still a real method — the old
// `+` silently dropped every unmodified helper/inner-class method. Allowing
// zero modifiers means the regex can also touch control-flow that happens to
// look like `<word> <word>(...) {` (notably `else if (x) {`), so findMethods
// rejects any match whose return-type or name is a reserved keyword.
const METHOD_RE =
  /(?:@[\w()=,'"\s.]+\s+)*(?:(public|private|protected|global|virtual|override|abstract|static|webservice|with\s+sharing|without\s+sharing|inherited\s+sharing|testmethod|final)\s+)*([A-Za-z_][\w<>,.\s\[\]]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/gi;

// Apex reserved words that can appear as `<kw> <kw>(...) {` but are NOT method
// declarations. If the captured return-type or method-name is one of these, the
// match is control flow / a statement, not a method.
const NON_METHOD_KEYWORDS = new Set([
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "catch",
  "try",
  "finally",
  "return",
  "new",
  "throw",
  "when",
]);

// Access/sharing/definition modifiers. When the regex makes modifiers optional,
// a CONSTRUCTOR `public Foo(...) {` backtracks to returnType="public", name="Foo"
// (the class name) — a phantom method. A real method's return type is a TYPE,
// never a modifier, so a modifier captured AS the return type means we matched a
// constructor (or other non-method) and must drop it.
const MODIFIER_KEYWORDS = new Set([
  "public",
  "private",
  "protected",
  "global",
  "virtual",
  "override",
  "abstract",
  "static",
  "webservice",
  "with",
  "without",
  "inherited",
  "sharing",
  "testmethod",
  "final",
]);

function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split `raw` on commas at generic/bracket/paren depth 0, so
 * `Map<Id, Contact> a, List<String> b` is two items, not three.
 */
function splitTopLevel(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of raw) {
    if (c === "<" || c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ">" || c === ")" || c === "]" || c === "}") && depth > 0) depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

function parseParams(raw: string): string[] {
  return splitTopLevel(raw);
}

/** `Database.Batchable<SObject>` -> `Database.Batchable` (whitespace-normalised). */
function stripTypeArgs(t: string): string {
  const lt = t.indexOf("<");
  return (lt >= 0 ? t.slice(0, lt) : t).replace(/\s+/g, "");
}

/** Remove `@Name` / `@Name(...)` annotations (balanced parens) from `text`. */
function stripAnnotations(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") {
      out += text[i];
      continue;
    }
    let j = i + 1;
    while (j < text.length && /\w/.test(text[j] ?? "")) j++;
    let k = j;
    while (k < text.length && /\s/.test(text[k] ?? "")) k++;
    if (text[k] === "(") {
      let d = 0;
      for (; k < text.length; k++) {
        if (text[k] === "(") d++;
        else if (text[k] === ")" && --d === 0) break;
      }
      j = k + 1;
    }
    out += " ";
    i = j - 1;
  }
  return out;
}

/**
 * Header of the file's OUTER type: the first `class`/`interface`/`enum` keyword at
 * brace depth 0 (so an inner class can never be taken for the outer one),
 * with `extends` / `implements` clauses parsed by a depth-aware split so
 * generic arguments (`Database.Batchable<SObject>`) neither break the match
 * nor split the list. Type arguments are dropped from the emitted names.
 * `src` must have comments and strings stripped.
 */
function extractClassHeader(src: string): {
  name: string;
  extendsClass: string | null;
  /** Every `extends` entry; an interface may extend several interfaces. */
  extendsList: string[];
  implementsList: string[];
  isInterface: boolean;
  isTest: boolean;
  modifiers: string[];
} {
  const empty = {
    name: "",
    extendsClass: null,
    extendsList: [],
    implementsList: [],
    isInterface: false,
    isTest: false,
    modifiers: [],
  };
  // `enum` too: a top-level enum file declares its modifiers like a class does (cycle 3 T6 fix 1).
  const kwRe = /\b(class|interface|enum)\s+([A-Za-z_]\w*)/gi;
  let depth = 0;
  let scanned = 0;
  let hit: RegExpExecArray | null = null;
  for (let m = kwRe.exec(src); m !== null; m = kwRe.exec(src)) {
    for (; scanned < m.index; scanned++) {
      if (src[scanned] === "{") depth++;
      else if (src[scanned] === "}") depth--;
    }
    if (depth === 0) {
      hit = m;
      break;
    }
  }
  if (!hit) return empty;
  const open = src.indexOf("{", hit.index + hit[0].length);
  if (open < 0) return empty;

  const isInterface = (hit[1] ?? "").toLowerCase() === "interface";
  const name = hit[2] ?? "";
  // Everything before the keyword at depth 0 is annotations + modifiers. Only
  // the trailing statement matters (a preceding `}`/`;` cannot occur before
  // the outer type, but be defensive).
  const prefixStart = Math.max(src.lastIndexOf("}", hit.index), src.lastIndexOf(";", hit.index));
  const prefix = src.slice(prefixStart + 1, hit.index);
  const isTest = parseAnnotations(prefix).some((a) => a.name.toLowerCase() === "istest");
  const modifiers = stripAnnotations(prefix)
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);

  const tail = src.slice(hit.index + hit[0].length, open);
  const extIdx = tail.search(/\bextends\b/i);
  const implIdx = tail.search(/\bimplements\b/i);
  const clause = (from: number, kwLen: number): string => {
    if (from < 0) return "";
    const ends = [extIdx, implIdx].filter((x) => x > from);
    return tail.slice(from + kwLen, ends.length > 0 ? Math.min(...ends) : tail.length);
  };
  const extendsRaw = clause(extIdx, "extends".length);
  const implementsRaw = clause(implIdx, "implements".length);
  // An interface may extend several interfaces; a class extends one class.
  const extendsList = splitTopLevel(extendsRaw)
    .map(stripTypeArgs)
    .filter((x) => x);
  const implementsList = splitTopLevel(implementsRaw)
    .map(stripTypeArgs)
    .filter((x) => x.length > 0);
  return {
    name,
    extendsClass: extendsList[0] ?? null,
    extendsList,
    implementsList,
    isInterface,
    isTest,
    modifiers,
  };
}

/**
 * The bundled apex-parser grammar predates Apex's null-coalescing operator, so
 * `a ?? b` is a syntax error to it. For grammar validation only, rewrite every
 * code-level `??` (never inside comments or strings) to `||`: same length, so
 * token offsets stay valid, and the same binary-expression shape. The original
 * source is still used for every extraction and snippet.
 */
export function rewriteNullCoalescing(src: string): string {
  if (!src.includes("??")) return src;
  const masked = maskApex(src);
  const out = src.split("");
  for (let i = masked.indexOf("??"); i >= 0; i = masked.indexOf("??", i + 2)) {
    out[i] = "|";
    out[i + 1] = "|";
  }
  return out.join("");
}

/**
 * Human-readable message for a parse failure. apex-parser's
 * ThrowingErrorListener throws a plain `{ line, column, message }` object (not
 * an Error), which `String(err)` turned into "[object Object]".
 */
export function formatParseError(err: unknown): string {
  const MAX = 300;
  const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}…` : s);
  if (err instanceof Error) return clip(err.message);
  if (err && typeof err === "object") {
    const e = err as { line?: unknown; column?: unknown; message?: unknown };
    const msg = typeof e.message === "string" ? e.message : JSON.stringify(err);
    const pos =
      typeof e.line === "number" ? `${e.line}:${typeof e.column === "number" ? e.column : 0} ` : "";
    return clip(`${pos}${msg}`);
  }
  return clip(String(err));
}

/**
 * Raw (comment/string-preserving) body of the method's declaration: the first
 * not-yet-used `name(<same arity>) {` in `masked` that isn't a call (`.name(`)
 * or constructor invocation. Matching and brace-balancing run on `masked`; the
 * slice is taken from `src` at the same offsets. Null when not found.
 */
function declRawBody(
  src: string,
  masked: string,
  m: MethodInfo,
  used: Set<number>,
): { text: string; start: number } | null {
  const re = new RegExp(`(?<![.\\w])${m.name}\\s*\\(([^)]*)\\)\\s*\\{`, "g");
  for (const hit of masked.matchAll(re)) {
    const at = hit.index ?? 0;
    if (used.has(at)) continue;
    if (/\bnew\s+$/.test(masked.slice(Math.max(0, at - 5), at))) continue;
    if (parseParams(hit[1] ?? "").length !== m.params.length) continue;
    const open = at + hit[0].length - 1;
    const close = findMatchingBrace(masked, open);
    if (close <= 0) return null;
    used.add(at);
    return { text: src.slice(open + 1, close), start: open + 1 };
  }
  return null;
}

function findMethods(src: string, className?: string): MethodInfo[] {
  const out: MethodInfo[] = [];
  const re = new RegExp(METHOD_RE.source, "gi");
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    const returnType = (m[2] ?? "").trim();
    const name = m[3] ?? "";
    const params = parseParams(m[4] ?? "");
    // Reject non-methods that share the `<word> <word>(...) {` shape:
    //  - control flow: `else if (x) {` → returnType="else", name="if".
    //  - a CONSTRUCTOR: `public Foo(...) {` backtracks to returnType="public"
    //    (a modifier) / name=<class name>. A real method's return type is a
    //    type, never a modifier, and its name is never the class name.
    if (
      NON_METHOD_KEYWORDS.has(returnType.toLowerCase()) ||
      NON_METHOD_KEYWORDS.has(name.toLowerCase()) ||
      MODIFIER_KEYWORDS.has(returnType.toLowerCase()) ||
      (className !== undefined && name === className)
    ) {
      re.lastIndex = (m.index ?? 0) + 1;
      m = re.exec(src);
      continue;
    }
    // Skip constructors (returnType empty or equals class name when first letter is uppercase)
    // We'll keep ctor handling outside.
    const openBraceIdx = (m.index ?? 0) + m[0].length - 1;
    const closeIdx = findMatchingBrace(src, openBraceIdx);
    if (closeIdx < 0) {
      m = re.exec(src);
      continue;
    }
    const body = src.slice(openBraceIdx + 1, closeIdx);
    // Approximate modifiers by scanning the match string
    const head = m[0].slice(0, m[0].indexOf(name));
    const modifiers = head
      .replace(/@\w+(?:\([^)]*\))?/g, "")
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0 && !/^[A-Z]/.test(s));
    // Annotations live inside the regex match prefix.
    const nameIdx = m[0].indexOf(name);
    const beforeName = nameIdx > 0 ? m[0].slice(0, nameIdx) : "";
    const annotations = parseAnnotations(beforeName).map((a) => a.name);

    if (returnType && name) {
      out.push({
        name,
        params,
        returnType,
        modifiers,
        annotations,
        body,
        startIdx: m.index ?? 0,
        endIdx: closeIdx,
      });
    }
    re.lastIndex = closeIdx + 1;
    m = re.exec(src);
  }
  return out;
}

function extractApiVersion(metaXml?: string): string | null {
  if (!metaXml) return null;
  const m = metaXml.match(/<apiVersion>([^<]+)<\/apiVersion>/);
  return m?.[1] ? m[1].trim() : null;
}

/**
 * `<shadowsManaged>ns</shadowsManaged>` entries the live extractor adds to the
 * metaXml envelope when this local class shares its (namespace-less) qname
 * with managed-package classes. Not a Salesforce field.
 */
function extractShadowsManaged(metaXml?: string): string[] {
  if (!metaXml) return [];
  const out: string[] = [];
  for (const m of metaXml.matchAll(/<shadowsManaged>([^<]+)<\/shadowsManaged>/g)) {
    const ns = m[1]?.trim();
    if (ns) out.push(ns);
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Compute the character ranges of loop BODIES (`{ … }` opened by for/while/
 * do) within a method body. Used to stamp `inLoop: true` on SOQL/DML edges in
 * the regex extraction path so governor-risk detection works on the DEFAULT
 * parser mode — not only under SFGRAPH_APEX_PARSER=ast (the AST extractor
 * stamps inLoop separately). The body passed here has strings/comments
 * stripped, so brace counting is reliable.
 *
 * A for-EACH header query — `for (Account a : [SELECT …]) {…}` — runs once and
 * is correctly EXCLUDED: its index falls before the loop body's opening brace,
 * not inside the recorded range. Known limitation (shared with the populate
 * body-scan): a braceless single-statement loop body isn't tracked.
 */
export function computeLoopRanges(body: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const stack: Array<{ openIdx: number; isLoop: boolean }> = [];
  // Brace positions known to open a loop body. Marking the SPECIFIC `{` (rather
  // than a sticky `pendingLoop` flag) is what fixes braceless loops: a
  // `for (...) doIt();` or `do x(); while(y);` has no brace, so the next
  // UNRELATED `{` is no longer mis-marked as a loop body (the old flag bled into
  // it, producing false SOQL/DML-in-loop governor findings).
  const loopBraces = new Set<number>();
  const wordBefore = (i: number) => /\W/.test(body[i - 1] ?? " ");
  const boundaryAt = (i: number) => /\W/.test(body[i] ?? " ");
  const skipWs = (i: number) => {
    let j = i;
    while (j < body.length && /\s/.test(body[j] ?? "")) j += 1;
    return j;
  };
  // Index of the `)` matching the `(` at `open`, or -1.
  const matchParen = (open: number): number => {
    let d = 0;
    for (let j = open; j < body.length; j++) {
      if (body[j] === "(") d += 1;
      else if (body[j] === ")" && --d === 0) return j;
    }
    return -1;
  };
  // End (`;` at depth 0) of the single statement starting at `from`.
  const stmtEnd = (from: number): number => {
    let d = 0;
    for (let j = from; j < body.length; j++) {
      const c = body[j];
      if (c === "(" || c === "{" || c === "[") d += 1;
      else if (c === ")" || c === "}" || c === "]") d -= 1;
      else if (c === ";" && d === 0) return j;
    }
    return body.length - 1;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    let kwLen = 0;
    if (ch === "f" && body.startsWith("for", i) && wordBefore(i) && boundaryAt(i + 3)) kwLen = 3;
    else if (ch === "w" && body.startsWith("while", i) && wordBefore(i) && boundaryAt(i + 5))
      kwLen = 5;
    else if (ch === "d" && body.startsWith("do", i) && wordBefore(i) && boundaryAt(i + 2))
      kwLen = 2;
    if (kwLen > 0) {
      let j = skipWs(i + kwLen);
      // for/while carry a `(condition)` before the body; `do` does not. Skip the
      // condition so its inner `;`s (e.g. `for (i=0; i<n; i++)`) aren't read as a
      // braceless body terminator.
      if ((kwLen === 3 || kwLen === 5) && body[j] === "(") {
        const close = matchParen(j);
        if (close < 0) continue;
        j = skipWs(close + 1);
      }
      if (body[j] === "{") {
        loopBraces.add(j); // braced body — recorded when the stack pops it
      } else {
        ranges.push({ start: j - 1, end: stmtEnd(j) }); // braceless single statement
      }
      i = j - 1;
      continue;
    }
    if (ch === "{") {
      stack.push({ openIdx: i, isLoop: loopBraces.has(i) });
    } else if (ch === "}") {
      const top = stack.pop();
      if (top?.isLoop) ranges.push({ start: top.openIdx, end: i });
    }
  }
  return ranges;
}

// Inline SOQL queries are found by soql-fields findInlineQueries: from
// `[SELECT` to the `]` that closes it at bracket depth 0, outside string
// literals (a bind such as `:ids[0]` does not end the query). The object is
// taken by parseSoql, which finds the FROM at paren-depth 0 so a child subquery
// (`(SELECT … FROM Contacts)`) or a semi-join (`WHERE Id IN (SELECT … FROM
// Contact)`) doesn't get mistaken for the outer object.
export const SOSL_RE = /\[\s*FIND\b/gi;

/** Dynamic query entry points (the query text is a runtime string). */
export const DYNAMIC_QUERY_RE =
  /\b(Database|Search)\s*\.\s*(query|queryWithBinds|countQuery|countQueryWithBinds|getQueryLocator|getQueryLocatorWithBinds)\s*\(/gi;

/**
 * T15 I-5: one EXECUTES_SOSL `SOSL:*` edge when `code` has an inline SOSL
 * query, stamped `inLoop` when any of them sits inside a loop body.
 */
export function emitSoslEdge(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  inLoopAt: (idx: number) => boolean,
  edges: EdgeFact[],
): void {
  let found = false;
  let inLoop = false;
  for (const m of code.matchAll(new RegExp(SOSL_RE.source, "gi"))) {
    found = true;
    if (inLoopAt(m.index ?? 0)) inLoop = true;
  }
  if (found) {
    edges.push(
      makeEdge(ctx, srcQname, REL_TYPES.EXECUTES_SOSL, "SOSL:*", inLoop ? { inLoop: true } : {}),
    );
  }
}

/**
 * T15 I-5: the dynamic query calls (`Database.query`, `Search.query`, ...)
 * inside a loop body of `code` (strings/comments stripped), as sorted
 * distinct canonical names. Stamped on the method / trigger node as
 * `dynamicQueryInLoop`; empty when none.
 */
export function dynamicQueriesInLoop(code: string, inLoopAt: (idx: number) => boolean): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(new RegExp(DYNAMIC_QUERY_RE.source, "gi"))) {
    if (!inLoopAt(m.index ?? 0)) continue;
    const cls = (m[1] ?? "").toLowerCase() === "search" ? "Search" : "Database";
    const op = (m[2] ?? "").toLowerCase();
    const canon =
      [
        "query",
        "queryWithBinds",
        "countQuery",
        "countQueryWithBinds",
        "getQueryLocator",
        "getQueryLocatorWithBinds",
      ].find((k) => k.toLowerCase() === op) ?? op;
    out.add(`${cls}.${canon}`);
  }
  return [...out].sort();
}

/**
 * Extract the outer object + SELECT clause from a SOQL query's inner text (the
 * part after `[SELECT`). The object is the identifier after the first `FROM`
 * encountered at parenthesis depth 0; subquery/semi-join FROMs (depth > 0) are
 * skipped. Returns object=null for a malformed query.
 */
export function parseSoql(inner: string): { object: string | null; selectClause: string } {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth > 0) depth -= 1;
    } else if (
      depth === 0 &&
      (c === "f" || c === "F") &&
      /^from\b/i.test(inner.slice(i)) &&
      /\W/.test(inner[i - 1] ?? " ")
    ) {
      const m = inner.slice(i + 4).match(/^\s+([A-Za-z_][\w.]*)/);
      if (m?.[1]) return { object: m[1], selectClause: inner.slice(0, i) };
    }
  }
  return { object: null, selectClause: inner };
}
export const DML_RE = /\b(insert|update|delete|upsert|undelete|merge)\s+([A-Za-z_][\w.]*)/gi;
/** `Database.insert(recs)`, `Database.update(recs, false)`, `Database.INSERT(…)`:
 *  the Database class DML methods (Apex is case-insensitive). Group 2 is the
 *  first argument when it is a plain name. */
export const DATABASE_DML_RE =
  /\bDatabase\s*\.\s*(insert|update|upsert|delete|undelete|merge)\s*\(\s*([A-Za-z_][\w.]*)?/gi;

/**
 * EXECUTES_DML `DML:<op>` for DML statements (`insert x;`) and Database DML
 * calls (`Database.insert(x)`) in `code` (strings/comments stripped), stamped
 * `inLoop` when inside a loop body. `target` is the record expression's name
 * when there is one.
 */
export function emitDmlEdges(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  inLoopAt: (idx: number) => boolean,
  edges: EdgeFact[],
): void {
  const found: Array<{ i: number; op: string; target: string | undefined }> = [];
  for (const m of code.matchAll(new RegExp(DML_RE.source, "gi")))
    found.push({ i: m.index ?? 0, op: (m[1] ?? "").toLowerCase(), target: m[2] });
  for (const m of code.matchAll(new RegExp(DATABASE_DML_RE.source, "gi"))) {
    const t = m[2] && m[2].toLowerCase() !== "new" ? m[2] : undefined;
    found.push({ i: m.index ?? 0, op: (m[1] ?? "").toLowerCase(), target: t });
  }
  found.sort((a, b) => a.i - b.i);
  for (const f of found) {
    edges.push(
      makeEdge(ctx, srcQname, REL_TYPES.EXECUTES_DML, `DML:${f.op}`, {
        ...(f.target !== undefined ? { target: f.target } : {}),
        ...(inLoopAt(f.i) ? { inLoop: true } : {}),
      }),
    );
  }
}

/** A relationship traversal the parser records for the post-merge resolver
 *  (parsers/apex/ref-resolver.ts): `path` (`Account.Name`) read or written
 *  from a record of `object`. */
export interface ApexRelationshipPath {
  object: string;
  path: string;
  rel: typeof REL_TYPES.READS_FIELD | typeof REL_TYPES.WRITES_FIELD;
}

/**
 * Inline `[SELECT …]` queries in `code`: EXECUTES_SOQL on the outer FROM
 * object (with `query`, `inLoop`) and READS_FIELD for every plain field the
 * outer query names (SELECT list, WHERE / HAVING operands, GROUP BY, ORDER
 * BY). Dotted relationship fields are not this object's fields: they are
 * appended to `paths`.
 */
export function emitInlineSoqlEdges(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  inLoopAt: (idx: number) => boolean,
  edges: EdgeFact[],
  paths: ApexRelationshipPath[],
  children?: ApexChildRelationship[],
): void {
  for (const sq of findInlineQueries(code)) {
    // Bind expressions (`:ids[0]`, an inline query held in a bind) are Apex,
    // not this query's SOQL: blank their bracket groups for the grammar pass.
    const inner = blankBracketGroups(sq.inner);
    const { object } = parseSoql(inner);
    const obj = stripNs(object ?? "", ctx.namespace);
    edges.push(
      makeEdge(ctx, srcQname, REL_TYPES.EXECUTES_SOQL, `CustomObject:${obj}`, {
        query: sq.text.trim(),
        ...(inLoopAt(sq.index) ? { inLoop: true } : {}),
      }),
    );
    if (!obj) continue;
    const refs = soqlFieldRefs(inner);
    for (const f of refs.fields)
      edges.push(makeEdge(ctx, srcQname, REL_TYPES.READS_FIELD, `CustomField:${obj}.${f}`));
    for (const p of refs.paths) paths.push({ object: obj, path: p, rel: REL_TYPES.READS_FIELD });
    if (children) addChildRelationships(children, obj, parseSoql(inner).selectClause);
  }
}

/**
 * A string literal that is exactly a custom field API name (`'Tier__c'`), with
 * the sObject types the same method declares (parameters and locals). Resolved
 * post-merge (parsers/apex/ref-resolver.ts): READS_FIELD `{via:
 * "field-name-literal"}` when exactly one of those objects defines the field.
 * Covers helpers such as `setFieldIfNull(acc, 'Tier__c', v)` and `rec.get('Tier__c')`.
 */
export interface ApexFieldNameLiteral {
  field: string;
  objects: string[];
}

/** Literal custom-field names: `'Name__c'` (optional namespace), nothing else in the quotes. */
const FIELD_LITERAL_RE = /'((?:[A-Za-z][A-Za-z0-9]*__)?[A-Za-z][A-Za-z0-9_]*__c)'/g;
/** Declared types that are never an sObject. */
const NOT_SOBJECT = new Set(["sobject", "string", "object", "id", "map", "list", "set"]);

/** Records `apexFieldNameLiterals` on a method node (see ApexFieldNameLiteral). */
function setFieldNameLiterals(
  node: NodeFact,
  rawDecl: string,
  decls: ReadonlyArray<{ type: string | null; elem: string | null }>,
): void {
  const objects = new Set<string>();
  for (const d of decls) {
    for (const t of [d.type, d.elem]) {
      if (!t || t.includes(".") || NOT_SOBJECT.has(t.toLowerCase())) continue;
      if (/^[A-Za-z]\w*$/.test(t)) objects.add(t);
    }
  }
  if (objects.size === 0) return;
  const fields = new Set<string>();
  for (const m of stripCommentsOnly(rawDecl).matchAll(FIELD_LITERAL_RE)) {
    if (m[1]) fields.add(m[1]);
  }
  if (fields.size === 0) return;
  const objs = [...objects].sort().slice(0, 20);
  (node.attributes as Record<string, unknown>).apexFieldNameLiterals = [...fields]
    .sort()
    .slice(0, 200)
    .map((field) => ({ field, objects: objs }));
}

/** A child-relationship subquery (`(SELECT … FROM Contacts)` in the SELECT
 *  list of a query on `object`), resolved to the child object post-merge
 *  (parsers/apex/ref-resolver.ts). `fields` are the subquery's plain fields. */
export interface ApexChildRelationship {
  object: string;
  relationship: string;
  fields: string[];
}

/** Append the depth-1 `(SELECT …)` groups of `selectClause`, deduped on
 *  (object, relationship) with their fields merged. One linear pass. */
function addChildRelationships(
  into: ApexChildRelationship[],
  object: string,
  selectClause: string,
): void {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < selectClause.length; i++) {
    const c = selectClause[i];
    if (c === "(") {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (c === ")" && depth > 0) {
      depth -= 1;
      if (depth !== 0) continue;
      const sub = /^\s*select\b/i.exec(selectClause.slice(start, i));
      if (!sub) continue;
      const refs = soqlFieldRefs(selectClause.slice(start + sub[0].length, i));
      if (!refs.object || refs.object.includes(".")) continue;
      const hit = into.find(
        (r) =>
          r.object.toLowerCase() === object.toLowerCase() &&
          r.relationship.toLowerCase() === refs.object?.toLowerCase(),
      );
      const rec = hit ?? { object, relationship: refs.object, fields: [] };
      if (!hit) into.push(rec);
      for (const f of refs.fields)
        if (!rec.fields.some((x) => x.toLowerCase() === f.toLowerCase())) rec.fields.push(f);
    }
  }
}

/** Store child-relationship subqueries on a node (only when there are any). */
function setChildRelationships(node: NodeFact | undefined, rels: ApexChildRelationship[]): void {
  if (!node || rels.length === 0) return;
  (node.attributes as Record<string, unknown>).apexChildRelationships = rels;
}

/** Append `add` to `into`, deduped on (object, path, rel) case-insensitively. */
function mergePaths(into: ApexRelationshipPath[], add: ApexRelationshipPath[]): void {
  const seen = new Set(into.map((p) => `${p.object}|${p.path}|${p.rel}`.toLowerCase()));
  for (const p of add) {
    const k = `${p.object}|${p.path}|${p.rel}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    into.push(p);
  }
}
const FIELD_ACCESS_RE = /\b([A-Z][A-Za-z0-9_]*(?:__r)?)\.([A-Za-z_][\w]*?)(?:__c)?\b/g;

const NAMED_CRED_RE = /['"]callout:([A-Za-z_][\w]*)/g;

/**
 * Push READS_FIELD / WRITES_FIELD edges for member-access field refs, skipping
 * any (rel, dst) already emitted for this source since `fromIdx` (e.g. a
 * READS_FIELD from a SOQL select list) so existing edge attributes are kept.
 */
export function emitFieldAccessEdges(
  ctx: ParseContext,
  srcQname: string,
  accesses: FieldAccess[],
  edges: EdgeFact[],
  fromIdx: number,
): void {
  const seen = new Set<string>();
  for (let i = fromIdx; i < edges.length; i++) {
    const e = edges[i];
    if (e && String(e.srcQualifiedName) === srcQname)
      seen.add(`${e.relType}|${String(e.dstQualifiedName).toLowerCase()}`);
  }
  const push = (rel: typeof REL_TYPES.READS_FIELD | typeof REL_TYPES.WRITES_FIELD, dst: string) => {
    const key = `${rel}|${dst.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(makeEdge(ctx, srcQname, rel, dst, { via: "member-access" }));
  };
  for (const a of accesses) {
    const dst = `CustomField:${stripNs(a.object, ctx.namespace)}.${a.field}`;
    if (a.read) push(REL_TYPES.READS_FIELD, dst);
    if (a.write) push(REL_TYPES.WRITES_FIELD, dst);
  }
}

/**
 * READS_FIELD `dynamic: true` for the outer SELECT fields and the WHERE /
 * HAVING / GROUP BY / ORDER BY field operands of each folded dynamic SOQL
 * string in `queries` (see foldDynamicSoql, dynamicSoqlClauseFields). Only
 * when the FROM object is literal text; computed fields are skipped. A
 * (src, dst) READS_FIELD already emitted since `fromIdx` is not repeated.
 * Returns the number of clause field operands skipped because FROM is
 * computed (see setDynamicSoqlSkips).
 */
export function emitDynamicSoqlEdges(
  ctx: ParseContext,
  srcQname: string,
  queries: string[],
  edges: EdgeFact[],
  fromIdx: number,
): number {
  const seen = new Set<string>();
  // Objects this source already queries (static SOQL): an added dynamic edge
  // would replace that edge (the store merges last-wins) and could drop its
  // `inLoop`, so those keep the static edge alone.
  const queried = new Set<string>();
  for (let i = fromIdx; i < edges.length; i++) {
    const e = edges[i];
    if (!e || String(e.srcQualifiedName) !== srcQname) continue;
    if (e.relType === REL_TYPES.READS_FIELD) seen.add(String(e.dstQualifiedName).toLowerCase());
    else if (e.relType === REL_TYPES.EXECUTES_SOQL)
      queried.add(String(e.dstQualifiedName).toLowerCase());
  }
  let skipped = 0;
  for (const q of queries) {
    const parsed = parseDynamicSoql(q);
    const clause = dynamicSoqlClauseFields(q, parsed);
    skipped += clause.skipped;
    if (!parsed) continue;
    const obj = stripNs(parsed.object, ctx.namespace);
    // The object the query reads, like a static `[SELECT …]`. No `inLoop`:
    // loop detection for dynamic queries is `dynamicQueryInLoop` on the node.
    const objDst = `CustomObject:${obj}`;
    if (!queried.has(objDst.toLowerCase())) {
      queried.add(objDst.toLowerCase());
      edges.push(
        makeEdge(ctx, srcQname, REL_TYPES.EXECUTES_SOQL, objDst, {
          query: q.split(PLACEHOLDER).join("…").trim().slice(0, 500),
          dynamic: true,
        }),
      );
    }
    for (const fname of [...parsed.fields, ...clause.fields]) {
      const dst = `CustomField:${obj}.${fname}`;
      if (seen.has(dst.toLowerCase())) continue;
      seen.add(dst.toLowerCase());
      edges.push(makeEdge(ctx, srcQname, REL_TYPES.READS_FIELD, dst, { dynamic: true }));
    }
  }
  return skipped;
}

/**
 * Parse stat on a source node: `dynamicSoqlFieldsSkipped`, the dynamic SOQL
 * clause field operands not attributed because the query's FROM is computed
 * (only when there are any). The apex ref resolver sums it.
 */
export function setDynamicSoqlSkips(node: NodeFact | undefined, skipped: number): void {
  if (!node || skipped <= 0) return;
  const attrs = node.attributes as Record<string, unknown>;
  attrs.dynamicSoqlFieldsSkipped = ((attrs.dynamicSoqlFieldsSkipped as number) ?? 0) + skipped;
}

/**
 * Collapse repeated EXECUTES_SOQL / EXECUTES_DML facts with the same
 * (src, rel, dst) into one, in place of first occurrence. The store merges
 * edges last-wins on that key, so without this an out-of-loop query after an
 * in-loop one on the same object erased `inLoop`. The kept fact carries
 * `inLoop: true` if any occurrence did (taking that occurrence's attributes),
 * and `count` = number of occurrences when more than one.
 */
export function aggregateGovernorFacts(edges: EdgeFact[]): EdgeFact[] {
  const out: EdgeFact[] = [];
  const byKey = new Map<string, { edge: EdgeFact; count: number }>();
  for (const e of edges) {
    if (e.relType !== REL_TYPES.EXECUTES_SOQL && e.relType !== REL_TYPES.EXECUTES_DML) {
      out.push(e);
      continue;
    }
    const key = `${e.relType}|${String(e.srcQualifiedName)}|${String(e.dstQualifiedName).toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      const copy = { ...e, attributes: { ...e.attributes } };
      byKey.set(key, { edge: copy, count: 1 });
      out.push(copy);
      continue;
    }
    prev.count += 1;
    const attrs = e.attributes as Record<string, unknown>;
    if (attrs.inLoop === true && (prev.edge.attributes as Record<string, unknown>).inLoop !== true)
      prev.edge.attributes = { ...attrs };
    (prev.edge.attributes as Record<string, unknown>).count = prev.count;
  }
  return out;
}

const LOWER_NEW_RE = /\bnew\s+([a-z][A-Za-z0-9_]*)\s*\(/g;
const LOWER_STATIC_CALL_RE = /(?<![\w.])([a-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
const NOT_A_CLASS = new Set(["this", "super"]);

function parseClassNameAndIsTest(body: string): {
  isTest: boolean;
  testTargets: Set<string>;
  lowerTargets: string[];
} {
  const testTargets = new Set<string>();
  const lowerTargets: string[] = [];
  const m = body.match(/@isTest\s*\(\s*seeAllData\s*=\s*[^)]*\)|@isTest/i);
  if (!m) return { isTest: false, testTargets, lowerTargets };
  for (const re of [LOWER_NEW_RE, LOWER_STATIC_CALL_RE]) {
    for (const x of body.matchAll(new RegExp(re.source, "g"))) {
      const t = x[1] ?? "";
      if (t && !NOT_A_CLASS.has(t)) lowerTargets.push(t);
    }
  }
  // crude: find class names referenced via `new X(` or `X.foo(`
  const re1 = new RegExp(NEW_INSTANCE_RE.source, "g");
  let mm: RegExpExecArray | null = re1.exec(body);
  while (mm !== null) {
    if (mm[1]) testTargets.add(mm[1]);
    mm = re1.exec(body);
  }
  const re2 = new RegExp(STATIC_CALL_RE.source, "g");
  mm = re2.exec(body);
  while (mm !== null) {
    if (mm[1]) testTargets.add(mm[1]);
    mm = re2.exec(body);
  }
  return { isTest: true, testTargets, lowerTargets };
}

export class ApexClassParser implements Parser<ApexClassInput> {
  readonly category = METADATA_CATEGORY.APEX_CLASS;
  readonly type = "ApexClass";

  async parse(input: ApexClassInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const snippets: SnippetRecord[] = [];
    const className = stripNs(input.className, ctx.namespace);
    const shadowsManaged = extractShadowsManaged(input.metaXml);
    const shadowAttr = shadowsManaged.length > 0 ? { shadowsManaged } : {};
    // Fold the collision into the hash (only when present, so every other
    // node keeps its hash): node merge skips attributes when the hash is
    // unchanged, and the stored local node must pick up the attr.
    const fileHash = sha256(
      `${APEX_NODE_HASH_SALT}\n${input.body}${
        shadowsManaged.length > 0 ? `\nshadowsManaged:${shadowsManaged.join(",")}` : ""
      }`,
    );

    // Managed-package Apex (and any member whose Body the extractor couldn't
    // fetch) arrives with an empty body. That is NOT a parse failure — the
    // class exists, we just can't see its source. Emit a bare node so
    // referencing edges resolve to a real target, instead of a misleading
    // ParseError (the apex-parser throws a non-Error on empty input, which the
    // catch below would record as the useless message "[object Object]").
    if (input.body.trim() === "") {
      nodes.push(
        makeNode(
          ctx,
          "ApexClass",
          `ApexClass:${className}`,
          {
            name: className,
            modifiers: [],
            isTest: false,
            apiVersion: extractApiVersion(input.metaXml),
            bodyUnavailable: true,
            ...shadowAttr,
          },
          fileHash,
        ),
      );
      return { nodes, edges, snippets };
    }

    // Read parser mode once per parse — env var lets us flip between
    // regex (the legacy path), ast (the new precise extractor), and both
    // (regex authoritative; ast diff logged for shadow validation).
    const parserMode = ((): "regex" | "ast" | "both" => {
      const v = (process.env.SFGRAPH_APEX_PARSER ?? "regex").toLowerCase();
      if (v === "ast" || v === "both") return v;
      return "regex";
    })();

    // Validate parse via apex-parser. On failure: emit ParseError only.
    // When parserMode != "regex", retain the parsed compilationUnit tree
    // so the AST extractor can walk it without parsing twice.
    let parsedTree: unknown = null;
    let lexer: any = null;
    let parser: any = null;
    try {
      // Lazy-load to avoid pulling apex-parser into other parsers' worker.
      const apex = await import("apex-parser");
      const {
        ApexLexer,
        ApexParser,
        CommonTokenStream,
        CaseInsensitiveInputStream,
        ThrowingErrorListener,
      } = apex as any;
      const input1 = new CaseInsensitiveInputStream("file", rewriteNullCoalescing(input.body));
      lexer = new ApexLexer(input1);
      lexer.removeErrorListeners();
      lexer.addErrorListener(new ThrowingErrorListener());
      const tokens = new CommonTokenStream(lexer);
      parser = new ApexParser(tokens);
      parser.removeErrorListeners();
      parser.addErrorListener(new ThrowingErrorListener());
      parsedTree = parser.compilationUnit();
    } catch (err) {
      const errMsg = formatParseError(err);
      nodes.push(
        makeNode(
          ctx,
          "ParseError",
          `ParseError:ApexClass:${className}`,
          { className, message: errMsg },
          sha256(`${className}:${errMsg}`),
        ),
      );
      // Keep a stub for the type itself so grants, references and calls to it
      // still resolve; `parseFailed` marks it as having no extracted body.
      const stubSrc = stripCommentsAndStrings(input.body);
      const stubHeader = extractClassHeader(stubSrc);
      const stubLabel = stubHeader.isInterface ? "ApexInterface" : "ApexClass";
      // Cheap fallback when the broken body defeats the header scan: an
      // `@isTest` annotation before the first class keyword.
      const stubIsTest = stubHeader.isTest || /@istest\b[^{;]*?\bclass\b/i.test(stubSrc);
      nodes.push(
        makeNode(
          ctx,
          stubLabel,
          `${stubLabel}:${className}`,
          {
            name: className,
            modifiers: [],
            isTest: stubIsTest,
            apiVersion: extractApiVersion(input.metaXml),
            parseFailed: true,
            ...shadowAttr,
          },
          fileHash,
        ),
      );
      return { nodes, edges };
    } finally {
      // The tree (if kept) does not depend on the DFA cache.
      if (parser) noteApexSyntaxCheck(lexer, parser);
    }

    const cleaned = stripCommentsAndStrings(input.body);
    const header = extractClassHeader(cleaned);
    const effectiveName = header.name || className;
    const classQname = header.isInterface
      ? `ApexInterface:${effectiveName}`
      : `ApexClass:${effectiveName}`;
    const apiVersion = extractApiVersion(input.metaXml);

    const dispatch = extractVlocityDispatch(input.body, header.implementsList);
    // `final` String fields: an IP / DataRaptor name passed as a constant.
    const stringConstants = classStringConstants(input.body);
    nodes.push(
      makeNode(
        ctx,
        header.isInterface ? "ApexInterface" : "ApexClass",
        classQname,
        {
          name: effectiveName,
          modifiers: header.modifiers,
          isTest: header.isTest,
          apiVersion,
          ...(dispatch ? { vlocityDispatch: dispatch } : {}),
          ...shadowAttr,
        },
        fileHash,
      ),
    );

    if (header.isInterface) {
      // An interface extends interfaces, possibly several.
      for (const parent of header.extendsList) {
        edges.push(
          makeEdge(
            ctx,
            classQname,
            REL_TYPES.EXTENDS,
            `ApexInterface:${stripNs(parent, ctx.namespace)}`,
          ),
        );
      }
    } else if (header.extendsClass) {
      edges.push(
        makeEdge(
          ctx,
          classQname,
          REL_TYPES.EXTENDS,
          `ApexClass:${stripNs(header.extendsClass, ctx.namespace)}`,
        ),
      );
    }
    for (const impl of header.implementsList) {
      edges.push(
        makeEdge(
          ctx,
          classQname,
          REL_TYPES.IMPLEMENTS,
          `ApexInterface:${stripNs(impl, ctx.namespace)}`,
        ),
      );
    }

    // Methods
    const usedDecls = new Set<number>();
    const maskedBody = maskApex(input.body);
    const methods = findMethods(cleaned, effectiveName);
    // Member-access field refs: each method falls back to the fields/properties
    // declared directly in ITS enclosing class body (constructor/initializer
    // locals and other inner classes' fields are excluded); types declared in
    // this file (inner classes, enums, interfaces) are never SObjects.
    const scopes = classScopes(cleaned);
    const localTypes = new Set(
      [...cleaned.matchAll(/\b(?:class|enum|interface)\s+([A-Za-z_]\w*)/gi)].map((x) =>
        (x[1] ?? "").toLowerCase(),
      ),
    );
    // Fields of the method's class and of every enclosing class: an inner
    // class can use its outer class's (static) fields.
    const enclosingFields = (pos: number) => {
      const out: ReturnType<typeof scopes.fields> = [];
      const seen = new Set<number>();
      for (let c = scopes.classAt(pos); c >= 0 && !seen.has(c); c = scopes.classAt(c)) {
        seen.add(c);
        out.push(...scopes.fields(c));
      }
      return out;
    };
    const refScope: ClassRefScope = {
      selfName: effectiveName,
      localTypes,
      // File-wide set: used for code outside method bodies and for test-class
      // linkage. Each method gets its own set below (its params, its body's
      // declarations and its enclosing class's fields).
      localVars: localVarNames([
        ...collectDecls(cleaned),
        ...methods.flatMap((m) => paramDecls(m.params)),
      ]),
    };
    const methodQueries: string[] = [];
    const methodNodes = new Map<string, NodeFact>();
    const classPaths: ApexRelationshipPath[] = [];
    const classChildren: ApexChildRelationship[] = [];
    const declRanges: Array<{ text: string; start: number }> = [];
    for (const m of methods) {
      const methodEdgeStart = edges.length;
      const methodQname = `ApexMethod:${effectiveName}.${m.name}(${m.params.length})`;
      const annotationsLower = m.annotations.map((a) => a.toLowerCase());
      const auraEnabled = annotationsLower.includes("auraenabled");
      const isInvocable = annotationsLower.includes("invocablemethod");
      const isRemote = annotationsLower.includes("remoteaction");
      const isFuture = annotationsLower.includes("future");
      const isTestMethod =
        annotationsLower.includes("istest") || annotationsLower.includes("testsetup");
      const httpVerbs = ["httpget", "httppost", "httpput", "httppatch", "httpdelete"].filter((v) =>
        annotationsLower.includes(v),
      );

      const isTestLabel = isTestMethod || (header.isTest && m.modifiers.includes("static"));

      const methodNode = makeNode(
        ctx,
        isTestLabel ? "TestMethod" : "ApexMethod",
        methodQname,
        {
          name: m.name,
          arity: m.params.length,
          returnType: m.returnType,
          modifiers: m.modifiers,
          annotations: m.annotations,
          auraEnabled,
          isInvocable,
          isRemote,
          isFuture,
          httpVerbs,
          // Mirror the test-status onto the attributes so rules and queries
          // can filter on attributes.isTest uniformly across labels.
          // (The label is already TestMethod vs ApexMethod, but
          // label-based filtering requires consumers to know both.)
          // Source: @isTest / @TestSetup annotation on the method itself,
          // or @isTest on the enclosing class with the method static.
          // Never derived from filename.
          isTest: isTestLabel,
        },
        sha256(`${APEX_NODE_HASH_SALT}\n${m.body}`),
      );
      nodes.push(methodNode);
      methodNodes.set(methodQname, methodNode);
      edges.push(makeEdge(ctx, classQname, REL_TYPES.CONTAINS_METHOD, methodQname));

      // Snippet: emit the raw method body from the ORIGINAL source (preserves
      // comments + strings) keyed on the method's qname.
      const rawBody = (() => {
        const idx = input.body.indexOf(m.name);
        if (idx < 0) return m.body;
        const open = input.body.indexOf("{", idx);
        if (open < 0) return m.body;
        const close = findMatchingBrace(input.body, open);
        return close > 0 ? input.body.slice(open + 1, close) : m.body;
      })();
      const startLine = (() => {
        const idx = input.body.indexOf(m.name);
        if (idx < 0) return undefined;
        return input.body.slice(0, idx).split("\n").length;
      })();
      const endLine = startLine != null ? startLine + rawBody.split("\n").length - 1 : undefined;
      const snippetRec: SnippetRecord = {
        orgId: asOrgId(ctx.orgId),
        qualifiedName: asQualifiedName(methodQname),
        sourceFormat: "apex",
        sourceText: rawBody,
        sourceHash: asSha256(sha256(rawBody)),
      };
      if (startLine != null) snippetRec.startLine = startLine;
      if (endLine != null) snippetRec.endLine = endLine;
      snippets.push(snippetRec);

      // Apex -> Vlocity calls (IP / DataRaptor), extracted from the raw body.
      // `rawBody` above locates the method by first textual occurrence of its
      // name (which can be a call site), so locate the declaration properly here.
      const decl = declRawBody(input.body, maskedBody, m, usedDecls);
      if (decl) declRanges.push(decl);
      const rawDecl = decl?.text ?? null;
      const vc = extractVlocityCalls(rawDecl ?? "", stringConstants, m.params);
      for (const k of vc.ipKeys)
        edges.push(
          makeEdge(ctx, methodQname, REL_TYPES.APEX_CALLS_IP, `IntegrationProcedure:${k}`),
        );
      for (const d of vc.drNames)
        edges.push(makeEdge(ctx, methodQname, REL_TYPES.APEX_CALLS_DR, `DataRaptor:${d}`));
      if (rawDecl !== null) {
        setFieldNameLiterals(methodNode, rawDecl, [
          ...paramDecls(m.params),
          ...collectDecls(m.body),
        ]);
      }

      // Body analysis (regex path — gated when parserMode === "ast").
      const body = m.body;
      const methodPaths: ApexRelationshipPath[] = [];
      const accessPaths: ApexRelationshipPath[] = [];
      const fieldAccesses = extractFieldAccesses(body, {
        decls: [...paramDecls(m.params), ...collectDecls(body)],
        outer: scopes.fields(scopes.classAt(m.startIdx)),
        excludedTypes: localTypes,
        paths: accessPaths,
      });
      if (parserMode === "ast") {
        setRelationshipPaths(methodNode, accessPaths);
        emitFieldAccessEdges(ctx, methodQname, fieldAccesses, edges, methodEdgeStart);
        // AST mode handles per-method edges in a single tree walk after this loop;
        // skip the regex extraction here to avoid duplicate / inconsistent edges.
        continue;
      }

      // Loop-body ranges for governor in-loop detection (regex path). The AST
      // extractor stamps inLoop itself; this gives the DEFAULT (regex) path the
      // same signal so governor_risk_check works without SFGRAPH_APEX_PARSER=ast.
      const loopRanges = computeLoopRanges(body);
      const inLoopAt = (idx: number): boolean =>
        loopRanges.some((r) => idx > r.start && idx < r.end);

      // SOQL: EXECUTES_SOQL + READS_FIELD for the outer query's fields.
      const methodChildren: ApexChildRelationship[] = [];
      emitInlineSoqlEdges(ctx, methodQname, body, inLoopAt, edges, methodPaths, methodChildren);
      setChildRelationships(methodNode, methodChildren);
      mergePaths(methodPaths, accessPaths);
      setRelationshipPaths(methodNode, methodPaths);

      emitFieldAccessEdges(ctx, methodQname, fieldAccesses, edges, methodEdgeStart);

      // SOSL (inLoop when any SOSL sits in a loop body) and dynamic queries
      // in a loop body (governor risks, T15 I-5).
      emitSoslEdge(ctx, methodQname, body, inLoopAt, edges);
      const dynInLoop = dynamicQueriesInLoop(body, inLoopAt);
      if (dynInLoop.length > 0) {
        (methodNode.attributes as Record<string, unknown>).dynamicQueryInLoop = dynInLoop;
      }

      // DML (statements and Database.<op>(…) calls)
      emitDmlEdges(ctx, methodQname, body, inLoopAt, edges);

      // Named credentials (scan the ORIGINAL method body — strings are stripped from `body`).
      const ncSource = (() => {
        const idx = input.body.indexOf(m.name);
        if (idx < 0) return body;
        const open = input.body.indexOf("{", idx);
        if (open < 0) return body;
        const close = findMatchingBrace(input.body, open);
        return close > 0 ? input.body.slice(open + 1, close) : body;
      })();
      const ncRe = new RegExp(NAMED_CRED_RE.source, "g");
      let nc: RegExpExecArray | null = ncRe.exec(ncSource);
      while (nc !== null) {
        edges.push(
          makeEdge(
            ctx,
            methodQname,
            REL_TYPES.CALLS_NAMED_CREDENTIAL,
            `NamedCredential:${stripNs(nc[1] ?? "", ctx.namespace)}`,
          ),
        );
        // Continue over the SAME source we started on (ncSource). Re-executing a
        // stateful /g regex against a different string (`body`) reset its
        // lastIndex semantics and dropped every named credential after the first.
        nc = ncRe.exec(ncSource);
      }

      // Calls to other static methods (best-effort), constructors and
      // static-member references.
      // Scanned on the length-preserving mask (quotes kept, contents blanked)
      // so a string argument still counts toward the call's arity.
      const callCode = rawDecl === null ? body : maskApex(rawDecl);
      const methodScope: ClassRefScope = {
        ...refScope,
        localVars: localVarNames([
          ...paramDecls(m.params),
          ...collectDecls(body),
          ...enclosingFields(m.startIdx),
        ]),
      };
      emitStaticCallEdges(ctx, methodQname, callCode, effectiveName, edges, methodScope.localVars);
      emitClassRefEdges(ctx, methodQname, callCode, methodScope, edges);
      // The signature is outside `callCode`: prepend it so parameter and
      // return types count for the method too.
      const sig = `${m.returnType} ${m.name}(${m.params.join(", ")});\n`;
      emitTypeRefEdges(ctx, methodQname, sig + callCode, methodScope, edges, methodEdgeStart);
      emitDescribeRefEdges(ctx, methodQname, callCode, edges);
      const queries = rawDecl === null ? [] : foldDynamicSoql(rawDecl);
      methodQueries.push(...queries);
      setDynamicSoqlSkips(
        methodNode,
        emitDynamicSoqlEdges(ctx, methodQname, queries, edges, methodEdgeStart),
      );
    }

    // Code outside method bodies (field initializers, constructors, static
    // blocks, method signatures) is attributed to the class itself.
    if (parserMode !== "ast") {
      const outside = maskedBody.split("");
      for (const d of declRanges) {
        for (let k = d.start; k < d.start + d.text.length; k++) {
          if (outside[k] !== "\n") outside[k] = " ";
        }
      }
      const rest = outside.join("");
      emitStaticCallEdges(ctx, classQname, rest, effectiveName, edges, refScope.localVars);
      emitClassRefEdges(ctx, classQname, rest, refScope, edges);
      emitTypeRefEdges(ctx, classQname, rest, refScope, edges);
      emitDescribeRefEdges(ctx, classQname, rest, edges);
      // Dynamic SOQL outside method bodies (constants, constructors): every
      // folded query in the file minus those already attributed to a method.
      const left = new Map<string, number>();
      for (const q of methodQueries) left.set(q, (left.get(q) ?? 0) + 1);
      const classQueries = foldDynamicSoql(input.body).filter((q) => {
        const n = left.get(q) ?? 0;
        if (n > 0) left.set(q, n - 1);
        return n === 0;
      });
      setDynamicSoqlSkips(
        nodes.find((n) => String(n.qualifiedName) === classQname),
        emitDynamicSoqlEdges(ctx, classQname, classQueries, edges, 0),
      );
      // Inline SOQL outside method bodies (static field initialisers,
      // constructors, initializer blocks) belongs to the class.
      const restLoops = computeLoopRanges(rest);
      emitInlineSoqlEdges(
        ctx,
        classQname,
        rest,
        (idx) => restLoops.some((r) => idx > r.start && idx < r.end),
        edges,
        classPaths,
        classChildren,
      );
    }

    // AST-mode (and shadow mode): walk the parsed compilationUnit and emit
    // edges that the regex pass cannot derive (real call arity, dotted field
    // refs via type inference, multi-line SOQL, DML targets).
    if ((parserMode === "ast" || parserMode === "both") && parsedTree) {
      try {
        const { extractFromAst } = await import("./ast-extractor.js");
        const extraction = extractFromAst(parsedTree, {
          ctx,
          classQname,
          effectiveName,
          namespace: ctx.namespace,
        });
        if (parserMode === "both") {
          // Tag AST edges so a shadow diff can distinguish overlap.
          for (const e of extraction.edges) {
            (e.attributes as Record<string, unknown>).callResolution = "ast-shadow";
            edges.push(e);
          }
        } else {
          // Member-access field edges were already emitted per method; the AST
          // dotted-ref / select-list READS_FIELD to the same (src, dst) would
          // only duplicate them.
          const fieldKeys = new Set(
            edges
              .filter(
                (e) => e.relType === REL_TYPES.READS_FIELD || e.relType === REL_TYPES.WRITES_FIELD,
              )
              .map(
                (e) =>
                  `${e.relType}|${String(e.srcQualifiedName)}|${String(e.dstQualifiedName).toLowerCase()}`,
              ),
          );
          for (const e of extraction.edges) {
            const key = `${e.relType}|${String(e.srcQualifiedName)}|${String(e.dstQualifiedName).toLowerCase()}`;
            if (fieldKeys.has(key)) continue;
            if (e.relType === REL_TYPES.READS_FIELD || e.relType === REL_TYPES.WRITES_FIELD)
              fieldKeys.add(key);
            edges.push(e);
          }
        }
        if (parserMode === "ast") {
          // "both" keeps the regex paths (regex is authoritative there).
          for (const [qn, paths] of extraction.relationshipPaths) {
            const target =
              methodNodes.get(qn) ?? nodes.find((n) => String(n.qualifiedName) === classQname);
            if (target) setRelationshipPaths(target, paths);
          }
        }
        if (process.env.SFGRAPH_DEBUG_INGEST === "1" && extraction.diagnostics.length > 0) {
          ctx.logger?.debug?.("apex ast diagnostics", {
            className,
            diagnostics: extraction.diagnostics.slice(0, 5),
          });
        }
      } catch (e) {
        ctx.logger?.warn?.("apex ast extraction failed; falling back to regex output", {
          className,
          err: (e as Error).message,
        });
      }
    }

    // Test class linkage
    if (header.isTest) {
      const { testTargets, lowerTargets } = parseClassNameAndIsTest(cleaned);
      // Lowercase-initial names (`new myController()`) are legal class
      // names but indistinguishable from variables here: keep them as
      // candidates the post-merge resolver matches against known classes.
      const candidates: string[] = [];
      for (const t of lowerTargets) {
        if (t.toLowerCase() === effectiveName.toLowerCase()) continue;
        if (!isUserClassName(t, refScope) || refScope.localVars.has(t.toLowerCase())) continue;
        if (candidates.some((c) => c.toLowerCase() === t.toLowerCase())) continue;
        candidates.push(t);
      }
      const classNode = nodes.find((n) => String(n.qualifiedName) === classQname);
      if (classNode && candidates.length > 0)
        (classNode.attributes as Record<string, unknown>).testTargetCandidates = candidates;
      for (const t of testTargets) {
        if (t === effectiveName) continue;
        // Only plausible user classes: not Apex system types/namespaces
        // (Database, System, Test, String), SObjects, types declared in this
        // file, or declared variables/fields used as call receivers.
        if (!isUserClassName(t, refScope) || refScope.localVars.has(t.toLowerCase())) continue;
        edges.push(
          makeEdge(
            ctx,
            classQname,
            REL_TYPES.IS_TEST_FOR,
            `ApexClass:${stripNs(t, ctx.namespace)}`,
          ),
        );
      }
    }

    setChildRelationships(
      nodes.find((n) => String(n.qualifiedName) === classQname),
      classChildren,
    );
    if (classPaths.length > 0) {
      const classNode = nodes.find((n) => String(n.qualifiedName) === classQname);
      if (classNode) setRelationshipPaths(classNode, classPaths);
    }

    return { nodes, edges: aggregateGovernorFacts(edges), snippets };
  }
}

/** Store relationship paths on a node (only when there are any). */
function setRelationshipPaths(node: NodeFact, paths: ApexRelationshipPath[]): void {
  if (paths.length === 0) return;
  const attrs = node.attributes as Record<string, unknown>;
  const cur = (attrs.apexRelationshipPaths as ApexRelationshipPath[] | undefined) ?? [];
  const merged = [...cur];
  mergePaths(merged, paths);
  attrs.apexRelationshipPaths = merged;
}
