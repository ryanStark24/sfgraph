/**
 * Regex-path Apex rules that need a receiver's or record's declared type, or
 * the text of a string argument. Shared by class and trigger bodies.
 *
 *   - instance calls: `svc.process(…)` on a typed local / parameter / field,
 *     `this.f.m(…)`, `new Foo(…).m(…)`, same-class `helper(…)` /
 *     `this.helper(…)` / `Self.helper(…)` and `super.m(…)` → CALLS
 *     `ApexMethod:<Class>.<m>(<arity>)` (the static-call shape);
 *   - custom labels: `Label.X`, `System.Label.X`, `Label.ns.X` →
 *     REFERENCES_LABEL `CustomLabel:X`;
 *   - `Type.forName('X')` / `Type.forName(ns, 'X')` → REFERENCES `ApexClass:X`;
 *   - `rec.get('F')` / `rec.put('F', v)` on an sObject-typed record →
 *     READS_FIELD / WRITES_FIELD `CustomField:Obj.F`;
 *   - field tokens: `SObjectType.Obj.fields.F`, `Obj.F` (a describe or an
 *     `SObjectField`) → REFERENCES `CustomField:Obj.F`;
 *   - `EventBus.publish(x)` with an `X__e`-typed argument → PUBLISHES_EVENT
 *     `PlatformEvent:X__e` (the node Flow, LWC and Aura event edges use too).
 *
 * Every rule emits only what the text pins down: an untyped or unknown
 * receiver, a computed name or an ambiguous namespace yields nothing.
 *
 * `code` is the length-preserving `maskApex` output (comment text and string
 * contents blanked, quotes kept); `raw` is the source it was masked from, so
 * a string literal's text is read from `raw` at the same offsets.
 */
import { APEX_PLATFORM_NAMESPACES, type EdgeFact, REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";
import {
  type ClassRefScope,
  countCallArgs,
  isStandardSObject,
  isUserClassName,
  maskInlineQueries,
} from "./class-refs.js";
import { type VarDecl, resolveDecl } from "./field-access.js";
import { findInlineQueries, soqlFieldRefs } from "./soql-fields.js";

/** The declared type of variable `name` visible at offset `at`, if any. */
export type TypeLookup = (name: string, at: number) => VarDecl | undefined;

/**
 * Lookup over `decls` (locals with their offsets, parameters at -1) with the
 * enclosing class's fields as fallback (see field-access `resolveDecl`).
 */
export function makeTypeLookup(decls: VarDecl[], outer: VarDecl[] = []): TypeLookup {
  return (name, at) => resolveDecl(name, at, { decls, outer });
}

const IDENT = "[A-Za-z_]\\w*";
/** Declared types that are never a record. */
const NOT_RECORD = new Set([
  "sobject",
  "string",
  "object",
  "id",
  "boolean",
  "integer",
  "long",
  "double",
  "decimal",
  "date",
  "datetime",
  "time",
  "blob",
  "list",
  "set",
  "map",
]);

/** `t` names a concrete sObject type: a plain identifier, not a primitive or `SObject`. */
function recordType(t: string | null | undefined, excluded: ReadonlySet<string>): string | null {
  if (!t || !/^[A-Za-z]\w*$/.test(t)) return null;
  const lower = t.toLowerCase();
  if (NOT_RECORD.has(lower) || excluded.has(lower)) return null;
  return t;
}

export interface RecordTypeOpts {
  lookup?: TypeLookup | undefined;
  /** SObject of the enclosing trigger: `Trigger.new` / `Trigger.old` are its records. */
  triggerObject?: string | undefined;
  /** Lower-cased types declared in the same file (never sObjects). */
  excludedTypes?: ReadonlySet<string>;
}

/**
 * The sObject type of the record expression starting at `code[at]` (a DML
 * operand or a publish argument): `new T(…)`, `new T[]…`, `new List<T>…`,
 * an inline `[SELECT … FROM T]`, a typed variable (`x`, `this.x`, its
 * collection's element type, `m.values()`), or `Trigger.new` / `Trigger.old`.
 * Null when not pinned down.
 */
export function recordTypeAt(code: string, at: number, opts: RecordTypeOpts): string | null {
  const excluded = opts.excludedTypes ?? new Set<string>();
  const text = code.slice(at, at + 400);
  const nw = text.match(
    new RegExp(`^new\\s+(${IDENT}(?:\\s*\\.\\s*${IDENT})?)\\s*(?:<\\s*(${IDENT})\\s*>)?\\s*[([{]`),
  );
  if (nw) {
    const outer = (nw[1] ?? "").replace(/\s+/g, "").replace(/^schema\./i, "");
    const lower = outer.toLowerCase();
    if (lower === "list" || lower === "set") return recordType(nw[2], excluded);
    return nw[2] ? null : recordType(outer, excluded);
  }
  if (text.startsWith("[")) {
    const q = findInlineQueries(code.slice(at))[0];
    if (!q || q.index !== 0) return null;
    return recordType(soqlFieldRefs(q.inner).object, excluded);
  }
  const ref = text.match(
    new RegExp(`^(?:(this)\\s*\\.\\s*)?(${IDENT})(?:\\s*\\.\\s*(${IDENT})(\\s*\\(\\s*\\))?)?`),
  );
  if (!ref) return null;
  const name = ref[2] ?? "";
  const member = ref[3];
  const call = ref[4] !== undefined;
  const rest = text.slice(ref[0].length);
  // A further access or call (`x.records.get(0)`, `build()`) is not this record.
  if (/^\s*[.([]/.test(rest)) return null;
  if (name.toLowerCase() === "trigger" && !ref[1]) {
    if (!opts.triggerObject || call || !member) return null;
    return /^(new|old)$/i.test(member) ? opts.triggerObject : null;
  }
  if (!opts.lookup) return null;
  // `this.x` names a field; the lookup's fallback covers it (a local of the
  // same name declared earlier would shadow it, which is rare enough to accept).
  const decl = opts.lookup(name, at);
  if (!decl) return null;
  if (member === undefined) return recordType(decl.type ?? decl.elem, excluded);
  // `m.values()` on a Map<K, T>: the records are the values.
  if (call && member.toLowerCase() === "values" && !decl.type)
    return recordType(decl.elem, excluded);
  return null;
}

/** Offset of the `)` / top-level `,` ending the argument that starts at `from`. */
function argEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "," && depth === 0) return i;
  }
  return -1;
}

/** Top-level argument spans of the call whose `(` is at `open`; null when unbalanced. */
function argSpans(code: string, open: number): Array<{ start: number; end: number }> | null {
  const out: Array<{ start: number; end: number }> = [];
  let i = open + 1;
  for (;;) {
    const end = argEnd(code, i);
    if (end < 0) return null;
    out.push({ start: i, end });
    if (code[end] === ")") break;
    i = end + 1;
  }
  if (out.length === 1 && code.slice(out[0]?.start, out[0]?.end).trim() === "") return [];
  return out;
}

/** A plain string literal argument's text (`'X'`), `""` for `null`, else undefined. */
function literalArg(code: string, raw: string, span: { start: number; end: number }) {
  const masked = code.slice(span.start, span.end);
  const t = masked.trim();
  if (/^null$/i.test(t)) return "";
  if (!/^'[^']*'$/.test(t)) return undefined;
  const at = span.start + masked.indexOf("'");
  const text = raw.slice(at + 1, at + t.length - 1);
  return text.includes("\\") ? undefined : text;
}

// ---------------------------------------------------------------------------
// Instance and same-class calls

export interface InstanceCallOpts {
  lookup: TypeLookup;
  scope: ClassRefScope;
  /** The class the code belongs to (unset for triggers). */
  selfName?: string;
  /** Its `extends` class, for `super.m(…)`. */
  parentName?: string | null;
  /** Lower-cased method name → arities declared in this file (all methods of
   *  the file are qnamed under `selfName`, inner classes included). */
  declared?: ReadonlyMap<string, { name: string; arities: ReadonlySet<number> }>;
  /** Fields of the enclosing classes, for `this.f.m(…)`. */
  fields?: VarDecl[];
}

const RECEIVER_CALL_RE = new RegExp(
  `(?<![\\w.$])(?:(this)\\s*\\.\\s*)?(${IDENT})\\s*\\??\\.\\s*(${IDENT})\\s*\\(`,
  "g",
);
const NEW_CALL_RE = new RegExp(`(?<![\\w.$])new\\s+(${IDENT}(?:\\s*\\.\\s*${IDENT})?)\\s*\\(`, "g");
const BARE_CALL_RE = new RegExp(`(?<![\\w.$])(${IDENT})\\s*\\(`, "g");
/** Words a call may follow (`return helper();`); any other word makes `name(` a declaration. */
const CALL_AFTER_WORD = new Set(["return", "else", "throw", "do", "when", "in", "instanceof"]);

/**
 * CALLS edges for instance, same-class and super calls in `code` (masked).
 * One edge per (src, dst); a dst `edges` already holds for `srcQname` since
 * `fromIdx` (a static call) is skipped. Arity is counted like the static-call
 * rule (`(?)` + `unresolvedArity` when it can't be).
 */
export function emitInstanceCallEdges(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  opts: InstanceCallOpts,
  edges: EdgeFact[],
  fromIdx = 0,
): void {
  const seen = new Set<string>();
  for (let i = fromIdx; i < edges.length; i++) {
    const e = edges[i];
    if (e && e.relType === REL_TYPES.CALLS && String(e.srcQualifiedName) === srcQname)
      seen.add(String(e.dstQualifiedName).toLowerCase());
  }
  const self = opts.selfName;
  const declared = opts.declared ?? new Map();
  const emit = (cls: string, method: string, open: number, how: string, own: boolean) => {
    const arity = countCallArgs(code, open);
    let name = method;
    if (own) {
      // Same-file target: only a declared method, and only a declared arity.
      const d = declared.get(method.toLowerCase());
      if (!d || (arity != null && !d.arities.has(arity))) return;
      name = d.name;
    }
    const dst = `ApexMethod:${stripNs(cls, ctx.namespace)}.${name}(${arity ?? "?"})`;
    if (seen.has(dst.toLowerCase())) return;
    seen.add(dst.toLowerCase());
    edges.push(
      makeEdge(ctx, srcQname, REL_TYPES.CALLS, dst, {
        callResolution: how,
        ...(arity == null ? { unresolvedArity: true } : { arity }),
      }),
    );
  };
  /** Call target class for a receiver of declared type `t`: [class, own-file]. */
  const classOf = (t: string | null): [string, boolean] | null => {
    if (!t) return null;
    const segs = t.split(".");
    const head = segs[0] ?? "";
    if (self && head.toLowerCase() === self.toLowerCase()) return [self, true];
    if (segs.length > 1) return null; // another class's inner type, or a namespace
    if (self && opts.scope.localTypes.has(head.toLowerCase())) return [self, true];
    return isUserClassName(head, opts.scope) ? [head, false] : null;
  };

  for (const m of code.matchAll(RECEIVER_CALL_RE)) {
    const viaThis = m[1] !== undefined;
    const recv = m[2] ?? "";
    const method = m[3] ?? "";
    const open = (m.index ?? 0) + m[0].length - 1;
    const lower = recv.toLowerCase();
    if (!viaThis && lower === "this") {
      if (self) emit(self, method, open, "same-class", true);
      continue;
    }
    if (!viaThis && lower === "super") {
      const parent = opts.parentName;
      if (parent && /^[A-Za-z_]\w*$/.test(parent)) emit(parent, method, open, "super", false);
      continue;
    }
    const decl = viaThis
      ? makeTypeLookup([], opts.fields ?? [])(recv, m.index ?? 0)
      : opts.lookup(recv, m.index ?? 0);
    if (!decl) {
      // `Self.helper(…)`: the static-call rule skips the class itself.
      if (!viaThis && self && lower === self.toLowerCase() && !opts.scope.localVars.has(lower))
        emit(self, method, open, "same-class", true);
      continue;
    }
    const target = classOf(decl.type);
    if (target) emit(target[0], method, open, "receiver-type", target[1]);
  }

  for (const m of code.matchAll(NEW_CALL_RE)) {
    // The constructor's own `)` (masked code: string contents hold no parens).
    let end = (m.index ?? 0) + m[0].length - 1;
    for (let d = 0; end < code.length; end++) {
      if (code[end] === "(") d++;
      else if (code[end] === ")" && --d === 0) break;
    }
    if (end >= code.length) continue;
    const after = code.slice(end + 1).match(new RegExp(`^\\s*\\??\\.\\s*(${IDENT})\\s*\\(`));
    if (!after) continue;
    const target = classOf((m[1] ?? "").replace(/\s+/g, ""));
    if (target)
      emit(target[0], after[1] ?? "", end + 1 + after[0].length - 1, "receiver-type", target[1]);
  }

  if (self && declared.size > 0) {
    for (const m of code.matchAll(BARE_CALL_RE)) {
      const name = m[1] ?? "";
      if (!declared.has(name.toLowerCase())) continue;
      if (isDeclarationAt(code, m.index ?? 0)) continue;
      emit(self, name, (m.index ?? 0) + m[0].length - 1, "same-class", true);
    }
  }
}

/** True when the identifier at `at` follows a type (a method declaration), or `new`. */
function isDeclarationAt(code: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && /\s/.test(code[j] ?? "")) j--;
  const c = code[j] ?? "";
  if (c === "]") return true; // `String[] name(`
  if (c === ">") {
    // `List<String> name(` (a generic return type), not `a > name(`.
    let d = 0;
    let k = j;
    for (; k >= 0; k--) {
      const ch = code[k] ?? "";
      if (ch === ">") d++;
      else if (ch === "<" && --d === 0) break;
      else if (!/[\w\s.,[\]]/.test(ch)) return false;
    }
    return k > 0 && /\w/.test(code[k - 1] ?? "");
  }
  if (!/\w/.test(c)) return false;
  let s = j;
  while (s > 0 && /\w/.test(code[s - 1] ?? "")) s--;
  return !CALL_AFTER_WORD.has(code.slice(s, j + 1).toLowerCase());
}

// ---------------------------------------------------------------------------
// Labels, Type.forName, get/put, field tokens, EventBus.publish

export interface NameRefOpts {
  /** Types of variables in `code` (offsets in `code`). */
  lookup?: TypeLookup | undefined;
  scope: ClassRefScope;
  triggerObject?: string | undefined;
}

const LABEL_RE = new RegExp(`(?<![\\w.$])(?:(System)\\s*\\.\\s*)?Label\\s*\\.\\s*(${IDENT})`, "gi");
const FOR_NAME_RE = /(?<![\w.$])(?:System\s*\.\s*)?Type\s*\.\s*forName\s*\(/gi;
const GET_PUT_RE = new RegExp(`(?<![\\w.$])(${IDENT})\\s*\\??\\.\\s*(get|put)\\s*\\(`, "gi");
const DESCRIBE_FIELD_RE = new RegExp(
  `(?<![\\w.$])(?:Schema\\s*\\.\\s*)?SObjectType\\s*\\.\\s*(${IDENT})\\s*\\.\\s*fields\\s*\\.\\s*(${IDENT})`,
  "gi",
);
const TOKEN_RE = new RegExp(`(?<![\\w.$])(${IDENT})\\s*\\.\\s*(${IDENT})(?![\\w])`, "g");
const PUBLISH_RE = /(?<![\w.$])EventBus\s*\.\s*publish\s*\(/gi;
const OBJECT_SUFFIX_RE = /__(c|mdt|e|x|b|kav)$/i;
/** `Obj.<member>` names that are not fields. */
const NOT_FIELD_MEMBER = new Set(["sobjecttype", "fields", "class", "id"]);

/** `name` is an sObject type: custom-suffixed or a standard object, never an
 *  Apex platform type (`Location`, `Site`) or a type declared in the file. */
function isSObjectName(name: string, scope: ClassRefScope): boolean {
  const lower = name.toLowerCase();
  if (!OBJECT_SUFFIX_RE.test(name) && !isStandardSObject(lower)) return false;
  return !APEX_PLATFORM_NAMESPACES.has(lower) && !scope.localTypes.has(lower);
}

/** Emits the label, class-by-name, get/put, field-token and publish edges of `code`. */
export function emitNameRefEdges(
  ctx: ParseContext,
  srcQname: string,
  code: string,
  raw: string | null,
  opts: NameRefOpts,
  edges: EdgeFact[],
  fromIdx = 0,
): void {
  const seen = new Set<string>();
  for (let i = fromIdx; i < edges.length; i++) {
    const e = edges[i];
    if (e && String(e.srcQualifiedName) === srcQname)
      seen.add(`${e.relType}|${String(e.dstQualifiedName).toLowerCase()}`);
  }
  const push = (rel: EdgeFact["relType"], dst: string, attrs: Record<string, unknown>) => {
    const key = `${rel}|${dst.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(makeEdge(ctx, srcQname, rel, dst, attrs));
  };
  const ownNs = (ns: string) =>
    ctx.namespace != null && ns.toLowerCase() === ctx.namespace.toLowerCase();
  const isVar = (name: string) => opts.scope.localVars.has(name.toLowerCase());

  // Custom labels.
  for (const m of code.matchAll(LABEL_RE)) {
    if (!m[1] && isVar("Label")) continue;
    const first = m[2] ?? "";
    const after = code.slice((m.index ?? 0) + m[0].length);
    if (/^\s*\(/.test(after)) continue; // `Label.get(…)`: computed
    const second = after.match(new RegExp(`^\\s*\\.\\s*(${IDENT})(\\s*\\()?`));
    let label = first;
    // `Label.ns.Name` (namespaced); `Label.Name.method(…)` is a String call.
    if (second?.[1] && !second[2]) label = ownNs(first) ? second[1] : `${first}__${second[1]}`;
    push(REL_TYPES.REFERENCES_LABEL, `CustomLabel:${stripNs(label, ctx.namespace)}`, {
      via: "apex-label",
    });
  }

  if (raw !== null) {
    // Type.forName with literal names only.
    for (const m of code.matchAll(FOR_NAME_RE)) {
      const spans = argSpans(code, (m.index ?? 0) + m[0].length - 1);
      if (!spans || spans.length < 1 || spans.length > 2) continue;
      const lits = spans.map((s) => literalArg(code, raw, s));
      let ns = "";
      let name = "";
      if (lits.length === 2) {
        if (lits[0] === undefined || !lits[1]) continue;
        ns = lits[0].trim();
        name = lits[1].trim();
      } else {
        const one = lits[0]?.trim();
        if (!one) continue;
        const dot = one.indexOf(".");
        if (dot >= 0) {
          ns = one.slice(0, dot);
          name = one.slice(dot + 1);
        } else name = one;
      }
      // A foreign namespace (or `Outer.Inner` / `ns.Class`, which read the
      // same) is ambiguous: only the org's own namespace or none is local.
      if (ns && !ownNs(ns)) continue;
      if (!/^[A-Za-z_]\w*$/.test(name)) continue;
      if (opts.scope.selfName && name.toLowerCase() === opts.scope.selfName.toLowerCase()) continue;
      push(REL_TYPES.REFERENCES, `ApexClass:${stripNs(name, ctx.namespace)}`, {
        via: "type-forname",
      });
    }

    // rec.get('F') / rec.put('F', v) on an sObject-typed record.
    if (opts.lookup) {
      for (const m of code.matchAll(GET_PUT_RE)) {
        const spans = argSpans(code, (m.index ?? 0) + m[0].length - 1);
        const isPut = (m[2] ?? "").toLowerCase() === "put";
        if (!spans || spans.length !== (isPut ? 2 : 1) || !spans[0]) continue;
        const field = literalArg(code, raw, spans[0])?.trim();
        if (!field || !/^[A-Za-z_]\w*$/.test(field) || field.toLowerCase() === "id") continue;
        const decl = opts.lookup(m[1] ?? "", m.index ?? 0);
        const obj = decl?.type ?? null;
        // `get` / `put` exist on many types (Map, Cache, wrappers): the
        // declared type itself must be an sObject, a `__c` field name is not enough.
        if (!obj || !isSObjectName(obj, opts.scope)) continue;
        push(
          isPut ? REL_TYPES.WRITES_FIELD : REL_TYPES.READS_FIELD,
          `CustomField:${stripNs(obj, ctx.namespace)}.${field}`,
          { via: isPut ? "sobject-put" : "sobject-get" },
        );
      }
    }
  }

  // Field tokens (inline SOQL text is not Apex: relationship paths there are
  // the query's fields, emitted by the SOQL rule).
  const tokens = maskInlineQueries(code);
  const fieldRef = (obj: string, field: string) =>
    push(REL_TYPES.REFERENCES, `CustomField:${stripNs(obj, ctx.namespace)}.${field}`, {
      via: "field-token",
    });
  for (const m of tokens.matchAll(DESCRIBE_FIELD_RE)) {
    const after = tokens.slice((m.index ?? 0) + m[0].length);
    if (/^\s*\(/.test(after) || (m[2] ?? "").toLowerCase() === "id") continue;
    fieldRef(m[1] ?? "", m[2] ?? "");
  }
  for (const m of tokens.matchAll(TOKEN_RE)) {
    const obj = m[1] ?? "";
    const field = m[2] ?? "";
    if (NOT_FIELD_MEMBER.has(field.toLowerCase())) continue;
    if (!isSObjectName(obj, opts.scope) || isVar(obj)) continue;
    const after = tokens.slice((m.index ?? 0) + m[0].length);
    if (/^\s*\(/.test(after)) continue; // `Obj.method(…)`
    // Only `.getDescribe()` may follow a token; anything else is not one.
    if (/^\s*\./.test(after) && !/^\s*\.\s*getDescribe\s*\(/i.test(after)) continue;
    fieldRef(obj, field);
  }

  // EventBus.publish(x) with a platform-event-typed argument.
  for (const m of code.matchAll(PUBLISH_RE)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const spans = argSpans(code, open);
    const first = spans?.[0];
    if (!first) continue;
    let at = first.start;
    while (at < first.end && /\s/.test(code[at] ?? "")) at++;
    const t = recordTypeAt(code, at, {
      lookup: opts.lookup,
      triggerObject: opts.triggerObject,
      excludedTypes: opts.scope.localTypes,
    });
    if (!t || !/__e$/i.test(t)) continue;
    push(REL_TYPES.PUBLISHES_EVENT, `PlatformEvent:${stripNs(t, ctx.namespace)}`, {});
  }
}
