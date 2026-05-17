import { createHash } from "node:crypto";
import { asOrgId, asQualifiedName, asSha256 } from "@ryanstark24/sfgraph-shared";
import { type EdgeFact, METADATA_CATEGORY, type NodeFact, REL_TYPES } from "../../domain/index.js";
import type { SnippetRecord } from "../../storage/interfaces.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { parseAnnotations, stripCommentsAndStrings } from "./common.js";

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

const METHOD_RE =
  /(?:@[\w()=,'"\s.]+\s+)*(?:(public|private|protected|global|virtual|override|abstract|static|webservice|with\s+sharing|without\s+sharing|inherited\s+sharing|testmethod|final)\s+)+([A-Za-z_][\w<>,.\s\[\]]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/gi;

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

function parseParams(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  return t.split(",").map((s) => s.trim());
}

function extractClassHeader(src: string): {
  name: string;
  extendsClass: string | null;
  implementsList: string[];
  isInterface: boolean;
  isTest: boolean;
  modifiers: string[];
} {
  const headerMatch = src.match(
    /(?:@[\w()=,'"\s.]+\s+)*((?:public|private|global|virtual|abstract|with\s+sharing|without\s+sharing|inherited\s+sharing|\s)+)?(class|interface)\s+([A-Za-z_]\w*)(?:\s+extends\s+([A-Za-z_][\w.]*))?(?:\s+implements\s+([A-Za-z_][\w.,\s]*))?\s*\{/i,
  );
  if (!headerMatch) {
    return {
      name: "",
      extendsClass: null,
      implementsList: [],
      isInterface: false,
      isTest: false,
      modifiers: [],
    };
  }
  const mods = (headerMatch[1] ?? "")
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0);
  const isInterface = (headerMatch[2] ?? "").toLowerCase() === "interface";
  const name = headerMatch[3] ?? "";
  const extendsClass = headerMatch[4] ?? null;
  const implementsList = (headerMatch[5] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // class-level annotations
  const headerStart = src.indexOf(headerMatch[0]);
  const before = src.slice(0, headerStart);
  const classAnnotations = parseAnnotations(before).map((a) => a.name.toLowerCase());
  const isTest = classAnnotations.includes("istest");

  return { name, extendsClass, implementsList, isInterface, isTest, modifiers: mods };
}

function findMethods(src: string): MethodInfo[] {
  const out: MethodInfo[] = [];
  const re = new RegExp(METHOD_RE.source, "gi");
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    const returnType = (m[2] ?? "").trim();
    const name = m[3] ?? "";
    const params = parseParams(m[4] ?? "");
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

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const SOQL_RE = /\[\s*SELECT\b([^\]]*?)\bFROM\s+([A-Za-z_][\w.]*)/gi;
const SOSL_RE = /\[\s*FIND\b/gi;
const DML_RE = /\b(insert|update|delete|upsert|undelete|merge)\s+([A-Za-z_][\w.]*)/gi;
const FIELD_ACCESS_RE = /\b([A-Z][A-Za-z0-9_]*(?:__r)?)\.([A-Za-z_][\w]*?)(?:__c)?\b/g;
const NEW_INSTANCE_RE = /\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
const STATIC_CALL_RE = /\b([A-Z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\s*\(/g;

/**
 * Count the arguments in a balanced parenthesised arg list starting one
 * character after `openParenIdx` (which must point at the `(` opening the
 * call). Handles nested parens, string literals, and single-line `//`
 * plus block `/* * /` comments. Returns the arg count, or `null` if the
 * caller's parens never close inside `body` (truncated source / unbalanced).
 *
 * Used by the regex pass to emit `ApexMethod:Foo.bar(2)` instead of the
 * `(?)` ambiguity placeholder — turning most regex-mode CALLS edges into
 * precise-arity edges that bypass the arity resolver's overload fan-out.
 * Cases that genuinely can't be counted (lambdas, splat, comment-split
 * args) fall back to `(?)` — preserving the existing ambiguous-fan-out
 * semantics on the long tail.
 */
function countCallArgs(body: string, openParenIdx: number): number | null {
  // empty args → arity 0; we detect by peeking for the matching `)` after
  // any whitespace before counting commas.
  let depth = 1;
  let i = openParenIdx + 1;
  let argCount = 0;
  let sawNonWhitespace = false;
  while (i < body.length && depth > 0) {
    const ch = body[i];
    // Line comment
    if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i + 2);
      i = nl < 0 ? body.length : nl + 1;
      continue;
    }
    // Block comment
    if (ch === "/" && body[i + 1] === "*") {
      const close = body.indexOf("*/", i + 2);
      i = close < 0 ? body.length : close + 2;
      continue;
    }
    // String literal — Apex uses single-quoted strings with `\\` and `\'` escapes
    if (ch === "'") {
      i += 1;
      while (i < body.length) {
        const c = body[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      sawNonWhitespace = true;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === "," && depth === 1) {
      argCount += 1;
    } else if (ch && /\S/.test(ch)) {
      sawNonWhitespace = true;
    }
    i += 1;
  }
  if (depth !== 0) return null; // unbalanced — let caller emit `(?)`
  // No commas + no non-whitespace content between parens = arity 0.
  // Any non-whitespace + N commas = N+1 args.
  return sawNonWhitespace ? argCount + 1 : 0;
}
const NAMED_CRED_RE = /['"]callout:([A-Za-z_][\w]*)/g;

function parseClassNameAndIsTest(body: string): {
  isTest: boolean;
  testTargets: Set<string>;
} {
  const testTargets = new Set<string>();
  const m = body.match(/@isTest\s*\(\s*seeAllData\s*=\s*[^)]*\)|@isTest/i);
  if (!m) return { isTest: false, testTargets };
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
  return { isTest: true, testTargets };
}

export class ApexClassParser implements Parser<ApexClassInput> {
  readonly category = METADATA_CATEGORY.APEX_CLASS;
  readonly type = "ApexClass";

  async parse(input: ApexClassInput, ctx: ParseContext): Promise<ParseResult> {
    const nodes: NodeFact[] = [];
    const edges: EdgeFact[] = [];
    const snippets: SnippetRecord[] = [];
    const className = stripNs(input.className, ctx.namespace);
    const fileHash = sha256(input.body);

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
      const input1 = new CaseInsensitiveInputStream("file", input.body);
      const lexer = new ApexLexer(input1);
      lexer.removeErrorListeners();
      lexer.addErrorListener(new ThrowingErrorListener());
      const tokens = new CommonTokenStream(lexer);
      const parser = new ApexParser(tokens);
      parser.removeErrorListeners();
      parser.addErrorListener(new ThrowingErrorListener());
      parsedTree = parser.compilationUnit();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      nodes.push(
        makeNode(
          ctx,
          "ParseError",
          `ParseError:ApexClass:${className}`,
          { className, message: errMsg },
          sha256(`${className}:${errMsg}`),
        ),
      );
      return { nodes, edges };
    }

    const cleaned = stripCommentsAndStrings(input.body);
    const header = extractClassHeader(cleaned);
    const effectiveName = header.name || className;
    const classQname = header.isInterface
      ? `ApexInterface:${effectiveName}`
      : `ApexClass:${effectiveName}`;
    const apiVersion = extractApiVersion(input.metaXml);

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
        },
        fileHash,
      ),
    );

    if (header.extendsClass) {
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
    const methods = findMethods(cleaned);
    for (const m of methods) {
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

      nodes.push(
        makeNode(
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
          },
          sha256(m.body),
        ),
      );
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

      // Body analysis (regex path — gated when parserMode === "ast").
      const body = m.body;
      if (parserMode === "ast") {
        // AST mode handles per-method edges in a single tree walk after this loop;
        // skip the regex extraction here to avoid duplicate / inconsistent edges.
        continue;
      }

      // SOQL
      const soqlRe = new RegExp(SOQL_RE.source, "gi");
      let sq: RegExpExecArray | null = soqlRe.exec(body);
      while (sq !== null) {
        const obj = stripNs(sq[2] ?? "", ctx.namespace);
        edges.push(
          makeEdge(ctx, methodQname, REL_TYPES.EXECUTES_SOQL, `CustomObject:${obj}`, {
            query: sq[0]?.trim(),
          }),
        );
        // READS_FIELD for SELECT clause fields
        const selectFields = (sq[1] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !/[()*]/.test(s));
        for (const f of selectFields) {
          const fname = f.split(/\s+/)[0] ?? "";
          if (/^[A-Za-z_][\w]*$/.test(fname)) {
            edges.push(
              makeEdge(ctx, methodQname, REL_TYPES.READS_FIELD, `CustomField:${obj}.${fname}`),
            );
          }
        }
        sq = soqlRe.exec(body);
      }

      // SOSL
      const soslRe = new RegExp(SOSL_RE.source, "gi");
      if (soslRe.test(body)) {
        edges.push(makeEdge(ctx, methodQname, REL_TYPES.EXECUTES_SOSL, "SOSL:*"));
      }

      // DML
      const dmlRe = new RegExp(DML_RE.source, "gi");
      let dm: RegExpExecArray | null = dmlRe.exec(body);
      while (dm !== null) {
        const op = (dm[1] ?? "").toLowerCase();
        edges.push(
          makeEdge(ctx, methodQname, REL_TYPES.EXECUTES_DML, `DML:${op}`, {
            target: dm[2],
          }),
        );
        dm = dmlRe.exec(body);
      }

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
        nc = ncRe.exec(body);
      }

      // Calls to other static methods (best-effort)
      const scRe = new RegExp(STATIC_CALL_RE.source, "g");
      let sc: RegExpExecArray | null = scRe.exec(body);
      while (sc !== null) {
        const target = sc[1] ?? "";
        const targetMethod = sc[2] ?? "";
        if (target !== effectiveName && /^[A-Z]/.test(target)) {
          // The regex's match index + match length lands one char before
          // the `(`. Walk forward past any whitespace to find it, then
          // count balanced args. When counting succeeds we emit a precise
          // arity dst (same shape AST pass uses), which skips the
          // arity-resolver's overload fan-out entirely.
          const matchEnd = scRe.lastIndex - 1;
          const arity = countCallArgs(body, matchEnd);
          const dstArity = arity == null ? "?" : String(arity);
          const attrs: Record<string, unknown> =
            arity == null
              ? { unresolvedArity: true }
              : { resolvedBy: "regex-arg-count", arity };
          edges.push(
            makeEdge(
              ctx,
              methodQname,
              REL_TYPES.CALLS,
              `ApexMethod:${stripNs(target, ctx.namespace)}.${targetMethod}(${dstArity})`,
              attrs,
            ),
          );
        }
        sc = scRe.exec(body);
      }
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
            (e.attributes as Record<string, unknown>).resolvedBy = "ast-shadow";
            edges.push(e);
          }
        } else {
          for (const e of extraction.edges) edges.push(e);
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
      const { testTargets } = parseClassNameAndIsTest(cleaned);
      for (const t of testTargets) {
        if (t === effectiveName) continue;
        if (!/^[A-Z]/.test(t)) continue;
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

    return { nodes, edges, snippets };
  }
}
