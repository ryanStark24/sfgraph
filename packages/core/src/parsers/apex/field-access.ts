/**
 * Text-level extraction of SObject field reads/writes from Apex code that has
 * already had comments and string literals stripped (see
 * `stripCommentsAndStrings`), so commented-out code and string contents never
 * yield edges.
 *
 * Covered shapes (object resolved from the declared type, never guessed):
 *   - `v.F` / `v?.F` on a local, parameter, enhanced-for var or class field
 *   - `list[i].F`, `list.get(i).F`, `map.get(k).F` (element / value type)
 *   - `Trigger.new[i].F`, `Trigger.old[i].F`, `Trigger.newMap.get(k).F`,
 *     `Trigger.oldMap.get(k).F` (trigger object, trigger bodies only)
 *   - `new Obj(F = v, ...)` SObject constructors → write
 *   - `v.F = …` → write; `v.F += …`, `v.F++` → write + read; else read
 *
 * Receivers typed `SObject`, untyped, or of a type that is not plausibly an
 * SObject are skipped. A type counts as an SObject when it has a custom suffix
 * (`__c`, `__mdt`, …), is a known standard object, or the accessed field has a
 * `__c` suffix (Apex identifiers cannot contain `__`, so `x.F__c` can only be
 * an SObject field). `Id` is skipped everywhere (low signal).
 *
 * OFFSETS: every position here (`VarDecl.pos`, `at`, class-scope brace
 * indices) is an index into the `stripCommentsAndStrings` output that the
 * caller scans (or a slice of it plus the given offset), never into the raw
 * body: that function drops comments and shrinks strings, so raw-body offsets
 * do not line up.
 */
import { STANDARD_SOBJECT_WHITELIST } from "../../domain/index.js";

export interface VarDecl {
  name: string;
  /** Bare declared type when it is not a collection, else null. */
  type: string | null;
  /** Element type for List<T>/Set<T>/T[], value type for Map<K,V>. */
  elem: string | null;
  /** Offset of the declaration in the scanned code; -1 = always in scope. */
  pos: number;
}

export interface FieldAccess {
  object: string;
  field: string;
  read: boolean;
  write: boolean;
}

const STANDARD_LOWER = new Set([...STANDARD_SOBJECT_WHITELIST].map((s) => s.toLowerCase()));
const CUSTOM_SUFFIX_RE = /__(c|mdt|e|x|b|kav)$/i;
const NOT_SOBJECT = new Set([
  "sobject",
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
// Words that can precede an identifier like a type but are statements/modifiers.
const NOT_A_TYPE = new Set([
  "return",
  "new",
  "throw",
  "else",
  "if",
  "for",
  "while",
  "do",
  "when",
  "instanceof",
  "insert",
  "update",
  "delete",
  "upsert",
  "undelete",
  "merge",
  "final",
  "static",
  "public",
  "private",
  "protected",
  "global",
  "transient",
  "override",
  "virtual",
  "abstract",
  "class",
  "interface",
  "extends",
  "implements",
  "enum",
  "trigger",
  "on",
  "catch",
  "try",
  "finally",
  "switch",
  "break",
  "continue",
  "with",
  "without",
  "inherited",
  "sharing",
]);

const IDENT = "[A-Za-z_]\\w*";
const TYPE = `${IDENT}(?:\\.${IDENT})?(?:\\s*<[^;(){}=]*?>)?(?:\\s*\\[\\s*\\])?`;
const DECL_RE = new RegExp(`(?<![\\w.])(${TYPE})\\s+(${IDENT})\\s*(?=[=;,:){])`, "g");

function stripSchema(t: string): string {
  return t.replace(/^schema\./i, "");
}

/** Parse a declared type into its scalar type or collection element type. */
export function typeInfo(raw: string): { type: string | null; elem: string | null } {
  const t = raw.replace(/\s+/g, "");
  if (t.endsWith("[]")) return { type: null, elem: stripSchema(t.slice(0, -2)) };
  const lt = t.indexOf("<");
  if (lt < 0) return { type: stripSchema(t), elem: null };
  const outer = t.slice(0, lt).toLowerCase();
  const inner = t.slice(lt + 1, t.lastIndexOf(">"));
  // Split top-level generic args.
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur);
      cur = "";
    } else cur += ch;
  }
  args.push(cur);
  const last = args[args.length - 1] ?? "";
  const scalar = last.includes("<") ? null : stripSchema(last);
  if (outer === "list" || outer === "set" || outer === "map") return { type: null, elem: scalar };
  return { type: null, elem: null };
}

/** Variable declarations (locals, for-each vars, fields, catch vars) in `code`. */
export function collectDecls(code: string, offset = 0): VarDecl[] {
  const out: VarDecl[] = [];
  for (const m of code.matchAll(DECL_RE)) {
    const rawType = m[1] ?? "";
    const name = m[2] ?? "";
    const head = rawType.split(/[\s<.[]/)[0]?.toLowerCase() ?? "";
    if (NOT_A_TYPE.has(head) || NOT_A_TYPE.has(name.toLowerCase())) continue;
    out.push({ name, ...typeInfo(rawType), pos: (m.index ?? 0) + offset });
  }
  return out;
}

/** Declarations from a method's parameter strings (`"List<Foo__c> xs"`). */
export function paramDecls(params: string[]): VarDecl[] {
  // Callers may hand in a naive comma split (`Map<Id`, ` Foo__c> m`); rejoin
  // and split on top-level commas only.
  const joined = params.join(",");
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of joined) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const out: VarDecl[] = [];
  for (const p of parts) {
    const m = p
      .trim()
      .replace(/^final\s+/i, "")
      .match(new RegExp(`^(${TYPE})\\s+(${IDENT})$`));
    if (m?.[1] && m[2]) out.push({ name: m[2], ...typeInfo(m[1]), pos: -1 });
  }
  return out;
}

function isSObjectType(type: string | null, field: string, excluded: Set<string>): boolean {
  if (!type) return false;
  const lower = type.toLowerCase();
  if (NOT_SOBJECT.has(lower) || excluded.has(lower)) return false;
  if (!/^[A-Za-z]/.test(type)) return false;
  if (CUSTOM_SUFFIX_RE.test(type)) return true;
  if (STANDARD_LOWER.has(lower)) return true;
  return /__c$/i.test(field);
}

/** Index just past the bracket matching `code[open]`, or -1. */
function skipBalanced(code: string, open: number): number {
  const o = code[open];
  const c = o === "(" ? ")" : o === "[" ? "]" : "";
  if (!c) return -1;
  let d = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) d++;
    else if (code[i] === c && --d === 0) return i + 1;
  }
  return -1;
}

function skipWs(code: string, i: number): number {
  let j = i;
  while (j < code.length && /\s/.test(code[j] ?? "")) j++;
  return j;
}

/** After `v`, consume `[...]` or `.get(...)`; returns new index or -1. */
function consumeIndexOrGet(code: string, i: number): number {
  const j = skipWs(code, i);
  if (code[j] === "[") return skipBalanced(code, j);
  const g = code.slice(j).match(/^\??\.\s*get\s*\(/i);
  if (g) return skipBalanced(code, j + g[0].length - 1);
  return -1;
}

const HEAD_RE = new RegExp(`(?<![\\w.$])(${IDENT})(?=\\s*(?:\\?\\.|\\.|\\[))`, "g");
const NEW_RE = new RegExp(`\\bnew\\s+(${IDENT}(?:\\.${IDENT})?)\\s*\\(`, "g");

export interface ExtractOpts {
  /** Declarations visible in this code: params/class fields (pos -1) plus locals. */
  decls: VarDecl[];
  /** Enclosing class's own fields/properties, consulted when no local/param matches. */
  outer?: VarDecl[];
  /** SObject of the enclosing trigger: enables `Trigger.new/old/newMap/oldMap`. */
  triggerObject?: string;
  /** Lower-cased type names known NOT to be SObjects (inner classes, etc.). */
  excludedTypes?: Set<string>;
  /**
   * When given, relationship chains on a typed SObject receiver
   * (`acr.Account.Name`, `w.Maker__r.Region__c = x`) are appended here as
   * `{object, path}` for the post-merge resolver; the relationship name is
   * never reported as a field of the receiver.
   */
  paths?: RelationshipPathAccess[];
}

/** A relationship chain read or written from a record of `object`. */
export interface RelationshipPathAccess {
  object: string;
  path: string;
  rel: "READS_FIELD" | "WRITES_FIELD";
}

/** The declaration of `name` in scope at `at`: the nearest earlier local or a
 *  parameter, else an unambiguous `outer` field. */
export function resolveDecl(name: string, at: number, opts: ExtractOpts): VarDecl | undefined {
  const lower = name.toLowerCase();
  let best: VarDecl | undefined;
  for (const d of opts.decls) {
    if (d.name.toLowerCase() !== lower) continue;
    if (d.pos <= at && (!best || d.pos > best.pos)) best = d;
  }
  if (best) return best;
  // Outer scope (class fields): only when unambiguous. Conflicting types for
  // the same name → skip rather than guess.
  const outer = (opts.outer ?? []).filter((d) => d.name.toLowerCase() === lower);
  const first = outer[0];
  if (!first) return undefined;
  const same = (a: string | null, b: string | null) =>
    (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  return outer.every((d) => same(d.type, first.type) && same(d.elem, first.elem))
    ? first
    : undefined;
}

/**
 * Class-body scoping over `code` (stripped source). `classAt(pos)` is the
 * open-brace index of the innermost class/interface/enum body whose DIRECT
 * level contains `pos` (-1 when `pos` sits inside a method, constructor,
 * initializer or accessor block, or outside any class). `fields(classId)` are
 * the declarations directly in that class body (fields and properties), so
 * constructor / initializer locals and other classes' fields never leak in.
 */
export function classScopes(code: string): {
  classAt: (pos: number) => number;
  fields: (classId: number) => VarDecl[];
} {
  const classOpens = new Set<number>();
  for (const m of code.matchAll(/\b(?:class|interface|enum)\s+[A-Za-z_]\w*[^;{}]*\{/gi)) {
    classOpens.add((m.index ?? 0) + m[0].length - 1);
  }
  const top = new Int32Array(code.length + 1).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < code.length; i++) {
    top[i] = stack.length ? (stack[stack.length - 1] ?? -1) : -1;
    if (code[i] === "{") stack.push(i);
    else if (code[i] === "}") stack.pop();
  }
  top[code.length] = -1;
  const classAt = (pos: number): number => {
    const t = pos >= 0 && pos <= code.length ? (top[pos] ?? -1) : -1;
    return classOpens.has(t) ? t : -1;
  };
  const byClass = new Map<number, VarDecl[]>();
  for (const d of collectDecls(code)) {
    const c = classAt(d.pos);
    if (c < 0) continue;
    const list = byClass.get(c) ?? [];
    list.push(d);
    byClass.set(c, list);
  }
  return { classAt, fields: (classId) => byClass.get(classId) ?? [] };
}

function pushPath(
  into: RelationshipPathAccess[],
  object: string,
  path: string,
  rel: RelationshipPathAccess["rel"],
): void {
  const k = `${object}|${path}|${rel}`.toLowerCase();
  if (into.some((p) => `${p.object}|${p.path}|${p.rel}`.toLowerCase() === k)) return;
  into.push({ object, path, rel });
}

/** Field accesses in `code`; one entry per (object, field) with merged read/write flags. */
export function extractFieldAccesses(code: string, opts: ExtractOpts): FieldAccess[] {
  const excluded = opts.excludedTypes ?? new Set<string>();
  const acc = new Map<string, FieldAccess>();
  const add = (object: string, field: string, read: boolean, write: boolean) => {
    const key = `${object.toLowerCase()}.${field.toLowerCase()}`;
    const cur = acc.get(key);
    if (cur) {
      cur.read ||= read;
      cur.write ||= write;
    } else acc.set(key, { object, field, read, write });
  };

  for (const m of code.matchAll(HEAD_RE)) {
    const name = m[1] ?? "";
    const start = m.index ?? 0;
    let i = start + name.length;
    let object: string | null = null;
    if (name.toLowerCase() === "trigger") {
      if (!opts.triggerObject) continue;
      const t = code.slice(i).match(/^\s*\.\s*(new|old|newmap|oldmap)\b/i);
      if (!t?.[1]) continue;
      i += t[0].length;
      const next = consumeIndexOrGet(code, i);
      if (next < 0) continue;
      const kind = t[1].toLowerCase();
      // `Trigger.new[i]` / `Trigger.newMap.get(k)` — not `Trigger.new.get(...)`.
      if (kind.endsWith("map") !== (code[skipWs(code, i)] !== "[")) continue;
      i = next;
      object = opts.triggerObject;
    } else {
      const decl = resolveDecl(name, start, opts);
      if (!decl) continue;
      const next = consumeIndexOrGet(code, i);
      if (next >= 0) {
        object = decl.elem;
        i = next;
      } else object = decl.type;
    }
    if (!object) continue;
    const f = code.slice(i).match(new RegExp(`^\\s*\\??\\.\\s*(${IDENT})`));
    if (!f?.[1]) continue;
    const field = f[1];
    if (field.toLowerCase() === "id") continue;
    const after = skipWs(code, i + f[0].length);
    const c0 = code[after];
    const c1 = code[after + 1];
    if (c0 === "(") continue; // method call
    const isRel = /__r$/i.test(field) || (c0 === "." && !/__c$/i.test(field));
    if (isRel) {
      // Relationship traversal (`x.Maker__r.Name`, `x.Owner.Email`): the
      // relationship name is not a field of the receiver; record the chain.
      if (!opts.paths || c0 !== "." || !isSObjectType(object, "", excluded)) continue;
      const segs = [field];
      let j = after;
      while (code[j] === ".") {
        const s = code.slice(j).match(new RegExp(`^\\.\\s*(${IDENT})`));
        if (!s?.[1]) break;
        segs.push(s[1]);
        j = skipWs(code, j + s[0].length);
      }
      if (segs.length < 2 || code[j] === "(" || code[j] === "." || code[j] === "?") continue;
      if ((segs[segs.length - 1] ?? "").toLowerCase() === "id") continue;
      const p0 = code[j];
      const p1 = code[j + 1];
      const assign = p0 === "=" && p1 !== "=";
      const cmp =
        (p0 !== undefined && "+-*/".includes(p0) && p1 === "=") ||
        (p0 === "+" && p1 === "+") ||
        (p0 === "-" && p1 === "-");
      const path = segs.join(".");
      if (!assign) pushPath(opts.paths, object, path, "READS_FIELD");
      if (assign || cmp) pushPath(opts.paths, object, path, "WRITES_FIELD");
      continue;
    }
    if (!isSObjectType(object, field, excluded)) continue;
    const plainAssign = c0 === "=" && c1 !== "=";
    const compound =
      (c0 !== undefined && "+-*/".includes(c0) && c1 === "=") ||
      (c0 === "+" && c1 === "+") ||
      (c0 === "-" && c1 === "-");
    add(object, field, !plainAssign, plainAssign || compound);
  }

  for (const m of code.matchAll(NEW_RE)) {
    const type = stripSchema(m[1] ?? "");
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = skipBalanced(code, open);
    if (close < 0) continue;
    const inner = code.slice(open + 1, close - 1);
    if (!inner.trim()) continue;
    const args: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of inner) {
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth--;
      if (ch === "," && depth === 0) {
        args.push(cur);
        cur = "";
      } else cur += ch;
    }
    args.push(cur);
    const names: string[] = [];
    for (const a of args) {
      const nm = a.match(new RegExp(`^\\s*(${IDENT})\\s*=(?!=)`));
      if (!nm?.[1]) break;
      names.push(nm[1]);
    }
    if (names.length !== args.length) continue;
    for (const field of names) {
      if (field.toLowerCase() === "id") continue;
      if (isSObjectType(type, field, excluded)) add(type, field, false, true);
    }
  }
  return [...acc.values()];
}
