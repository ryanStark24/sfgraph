/**
 * Apex AST-based edge extractor.
 *
 * Walks the `apex-parser` ANTLR4 ParseTree to emit edges that the
 * regex-based extractor in class.ts misses or guesses at:
 *   - SOQL queries that span multiple lines or contain ternaries / nested
 *     subqueries; FROM clauses with relationship traversals.
 *   - DML statements whose target is a variable (regex captured `op` but not
 *     the real sObject) — resolved here via a per-method symbol table that
 *     tracks `SObject var` declarations from LocalVariableDeclaration,
 *     EnhancedForControl (for-each), and FormalParameter.
 *   - Dotted field access like `a.Name` and relationship traversals
 *     `Account__r.Name`, resolved against the symbol table.
 *   - Method calls with **real arity** counted from `expressionList`.
 *   - `new Foo(args)` creator expressions, again with real arity.
 *   - Class `extends`/`implements` declarations.
 *
 * Edges emitted use the same RelType constants as the regex extractor so
 * downstream consumers (dead_code_audit, trace_*, freshness_report) keep
 * working without changes.
 */
import type { EdgeFact } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";

export interface AstExtractorOpts {
  ctx: ParseContext;
  classQname: string;
  effectiveName: string;
  namespace: string | null;
}

export interface AstExtraction {
  edges: EdgeFact[];
  /** Diagnostic messages worth logging in debug mode. Not persisted. */
  diagnostics: string[];
  /** Per-method-name → arity, mostly used by tests. */
  methodArities: Map<string, number>;
}

/**
 * The apex-parser uses antlr4ts; its parse-tree nodes carry untyped `children`
 * and rule-specific accessors (e.g. `id()`, `expressionList()`). We treat
 * the tree as a structured-but-opaque value: collect text via `.text` and
 * walk children with `.getChildCount()` / `.getChild(i)`. This avoids
 * pulling antlr4ts types into our public surface and keeps the extractor
 * compatible across apex-parser minor versions.
 */
type Node = {
  text?: string;
  childCount?: number;
  constructor: { name: string };
  getChildCount?: () => number;
  getChild?: (i: number) => Node | undefined;
  children?: Node[];
} & Record<string, unknown>;

function getChildCount(n: Node): number {
  if (typeof n.getChildCount === "function") return n.getChildCount() ?? 0;
  if (Array.isArray(n.children)) return n.children.length;
  return 0;
}
function getChild(n: Node, i: number): Node | undefined {
  if (typeof n.getChild === "function") return n.getChild(i);
  if (Array.isArray(n.children)) return n.children[i];
  return undefined;
}
function ruleName(n: Node): string {
  return n.constructor?.name ?? "";
}
function nodeText(n: Node | undefined): string {
  if (!n) return "";
  if (typeof n.text === "string") return n.text;
  // Fallback: concatenate child text
  const c = getChildCount(n);
  let out = "";
  for (let i = 0; i < c; i++) out += nodeText(getChild(n, i));
  return out;
}

function* walk(root: Node): Generator<Node> {
  yield root;
  const c = getChildCount(root);
  for (let i = 0; i < c; i++) {
    const ch = getChild(root, i);
    if (ch) yield* walk(ch);
  }
}

function findDescendants(root: Node, rule: string): Node[] {
  const out: Node[] = [];
  for (const n of walk(root)) {
    if (ruleName(n) === rule) out.push(n);
  }
  return out;
}

function findAncestor(node: Node, rule: string, root: Node): Node | undefined {
  // antlr4ts attaches `parent` for parsing, but we conservatively assume
  // it may not be available across versions. Walk the tree top-down to map
  // node → ancestors; cheap because methods are small.
  let result: Node | undefined;
  const trace = (n: Node, stack: Node[]): boolean => {
    if (n === node) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const s = stack[i];
        if (s && ruleName(s) === rule) {
          result = s;
          break;
        }
      }
      return true;
    }
    const c = getChildCount(n);
    for (let i = 0; i < c; i++) {
      const ch = getChild(n, i);
      if (ch && trace(ch, [...stack, n])) return true;
    }
    return false;
  };
  trace(root, []);
  return result;
}

/**
 * Count the number of direct expression args in an apex-parser
 * ExpressionListContext. `findDescendants(..., "ExpressionContext")` over-counts
 * because each ExpressionContext can contain nested expressions. The
 * apex-parser context exposes an `expression()` accessor that returns the
 * direct args; we use it when available and fall back to counting
 * COMMA-separated direct children.
 */
function countDirectArgs(exprList: Node | undefined): number {
  if (!exprList) return 0;
  const direct = (exprList as any).expression?.();
  if (Array.isArray(direct)) return direct.length;
  // Fallback: each non-COMMA, non-terminal child is an expression slot.
  const c = getChildCount(exprList);
  if (c === 0) return 0;
  // Best signal: child count = 2n - 1 for n args (n exprs + n-1 commas).
  return Math.max(1, Math.ceil(c / 2));
}

/** Strip generics from a type ref so `Map<String, Account>` collapses to `Map`,
 *  `List<Account>` to `List`. For sObject-typed locals we want the bare type. */
function bareType(txt: string): string {
  const lt = txt.indexOf("<");
  return (lt >= 0 ? txt.slice(0, lt) : txt).trim();
}

/** Heuristic: is `name` plausibly an sObject type? Custom (__c, __e, __b, __mdt)
 *  or starts with capital letter and is not a primitive. We err inclusively —
 *  emitting a CustomObject edge that resolves to nothing is harmless and the
 *  dangling-edge audit surfaces those. */
const PRIMITIVES = new Set([
  "string",
  "boolean",
  "integer",
  "long",
  "double",
  "decimal",
  "date",
  "datetime",
  "time",
  "id",
  "blob",
  "object",
  "list",
  "set",
  "map",
  "void",
]);
function looksLikeSObject(t: string): boolean {
  if (!t) return false;
  const bare = bareType(t);
  if (!bare) return false;
  if (PRIMITIVES.has(bare.toLowerCase())) return false;
  return /^[A-Z]/.test(bare);
}

const SOQL_FIELD_NAME_RE = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/;

/** Collect every method/constructor/declaration child of `classBody` so we
 *  can iterate them with their own scope. */
function findMethodDecls(classDecl: Node): Node[] {
  return findDescendants(classDecl, "MethodDeclarationContext");
}
function findConstructorDecls(classDecl: Node): Node[] {
  return findDescendants(classDecl, "ConstructorDeclarationContext");
}

/** Per-method extraction. */
interface MethodContext {
  qname: string;
  /** symbol table: variable name → sObject type (bare, no generics) */
  vars: Map<string, string>;
}

function paramQname(
  effectiveName: string,
  methodName: string,
  arity: number,
): string {
  return `ApexMethod:${effectiveName}.${methodName}(${arity})`;
}

function indexLocalsAndParams(methodDecl: Node, scope: MethodContext): void {
  // FormalParameter — typeRef + id
  for (const fp of findDescendants(methodDecl, "FormalParameterContext")) {
    const typeRef = nodeText((fp as any).typeRef?.());
    const id = nodeText((fp as any).id?.());
    if (id && looksLikeSObject(typeRef)) {
      scope.vars.set(id, bareType(typeRef));
    }
  }
  // LocalVariableDeclaration — typeRef + variableDeclarators (we only need the var name)
  for (const lvd of findDescendants(methodDecl, "LocalVariableDeclarationContext")) {
    const typeRef = nodeText((lvd as any).typeRef?.());
    const decls = (lvd as any).variableDeclarators?.();
    if (!decls || !looksLikeSObject(typeRef)) continue;
    const bare = bareType(typeRef);
    // VariableDeclarators have one-or-more VariableDeclarator children, each starting with an id().
    for (const vd of findDescendants(decls, "VariableDeclaratorContext")) {
      const id = nodeText((vd as any).id?.());
      if (id) scope.vars.set(id, bare);
    }
  }
  // EnhancedForControl — `for (Account a : list)` binds `a` to `Account`.
  for (const efc of findDescendants(methodDecl, "EnhancedForControlContext")) {
    const typeRef = nodeText((efc as any).typeRef?.());
    const id = nodeText((efc as any).id?.());
    if (id && looksLikeSObject(typeRef)) {
      scope.vars.set(id, bareType(typeRef));
    }
  }
}

function extractSoqlEdges(
  methodDecl: Node,
  scope: MethodContext,
  ctx: ParseContext,
  edges: EdgeFact[],
  diag: string[],
): void {
  // SoqlLiteral wraps Query; both surface FromNameList. Use Query to get
  // selectList + fromNameList in one place.
  for (const q of findDescendants(methodDecl, "QueryContext")) {
    const fromList = (q as any).fromNameList?.();
    if (!fromList) continue;
    const fromObjects: string[] = [];
    for (const fn of findDescendants(fromList, "FieldNameContext")) {
      const txt = nodeText(fn).trim();
      if (!txt) continue;
      // SOQL FROM accepts dotted relationship traversal (e.g. SubQuery: `Account.Contacts`).
      const head = txt.split(".")[0] ?? txt;
      fromObjects.push(stripNs(head, ctx.namespace));
    }
    // Also: simple soqlId children when FieldName is absent.
    if (fromObjects.length === 0) {
      for (const sid of findDescendants(fromList, "SoqlIdContext")) {
        const txt = nodeText(sid).trim();
        if (txt) fromObjects.push(stripNs(txt, ctx.namespace));
      }
    }
    if (fromObjects.length === 0) {
      diag.push(`SOQL with no FROM target in ${scope.qname}`);
      continue;
    }

    const queryText = nodeText(q).trim();
    for (const obj of fromObjects) {
      edges.push(
        makeEdge(ctx, scope.qname, REL_TYPES.EXECUTES_SOQL, `CustomObject:${obj}`, {
          query: queryText.length > 500 ? queryText.slice(0, 500) + "…" : queryText,
        }),
      );
    }

    // SELECT-list fields → READS_FIELD on the *first* FROM object (good enough
    // when the query has a single root; subqueries are walked separately).
    const primary = fromObjects[0];
    if (!primary) continue;
    const selectList = (q as any).selectList?.();
    if (!selectList) continue;
    for (const fn of findDescendants(selectList, "FieldNameContext")) {
      const path = nodeText(fn).trim();
      if (!path || !SOQL_FIELD_NAME_RE.test(path)) continue;
      // `Name` → CustomField:Account.Name
      // `Account.Name` (parent traversal) → CustomField:Account.Name (the leaf)
      // `Owner.Profile.Name` → emit READS_FIELD for the trailing field only;
      //   parent traversal is a separate concern we don't try to resolve here.
      const parts = path.split(".");
      const fieldName = parts[parts.length - 1] ?? "";
      const target = parts.length > 1 ? parts.slice(0, -1).join(".") : primary;
      if (!fieldName) continue;
      edges.push(
        makeEdge(ctx, scope.qname, REL_TYPES.READS_FIELD, `CustomField:${stripNs(target, ctx.namespace)}.${fieldName}`),
      );
    }
  }

  // Detect SOSL — `[FIND ...]` shows up as SoslLiteral.
  if (findDescendants(methodDecl, "SoslLiteralContext").length > 0) {
    edges.push(makeEdge(ctx, scope.qname, REL_TYPES.EXECUTES_SOSL, "SOSL:*"));
  }
}

function extractDmlEdges(
  methodDecl: Node,
  scope: MethodContext,
  ctx: ParseContext,
  edges: EdgeFact[],
): void {
  const dmlRules: Array<[string, string]> = [
    ["InsertStatementContext", "insert"],
    ["UpdateStatementContext", "update"],
    ["DeleteStatementContext", "delete"],
    ["UndeleteStatementContext", "undelete"],
    ["UpsertStatementContext", "upsert"],
    ["MergeStatementContext", "merge"],
  ];
  for (const [rule, op] of dmlRules) {
    for (const dml of findDescendants(methodDecl, rule)) {
      const expr = (dml as any).expression?.();
      const exprTxt = nodeText(expr).trim();
      // Best-effort target resolution from the symbol table — covers
      // `insert acc;` (acc is `Account`). Method calls like
      // `Database.update(records);` keep `DML:update` with no sObject target
      // unless we can pin one down.
      let target: string | null = null;
      // If the expression is just an identifier and we know its type, use it.
      if (/^[A-Za-z_][\w]*$/.test(exprTxt)) {
        target = scope.vars.get(exprTxt) ?? null;
      }
      const attrs: Record<string, unknown> = { target: exprTxt };
      if (target) attrs.targetSObject = stripNs(target, ctx.namespace);
      edges.push(
        makeEdge(ctx, scope.qname, REL_TYPES.EXECUTES_DML, `DML:${op}`, attrs),
      );
      if (target) {
        edges.push(
          makeEdge(
            ctx,
            scope.qname,
            REL_TYPES.WRITES_FIELD,
            `CustomObject:${stripNs(target, ctx.namespace)}`,
            { dmlOp: op },
          ),
        );
      }
    }
  }
}

function extractDottedFieldRefs(
  methodDecl: Node,
  scope: MethodContext,
  ctx: ParseContext,
  edges: EdgeFact[],
): void {
  // `a.Name` parses as DotExpression{ expression=Primary{Id(a)}, anyId=Name }
  for (const de of findDescendants(methodDecl, "DotExpressionContext")) {
    const inner = (de as any).expression?.();
    const anyId = (de as any).anyId?.();
    const dotMethodCall = (de as any).dotMethodCall?.();
    // Only emit a field-read when the .X part is NOT a method call.
    if (!anyId || dotMethodCall) continue;
    const fieldName = nodeText(anyId).trim();
    if (!fieldName) continue;
    // Resolve the receiver — only handle simple identifiers (e.g. `a.Name`).
    // `Foo.bar.Name` chains are too brittle to walk for v1.
    const recvText = nodeText(inner).trim();
    if (!/^[A-Za-z_][\w]*$/.test(recvText)) continue;
    const sobj = scope.vars.get(recvText);
    if (!sobj) continue;
    // Strip Apex `__c` from the captured field name to match how CustomField
    // qnames are stored (CustomField:Account.Foo, not CustomField:Account.Foo__c).
    const normalized = fieldName.endsWith("__c") ? fieldName.slice(0, -3) : fieldName;
    edges.push(
      makeEdge(
        ctx,
        scope.qname,
        REL_TYPES.READS_FIELD,
        `CustomField:${stripNs(sobj, ctx.namespace)}.${normalized}`,
      ),
    );
  }
}

function extractMethodCalls(
  methodDecl: Node,
  scope: MethodContext,
  effectiveName: string,
  ctx: ParseContext,
  edges: EdgeFact[],
): void {
  // Static-style call `Foo.bar(args)` materializes as DotExpression whose
  // tail is DotMethodCall — capture the receiver id and the method id.
  for (const de of findDescendants(methodDecl, "DotExpressionContext")) {
    const dmc = (de as any).dotMethodCall?.();
    if (!dmc) continue;
    const recv = nodeText((de as any).expression?.()).trim();
    const methodId = nodeText((dmc as any).anyId?.()).trim();
    if (!recv || !methodId) continue;
    // Only treat `Type.method(...)` as a cross-class call when receiver is a
    // capitalized identifier (looks like a type, not a variable). Excludes
    // `acc.update()` etc. — those are instance calls on locals.
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(recv)) continue;
    if (recv === effectiveName) continue;
    const exprList = (dmc as any).expressionList?.();
    const arity = countDirectArgs(exprList);
    edges.push(
      makeEdge(
        ctx,
        scope.qname,
        REL_TYPES.CALLS,
        `ApexMethod:${stripNs(recv, ctx.namespace)}.${methodId}(${arity})`,
        { resolvedBy: "ast" },
      ),
    );
  }

  // `new Foo(args)` → INSTANCE_OF with real arity.
  for (const creator of findDescendants(methodDecl, "CreatorContext")) {
    const createdName = nodeText((creator as any).createdName?.()).trim();
    if (!createdName) continue;
    const bare = bareType(createdName);
    if (!/^[A-Z]/.test(bare)) continue;
    const ccRest = (creator as any).classCreatorRest?.();
    const arity = ccRest
      ? (() => {
          const args = (ccRest as any).arguments?.();
          const exprList = args ? (args as any).expressionList?.() : undefined;
          return countDirectArgs(exprList);
        })()
      : 0;
    edges.push(
      makeEdge(ctx, scope.qname, REL_TYPES.INSTANCE_OF, `ApexClass:${stripNs(bare, ctx.namespace)}`, {
        arity,
        resolvedBy: "ast",
      }),
    );
  }
}

function extractClassRelations(
  classDecl: Node,
  classQname: string,
  ctx: ParseContext,
  edges: EdgeFact[],
): void {
  // The ClassDeclaration may have `extends typeRef` and `implements typeList`.
  const extendsRef = (classDecl as any).typeRef?.();
  if (extendsRef) {
    const name = bareType(nodeText(extendsRef));
    if (name && /^[A-Z]/.test(name)) {
      edges.push(
        makeEdge(ctx, classQname, REL_TYPES.EXTENDS, `ApexClass:${stripNs(name, ctx.namespace)}`),
      );
    }
  }
  const implList = (classDecl as any).typeList?.();
  if (implList) {
    for (const tr of findDescendants(implList, "TypeRefContext")) {
      const name = bareType(nodeText(tr));
      if (name && /^[A-Z]/.test(name)) {
        edges.push(
          makeEdge(
            ctx,
            classQname,
            REL_TYPES.IMPLEMENTS,
            `ApexInterface:${stripNs(name, ctx.namespace)}`,
          ),
        );
      }
    }
  }
}

/**
 * Public entry point. Walks the parsed compilationUnit and returns edges.
 * Pass the tree returned by `parser.compilationUnit()`.
 */
export function extractFromAst(tree: unknown, opts: AstExtractorOpts): AstExtraction {
  const edges: EdgeFact[] = [];
  const diagnostics: string[] = [];
  const methodArities = new Map<string, number>();
  const root = tree as Node;

  const classDecls = findDescendants(root, "ClassDeclarationContext");
  for (const cd of classDecls) {
    const id = nodeText((cd as any).id?.()).trim();
    // Only walk the outermost class with name matching effectiveName, plus
    // any inner classes (their methods belong to the outer qname here — we
    // attribute them all to the outer class for v1 simplicity).
    if (!id) continue;
    extractClassRelations(cd, opts.classQname, opts.ctx, edges);

    const methodDecls = [...findMethodDecls(cd), ...findConstructorDecls(cd)];
    for (const md of methodDecls) {
      const methodName = nodeText((md as any).id?.()).trim();
      const formalParams = (md as any).formalParameters?.();
      const arity = formalParams
        ? findDescendants(formalParams, "FormalParameterContext").length
        : 0;
      if (!methodName) continue;
      methodArities.set(methodName, arity);
      const qname = paramQname(opts.effectiveName, methodName, arity);
      const scope: MethodContext = { qname, vars: new Map() };
      indexLocalsAndParams(md, scope);
      extractSoqlEdges(md, scope, opts.ctx, edges, diagnostics);
      extractDmlEdges(md, scope, opts.ctx, edges);
      extractDottedFieldRefs(md, scope, opts.ctx, edges);
      extractMethodCalls(md, scope, opts.effectiveName, opts.ctx, edges);
    }
  }

  return { edges, diagnostics, methodArities };
}
