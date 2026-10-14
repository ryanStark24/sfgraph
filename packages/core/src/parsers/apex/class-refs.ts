/**
 * Regex-path Apex reference rules shared by class and trigger bodies:
 *   - `Foo.bar(…)` static calls → CALLS `ApexMethod:Foo.bar(<arity>)`
 *   - `new Foo(…)` constructors → INSTANCE_OF `ApexClass:Foo`
 *   - `Foo.IDENT` static members (constants, enum values, inner types,
 *     `Foo.class`) → REFERENCES `ApexClass:Foo`
 *   - object describes (`Schema.SObjectType.Obj`, `SObjectType.Obj`,
 *     `Obj.SObjectType`) → REFERENCES `CustomObject:Obj`, `via: "describe"`
 *
 * Every scan runs on `stripCommentsAndStrings` output, so commented-out code
 * and string contents never yield edges. Constructor and member rules skip
 * Apex system types/namespaces, SObjects (standard or custom-suffixed), the
 * enclosing class, types declared in the same file and declared variables.
 */
import {
  APEX_PLATFORM_NAMESPACES,
  type EdgeFact,
  REL_TYPES,
  STANDARD_SOBJECT_WHITELIST,
} from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";
import { findInlineQueries } from "./soql-fields.js";

export const NEW_INSTANCE_RE = /\bnew\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
export const STATIC_CALL_RE = /(?<![\w.])([A-Z][A-Za-z0-9_]*)\.([a-z][A-Za-z0-9_]*)\s*\(/g;
const NEW_RE = /(?<![\w.])new\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
const MEMBER_RE = /(?<![\w.$])([A-Z][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)(?![\w])/g;
const CUSTOM_SUFFIX_RE = /__(c|r|mdt|e|x|b|kav|share|history|feed)$/i;
const STANDARD_LOWER = new Set([...STANDARD_SOBJECT_WHITELIST].map((s) => s.toLowerCase()));
/** Standard objects commonly used from Apex but absent from the whitelist. */
const EXTRA_STANDARD_SOBJECTS = new Set(
  [
    "CustomNotificationType",
    "ContentDistribution",
    "ContentDocument",
    "ContentDocumentLink",
    "ContentVersion",
    "ContentWorkspace",
    "CollaborationGroup",
    "CollaborationGroupMember",
    "SocialPost",
    "SocialPersona",
    "QuoteDocument",
    "FeedItem",
    "FeedComment",
    "Attachment",
    "Document",
    "Folder",
    "EmailMessage",
    "EmailTemplate",
    "OrgWideEmailAddress",
    "Group",
    "GroupMember",
    "Queue",
    "QueueSobject",
    "UserRole",
    "Profile",
    "PermissionSet",
    "PermissionSetAssignment",
    "RecordType",
    "BusinessHours",
    "Holiday",
    "CronTrigger",
    "AsyncApexJob",
    "ApexClass",
    "ApexTrigger",
    "StaticResource",
    "Organization",
    "ProcessInstance",
    "ProcessInstanceWorkitem",
    "ProcessInstanceStep",
    "Network",
    "NetworkMember",
    "Topic",
    "TopicAssignment",
    "Note",
    "Event",
    "Task",
    "EntitySubscription",
    "CaseComment",
    "CaseMilestone",
    "Entitlement",
    "ServiceContract",
    "Pricebook2",
    "PricebookEntry",
    "Product2",
    "Asset",
    "Order",
    "OrderItem",
    "Quote",
    "QuoteLineItem",
  ].map((s) => s.toLowerCase()),
);
/** Derived standard objects: `AccountShare`, `OpportunityHistory`, `CaseFeed`, … */
const DERIVED_SOBJECT_RE = /^(.+?)(Share|History|Feed|ChangeEvent|Tag)$/i;
/** Managed-package namespaces (lower-cased) that are never user classes. */
const MANAGED_NAMESPACES = new Set([
  "vlocity_cmt",
  "vlocity_ins",
  "vlocity_ps",
  "omnistudio",
  "vlocity",
  "sbqq",
  "sbaa",
  "blng",
]);

function isStandardSObject(lower: string): boolean {
  if (STANDARD_LOWER.has(lower) || EXTRA_STANDARD_SOBJECTS.has(lower)) return true;
  const d = lower.match(DERIVED_SOBJECT_RE);
  const base = d?.[1] ?? "";
  return base !== "" && (STANDARD_LOWER.has(base) || EXTRA_STANDARD_SOBJECTS.has(base));
}

export interface ClassRefScope {
  /** The enclosing class (never referenced by itself). */
  selfName?: string;
  /** Lower-cased types declared in this file (inner classes, enums, interfaces). */
  localTypes: ReadonlySet<string>;
  /** Lower-cased names of declared variables/params/fields in this file that
   *  are not also used as a declared type (see `localVarNames`). Only the
   *  member rule consults it: `new X(` is always a type. */
  localVars: ReadonlySet<string>;
}

/** True when `name` can plausibly be a user Apex class (not system/SObject/local). */
export function isUserClassName(name: string, scope: ClassRefScope): boolean {
  const lower = name.toLowerCase();
  if (scope.selfName && lower === scope.selfName.toLowerCase()) return false;
  if (APEX_PLATFORM_NAMESPACES.has(lower)) return false;
  if (MANAGED_NAMESPACES.has(lower)) return false;
  if (CUSTOM_SUFFIX_RE.test(name) || isStandardSObject(lower)) return false;
  return !scope.localTypes.has(lower);
}

/**
 * Lower-cased variable names for `ClassRefScope.localVars`. Apex is
 * case-insensitive, so `Opportunity opp; Opp.StageName` is a variable access.
 * A name that is also a declared type in the file (`WidgetService
 * widgetService`) is left out so `WidgetService.MODE` still counts.
 */
export function localVarNames(
  decls: ReadonlyArray<{ name: string; type: string | null; elem: string | null }>,
): Set<string> {
  const types = new Set<string>();
  for (const d of decls) {
    for (const t of [d.type, d.elem]) {
      if (!t) continue;
      const lower = t.toLowerCase();
      types.add(lower);
      types.add(lower.split(".")[0] ?? lower);
    }
  }
  const out = new Set<string>();
  for (const d of decls) {
    const lower = d.name.toLowerCase();
    if (!types.has(lower)) out.add(lower);
  }
  return out;
}

/**
 * When the `<` at `lt` opens a type-argument list (`Map<Id, Contact>`), the
 * index of its matching `>`; otherwise -1. A type-argument list follows an
 * identifier and holds only identifiers, dots, commas, whitespace, `[]` and
 * nested `<>`; a relational `<` fails one of those tests. Inside a call's
 * argument list a type can only appear after `new`, in a cast `(T<..>)`, or
 * as `T<..>.class`, so the list must be preceded by `new` or followed by `)`,
 * `.`, `[` or `>`: `f(i<n, j>m)` is two comparisons, not `i<n, j>`.
 */
function genericClose(body: string, lt: number): number {
  if (!/[\w]/.test(body[lt - 1] ?? "")) return -1;
  let d = 0;
  for (let j = lt; j < body.length; j++) {
    const c = body[j] ?? "";
    if (c === "<") d += 1;
    else if (c === ">") {
      d -= 1;
      if (d === 0) return typeContext(body, lt, j) ? j : -1;
    } else if (!/[\w.,\s[\]]/.test(c)) return -1;
  }
  return -1;
}

function typeContext(body: string, lt: number, gt: number): boolean {
  const before = body.slice(Math.max(0, lt - 200), lt);
  if (/\bnew\s+[\w.]+$/i.test(before)) return true;
  const next = /\S/.exec(body.slice(gt + 1))?.[0] ?? "";
  return next === ")" || next === "." || next === "[" || next === ">";
}

/**
 * Count the arguments in a balanced parenthesised arg list; `openParenIdx`
 * points at the `(` opening the call. Handles nested parens/brackets/braces,
 * generic type arguments, string literals and comments. Null when the parens never close (truncated / unbalanced).
 */
export function countCallArgs(body: string, openParenIdx: number): number | null {
  let depth = 1;
  let i = openParenIdx + 1;
  let argCount = 0;
  let sawNonWhitespace = false;
  while (i < body.length && depth > 0) {
    const ch = body[i];
    if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i + 2);
      i = nl < 0 ? body.length : nl + 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      const close = body.indexOf("*/", i + 2);
      i = close < 0 ? body.length : close + 2;
      continue;
    }
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
    if (ch === "<") {
      const close = genericClose(body, i);
      if (close > 0) {
        i = close + 1;
        sawNonWhitespace = true;
        continue;
      }
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === "," && depth === 1) {
      argCount += 1;
    } else if (ch && /\S/.test(ch)) {
      sawNonWhitespace = true;
    }
    i += 1;
  }
  if (depth !== 0) return null;
  return sawNonWhitespace ? argCount + 1 : 0;
}

/**
 * Static calls `Foo.bar(…)` → CALLS `ApexMethod:Foo.bar(<arity>)`, `(?)` with
 * `unresolvedArity` when the args can't be counted. `selfName` calls are skipped,
 * and so are receivers in `localVars` (lower-cased declared variables, params
 * and fields): `CODE_XY.toLowerCase()` on a capitalised field is an instance
 * call, not a call on a class named CODE_XY.
 */
export function emitStaticCallEdges(
  ctx: ParseContext,
  srcQname: string,
  body: string,
  selfName: string | undefined,
  edges: EdgeFact[],
  localVars?: ReadonlySet<string>,
): void {
  const scRe = new RegExp(STATIC_CALL_RE.source, "g");
  let sc: RegExpExecArray | null = scRe.exec(body);
  while (sc !== null) {
    const target = sc[1] ?? "";
    const targetMethod = sc[2] ?? "";
    if (
      target !== selfName &&
      /^[A-Z]/.test(target) &&
      !(localVars?.has(target.toLowerCase()) ?? false)
    ) {
      const arity = countCallArgs(body, scRe.lastIndex - 1);
      const dstArity = arity == null ? "?" : String(arity);
      const attrs: Record<string, unknown> =
        arity == null ? { unresolvedArity: true } : { callResolution: "regex-arg-count", arity };
      edges.push(
        makeEdge(
          ctx,
          srcQname,
          REL_TYPES.CALLS,
          `ApexMethod:${stripNs(target, ctx.namespace)}.${targetMethod}(${dstArity})`,
          attrs,
        ),
      );
    }
    sc = scRe.exec(body);
  }
}

/**
 * Blank inline SOQL/SOSL `[…]` text except bind expressions (`:Foo.BAR`), so
 * relationship paths (`Owner.Name`) aren't read as class member access.
 * Length-preserving.
 */
function maskInlineQueries(code: string): string {
  // Each query spans `[SELECT` / `[FIND` to its depth-0 `]` (findInlineQueries),
  // so a bind like `:ids[0]` does not end it early. Queries are disjoint or
  // nested, and an outer query's text holds a nested one's binds, so every
  // bind survives whatever order the queries are masked in.
  const chars = code.split("");
  const queries = [...findInlineQueries(code), ...findInlineQueries(code, "FIND")];
  for (const q of queries) {
    const keep = new Array<boolean>(q.text.length).fill(false);
    for (const b of q.text.matchAll(/:\s*[A-Za-z_][\w.]*/g)) {
      for (let k = 0; k < b[0].length; k++) keep[(b.index ?? 0) + k] = true;
    }
    for (let k = 0; k < q.text.length; k++) {
      const c = q.text[k] ?? "";
      if (!keep[k] && c !== "\n") chars[q.index + k] = " ";
    }
  }
  return chars.join("");
}

/**
 * `new Foo(…)` → INSTANCE_OF `ApexClass:Foo` and `Foo.IDENT` → REFERENCES
 * `ApexClass:Foo`, one edge per (src, dst). `code` is comment/string-stripped.
 * `Foo.bar(` (a lower-case static call) is left to the CALLS rule.
 */
export function emitClassRefEdges(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  scope: ClassRefScope,
  edges: EdgeFact[],
): void {
  const masked = maskInlineQueries(code);
  const seen = new Set<string>();
  for (const m of masked.matchAll(NEW_RE)) {
    const name = m[1] ?? "";
    if (!isUserClassName(name, scope)) continue;
    const dst = `ApexClass:${stripNs(name, ctx.namespace)}`;
    const key = `I|${dst.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const arity = countCallArgs(masked, (m.index ?? 0) + m[0].length - 1);
    edges.push(
      makeEdge(ctx, srcQname, REL_TYPES.INSTANCE_OF, dst, {
        via: "regex-new",
        ...(arity == null ? {} : { arity }),
      }),
    );
  }
  for (const m of masked.matchAll(MEMBER_RE)) {
    const name = m[1] ?? "";
    const member = m[2] ?? "";
    const after = masked.slice((m.index ?? 0) + m[0].length);
    if (/^[a-z]/.test(member) && /^\s*\(/.test(after)) continue; // static call
    if (CUSTOM_SUFFIX_RE.test(member)) continue; // SObject field token
    if (scope.localVars.has(name.toLowerCase()) || !isUserClassName(name, scope)) continue;
    const dst = `ApexClass:${stripNs(name, ctx.namespace)}`;
    const key = `R|${dst.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(makeEdge(ctx, srcQname, REL_TYPES.REFERENCES, dst, { via: "static-member" }));
  }
}

// `Foo x;` / `Foo x = …` / `Foo[] xs,` / `Foo x)` (param) / `Foo x :` (loop) /
// `Foo name(` (return type). Each quantifier is separated by a fixed token,
// so the scan stays linear.
const TYPE_DECL_RE = /(?<![\w.$])([A-Za-z_]\w*)(?:\s*\[\s*\])?\s+([A-Za-z_]\w*)\s*[=;,:)(]/g;
const TYPE_CAST_RE = /\(\s*([A-Z]\w*)\s*\)\s*[\w(]/g;
const INSTANCEOF_RE = /\binstanceof\s+([A-Za-z_]\w*)\b/gi;

/** Identifiers in the type-argument lists of `code` (`Map<Id, Foo>`). Linear:
 *  a failed list is skipped past its failure point, never rescanned. */
function genericArgNames(code: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== "<" || !/[A-Za-z0-9_]/.test(code[i - 1] ?? "")) continue;
    let d = 0;
    let j = i;
    for (; j < code.length; j++) {
      const c = code[j] ?? "";
      if (c === "<") d += 1;
      else if (c === ">") {
        d -= 1;
        if (d === 0) break;
      } else if (!/[\w.,\s[\]]/.test(c)) break;
    }
    if (d === 0 && j < code.length) {
      for (const m of code.slice(i + 1, j).matchAll(/(?<![\w.])[A-Za-z_]\w*/g)) out.push(m[0]);
    }
    i = j;
  }
  return out;
}

/**
 * Type-only uses (declarations, parameters, return types, loop variables,
 * generic arguments, casts, `instanceof`) → REFERENCES `ApexClass:T` or, for a
 * custom-suffixed SObject, `CustomObject:T`, both `via: "type"`. Only
 * UpperCamel user class names (same filter as the constructor rule, never
 * the enclosing class); a (src, dst) already holding an INSTANCE_OF or a
 * REFERENCES in `edges` since `fromIdx` is skipped. `code` is comment/string-masked.
 */
export function emitTypeRefEdges(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  scope: ClassRefScope,
  edges: EdgeFact[],
  fromIdx = 0,
): void {
  const masked = maskInlineQueries(code);
  const seen = new Set<string>();
  for (let i = fromIdx; i < edges.length; i++) {
    const e = edges[i];
    if (!e || String(e.srcQualifiedName) !== srcQname) continue;
    if (e.relType === REL_TYPES.REFERENCES || e.relType === REL_TYPES.INSTANCE_OF)
      seen.add(String(e.dstQualifiedName).toLowerCase());
  }
  const add = (name: string, castLike = false): void => {
    let dst: string;
    if (DESCRIBE_OBJECT_SUFFIX_RE.test(name)) dst = `CustomObject:${stripNs(name, ctx.namespace)}`;
    // UpperCamel only: `MAX_SIZE` is a constant, not a type.
    else if (/^[A-Z]\w*[a-z]/.test(name) && isUserClassName(name, scope)) {
      // A cast or `instanceof` operand could be a capitalised variable.
      if (castLike && scope.localVars.has(name.toLowerCase())) return;
      dst = `ApexClass:${stripNs(name, ctx.namespace)}`;
    } else return;
    if (seen.has(dst.toLowerCase())) return;
    seen.add(dst.toLowerCase());
    edges.push(makeEdge(ctx, srcQname, REL_TYPES.REFERENCES, dst, { via: "type" }));
  };
  for (const m of masked.matchAll(TYPE_DECL_RE)) add(m[1] ?? "");
  for (const n of genericArgNames(masked)) add(n);
  for (const m of masked.matchAll(TYPE_CAST_RE)) add(m[1] ?? "", true);
  for (const m of masked.matchAll(INSTANCEOF_RE)) add(m[1] ?? "", true);
}

const DESCRIBE_TYPE_RE = /(?<![\w.$])(?:Schema\s*\.\s*)?SObjectType\s*\.\s*([A-Za-z_]\w*)/gi;
const TYPE_TOKEN_RE = /(?<![\w.$])([A-Za-z_]\w*)\s*\.\s*SObjectType(?![\w])/gi;
const DESCRIBE_OBJECT_SUFFIX_RE = /__(c|mdt|e|x|b|kav)$/i;

/**
 * Cycle 3 T7: an object describe (`Schema.SObjectType.Obj.getRecordTypeInfosByName()`,
 * `SObjectType.Obj.fields.F`, `Obj.SObjectType`) reads that object's metadata,
 * so the code depends on the object → REFERENCES `CustomObject:Obj` with
 * `via: "describe"`, one per (src, object). Only names shaped like an object
 * (custom suffix or a standard object); `code` is comment/string-stripped.
 */
export function emitDescribeRefEdges(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  edges: EdgeFact[],
): void {
  const seen = new Set<string>();
  const add = (name: string): void => {
    if (!DESCRIBE_OBJECT_SUFFIX_RE.test(name) && !isStandardSObject(name.toLowerCase())) return;
    const dst = `CustomObject:${stripNs(name, ctx.namespace)}`;
    if (seen.has(dst.toLowerCase())) return;
    seen.add(dst.toLowerCase());
    edges.push(makeEdge(ctx, srcQname, REL_TYPES.REFERENCES, dst, { via: "describe" }));
  };
  for (const m of code.matchAll(DESCRIBE_TYPE_RE)) add(m[1] ?? "");
  for (const m of code.matchAll(TYPE_TOKEN_RE)) add(m[1] ?? "");
}
