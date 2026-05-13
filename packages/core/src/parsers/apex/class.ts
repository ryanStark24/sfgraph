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

    // Validate parse via apex-parser. On failure: emit ParseError only.
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
      parser.compilationUnit();
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

      // Body analysis
      const body = m.body;

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
          edges.push(
            makeEdge(
              ctx,
              methodQname,
              REL_TYPES.CALLS,
              `ApexMethod:${stripNs(target, ctx.namespace)}.${targetMethod}(?)`,
              { unresolvedArity: true },
            ),
          );
        }
        sc = scRe.exec(body);
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
