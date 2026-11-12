/**
 * Generic reference scanner: the floor for any metadata type that has no
 * dedicated parser or YAML rule (a new cloud's types, a type added in a newer
 * API version). `OpaqueNodeParser` calls it once per member; it walks the
 * body once, keeps only a short, deduped list of candidate references with
 * the element path each was found at, and the body is discarded. A post-merge
 * resolver (`generic-ref-resolver.ts`) then matches the candidates against the
 * real graph and emits edges only for those that match a node.
 *
 * Bounds (the scanner never grows with the body):
 *  - at most SCAN_MAX_CHARS of leaf text and SCAN_MAX_LEAVES leaves are read;
 *  - at most MAX_CANDIDATES candidates are kept (document order, deduped);
 *  - a body over MAX_BODY_CHARS is not parsed at all (flagged truncated).
 *
 * Candidate kinds (what the resolver tries to match):
 *  - `apex`   an Apex class name
 *  - `flow`   a Flow API name
 *  - `object` an SObject API name
 *  - `field`  `Object.Field`
 *  - `name`   a target-ish value that may be an Apex class, a Flow or an object
 */

export type GenericRefKind = "apex" | "flow" | "object" | "field" | "name";

export interface GenericRefCandidate {
  /** kind */
  k: GenericRefKind;
  /** name as written (`Foo__c`, `Account.Name`, `MyClass`) */
  n: string;
  /** element path it was found at (`a/b/c`, `a/b@attr` for an XML attribute) */
  p: string;
}

export interface GenericScanResult {
  candidates: GenericRefCandidate[];
  /** A bound (text, leaves, candidates or body size) stopped the scan early. */
  truncated: boolean;
}

export const SCAN_MAX_CHARS = 256 * 1024;
export const SCAN_MAX_LEAVES = 5000;
export const MAX_CANDIDATES = 200;
/** A body larger than this is not parsed (JSON.parse / tokenising it is not free). */
export const MAX_BODY_CHARS = 8 * 1024 * 1024;
const MAX_DEPTH = 40;
/** Longest piece of one leaf that is pattern-scanned. */
const MAX_LEAF_SCAN = 8192;
const MAX_PATH_CHARS = 120;

/** `ns__Name__suffix` / `Name__c` (a generic `__[a-z]{1,4}` suffix, not a fixed list). */
const CUSTOM_NAME_RE = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]*?__[a-z]{1,4}(?![A-Za-z0-9_])/g;
const IDENT = "[A-Za-z][A-Za-z0-9_]{0,79}";
/** A whole value that is `Name` or `Name.Name` (`.Name`). */
const IDENT_VALUE_RE = new RegExp(`^${IDENT}(?:\\.${IDENT}){0,2}$`);
/** `Obj.Field` inside free text; only kept when a side looks custom (see below). */
const DOTTED_RE = new RegExp(`(?<![A-Za-z0-9_.])(${IDENT})\\.(${IDENT})(?![A-Za-z0-9_(])`, "g");
const CUSTOM_SUFFIX_RE = /__[a-z]{1,4}$/;
const MERGE_FIELD_RE = /\{!\s*([^}]{1,200}?)\s*\}/g;
const MERGE_TOKEN_RE = /\$?[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;
const APEX_URI_RE = /^apex:\/\/([A-Za-z][A-Za-z0-9_]*)/;

const RESERVED = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "none",
  "string",
  "number",
  "boolean",
  "object",
  "id",
  "name",
  "type",
  "value",
  "default",
]);

type KeyKind = "apex" | "flow" | "object" | "field" | "name";

/** Element names that conventionally hold a reference target. Case-insensitive. */
export function keyKind(key: string): KeyKind | null {
  const k = key.toLowerCase();
  if (k.includes("apexclass") || k === "apexclassname" || k.endsWith("apexname")) return "apex";
  if (k.includes("flow")) return "flow";
  if (k.includes("actionname") || k.includes("invocationtarget")) return "name";
  if (k.includes("object") || k.includes("entity")) return "object";
  if (k.includes("field")) return "field";
  if (k.includes("target")) return "name";
  return null;
}

class Collector {
  readonly out: GenericRefCandidate[] = [];
  truncated = false;
  chars = 0;
  leaves = 0;
  private readonly seen = new Set<string>();
  /** Objects named under object-ish keys: the context of `{!$Record.Field}`. */
  readonly contextObjects: string[] = [];

  get done(): boolean {
    return this.truncated || this.out.length >= MAX_CANDIDATES;
  }

  add(k: GenericRefKind, n: string, path: string): void {
    if (this.out.length >= MAX_CANDIDATES) {
      this.truncated = true;
      return;
    }
    if (!n || n.length > 160 || RESERVED.has(n.toLowerCase())) return;
    const key = `${k}:${n.toLowerCase()}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const p = path.length > MAX_PATH_CHARS ? `…${path.slice(-(MAX_PATH_CHARS - 1))}` : path;
    this.out.push({ k, n, p });
  }

  /** Take one leaf: its value, the element it sits under, and its path. */
  leaf(value: string, key: string | null, path: string): void {
    if (this.leaves >= SCAN_MAX_LEAVES || this.chars >= SCAN_MAX_CHARS) {
      this.truncated = true;
      return;
    }
    this.leaves += 1;
    this.chars += value.length;
    const v = value.length > MAX_LEAF_SCAN ? value.slice(0, MAX_LEAF_SCAN) : value;
    const trimmed = v.trim();
    if (!trimmed) return;

    // Key heuristics: the whole value is the target.
    const kk = key ? keyKind(key) : null;
    if (kk && trimmed.length <= 160) {
      const apex = APEX_URI_RE.exec(trimmed);
      if (apex?.[1]) {
        this.add("apex", apex[1], path);
      } else if (IDENT_VALUE_RE.test(trimmed)) {
        this.keyed(kk, trimmed, path);
      }
    }

    // Value patterns, wherever the value sits.
    if (v.includes("{!")) this.mergeFields(v, path);
    if (v.includes("__")) {
      for (const m of v.matchAll(CUSTOM_NAME_RE)) this.add("object", m[0], path);
    }
    if (v.includes(".")) {
      if (IDENT_VALUE_RE.test(trimmed) && trimmed.includes(".") && !kk) {
        const [a, b] = trimmed.split(".");
        if (a && b) this.add("field", `${a}.${b}`, path);
      } else if (v.length <= 2000) {
        for (const m of v.matchAll(DOTTED_RE)) {
          const a = m[1] ?? "";
          const b = m[2] ?? "";
          if (CUSTOM_SUFFIX_RE.test(a) || CUSTOM_SUFFIX_RE.test(b))
            this.add("field", `${a}.${b}`, path);
        }
      }
    }
  }

  private keyed(kind: KeyKind, value: string, path: string): void {
    switch (kind) {
      case "apex": {
        this.add("apex", value.split(".")[0] ?? value, path);
        return;
      }
      case "flow":
        if (!value.includes(".")) this.add("flow", value, path);
        return;
      case "object":
        if (!value.includes(".")) {
          this.add("object", value, path);
          if (this.contextObjects.length < 3 && !this.contextObjects.includes(value)) {
            this.contextObjects.push(value);
          }
        }
        return;
      case "field":
        if (value.includes(".")) {
          const [a, b] = value.split(".");
          if (a && b) this.add("field", `${a}.${b}`, path);
        } else {
          // A bare field name: attach it to the objects named in this body.
          for (const o of this.contextObjects) this.add("field", `${o}.${value}`, path);
        }
        return;
      default:
        // `name`: an Apex class, a Flow or an object; the resolver decides.
        this.add("name", value.split(".")[0] ?? value, path);
    }
  }

  private mergeFields(v: string, path: string): void {
    for (const m of v.matchAll(MERGE_FIELD_RE)) {
      let inner = m[1] ?? "";
      // {!$Input:Account.Name} / {!$Record:Account.Name} -> Account.Name
      inner = inner.replace(/^\$[A-Za-z_]+:/, "");
      for (const t of inner.matchAll(MERGE_TOKEN_RE)) {
        const parts = t[0].split(".");
        const head = parts[0] ?? "";
        const field = parts[1] ?? "";
        if (!field) continue;
        if (head === "$Record" || head === "$Record__Prior" || head === "$Input") {
          for (const o of this.contextObjects) this.add("field", `${o}.${field}`, path);
        } else if (!head.startsWith("$")) {
          this.add("field", `${head}.${field}`, path);
        }
      }
    }
  }
}

function joinPath(parent: string, seg: string): string {
  return parent ? `${parent}/${seg}` : seg;
}

function walkJson(c: Collector, v: unknown, key: string | null, path: string, depth: number): void {
  if (c.done || depth > MAX_DEPTH || v == null) return;
  if (typeof v === "string") {
    c.leaf(v, key, path);
  } else if (typeof v === "number" || typeof v === "boolean") {
    return;
  } else if (Array.isArray(v)) {
    for (const x of v) {
      if (c.done) return;
      walkJson(c, x, key, path, depth + 1);
    }
  } else if (typeof v === "object") {
    // Object-ish keys first so `contextObjects` is filled before `$Record.X`
    // merge fields and bare field names in sibling elements are read.
    const entries = Object.entries(v as Record<string, unknown>);
    const pri = entries.filter(([k, x]) => typeof x === "string" && keyKind(k) === "object");
    const rest = entries.filter(([k, x]) => !(typeof x === "string" && keyKind(k) === "object"));
    for (const [k, x] of [...pri, ...rest]) {
      if (c.done) return;
      walkJson(c, x, k, joinPath(path, k), depth + 1);
    }
  }
}

const XML_TOKEN_RE =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>|([^<]+)/g;
const XML_ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Tokenise XML without building a tree: stops as soon as a bound is hit. */
function walkXml(c: Collector, xml: string): void {
  const stack: string[] = [];
  XML_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null = XML_TOKEN_RE.exec(xml);
  while (m !== null && !c.done) {
    const [, cdata, close, tag, attrs, selfClose, text] = m;
    if (cdata !== undefined) {
      const top = stack[stack.length - 1] ?? null;
      c.leaf(cdata, top, stack.join("/"));
    } else if (tag) {
      if (close) {
        // Pop to the matching open tag (tolerates unbalanced input).
        const i = stack.lastIndexOf(tag);
        if (i >= 0) stack.length = i;
      } else {
        if (stack.length < MAX_DEPTH) stack.push(tag);
        const path = stack.join("/");
        if (attrs) {
          for (const a of attrs.matchAll(XML_ATTR_RE)) {
            if (c.done) break;
            c.leaf(decodeXml(a[2] ?? a[3] ?? ""), a[1] ?? null, `${path}@${a[1]}`);
          }
        }
        if (selfClose) stack.pop();
      }
    } else if (text?.trim()) {
      const top = stack[stack.length - 1] ?? null;
      c.leaf(decodeXml(text), top, stack.join("/"));
    }
    m = XML_TOKEN_RE.exec(xml);
  }
  if (!c.done && m !== null) c.truncated = true;
}

/**
 * Scan one member body (XML or JSON text) for candidate references.
 * Never throws; a body that is neither parses as a single text leaf.
 */
export function scanGenericRefs(raw: string | null | undefined): GenericScanResult {
  const empty: GenericScanResult = { candidates: [], truncated: false };
  if (!raw) return empty;
  const c = new Collector();
  if (raw.length > MAX_BODY_CHARS) return { candidates: [], truncated: true };
  const head = raw.trimStart();
  try {
    if (head.startsWith("<")) {
      walkXml(c, head);
    } else if (head.startsWith("{") || head.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(head);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined) c.leaf(head, null, "");
      else walkJson(c, parsed, null, "", 0);
    } else {
      c.leaf(head, null, "");
    }
  } catch {
    // A scanner must never fail a parse; keep what was found.
    c.truncated = true;
  }
  return { candidates: c.out, truncated: c.truncated };
}
