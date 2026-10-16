import { stripNs } from "../common.js";

/**
 * References read from Visualforce markup (a `.page` / `.component` body).
 * The rules in `../rules/apex-page.yml` and `apex-component.yml` turn each
 * kind into edges through the `vfRefs(text, kind)` selector.
 *
 *  - `reads` / `writes`: `CustomField:<Obj>.<Field>` for `{!Obj.Field}` when
 *    `Obj` is the page's `standardController` (the only record whose type the
 *    markup alone tells), and `{!$ObjectType.Obj.fields.Field…}` (a describe,
 *    `via: "$ObjectType"`). The `value` of an `<apex:input…>` /
 *    `<apex:select…>` tag is a write; everything else is a read. A custom
 *    relationship hop (`Obj.Rel__r.Name`) reads the lookup `Obj.Rel__c`;
 *    standard relationship hops and controller properties are not resolved.
 *  - `objects`: `CustomObject:<Obj>` for the standard controller and every
 *    `$ObjectType.Obj`.
 *  - `labels`: `CustomLabel:<name>` for `$Label.name` (own namespace stripped).
 *  - `components`: `ApexComponent:<name>` for `<c:name>` (or the org's own
 *    namespace prefix).
 *  - `pages`: `ApexPage:<name>` for `<apex:include pageName>`,
 *    `<apex:composition template>` and `$Page.name`.
 * Markup comments are skipped; text inside `{!…}` string literals is not a
 * reference.
 */
export interface VfRef {
  dst: string;
  via: string;
}

export interface VfRefs {
  reads: VfRef[];
  writes: VfRef[];
  objects: VfRef[];
  labels: VfRef[];
  components: VfRef[];
  pages: VfRef[];
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;
// Attribute values may contain `>`, so a tag body skips quoted runs.
const TAG_RE = /<([A-Za-z][\w]*):([A-Za-z][\w]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /(?<![\w-])([A-Za-z][\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PATH_RE = /(?<![\w.$])(\$?[A-Za-z_]\w*)((?:\s*\.\s*[A-Za-z_]\w*)+)/g;
const WRITE_TAG_RE = /^(input\w*|select(List|Radio|Checkboxes))$/i;

function stripComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** `{!…}` expressions as [start, end) offsets of their inner text. Quoted
 *  strings inside an expression may hold `}`. */
function mergeExpressions(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = s.indexOf("{!");
  while (i >= 0) {
    let j = i + 2;
    let quote: string | null = null;
    for (; j < s.length; j++) {
      const c = s[j];
      if (quote) {
        if (c === "\\") j++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "}") break;
    }
    if (j >= s.length) break;
    out.push([i + 2, j]);
    i = s.indexOf("{!", j + 1);
  }
  return out;
}

/** Blank out quoted literals so `'Account.Name'` is not a merge path. */
function blankStrings(expr: string): string {
  return expr.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (m) => " ".repeat(m.length));
}

function standardControllerOf(s: string): string | null {
  const m = /<apex:page\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i.exec(s);
  if (!m) return null;
  const a = /(?<![\w-])standardController\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1] ?? "");
  const v = (a?.[1] ?? a?.[2] ?? "").trim();
  return IDENT.test(v) ? v : null;
}

export function extractVfRefs(markup: string, ns: string | null): VfRefs {
  const out: VfRefs = {
    reads: [],
    writes: [],
    objects: [],
    labels: [],
    components: [],
    pages: [],
  };
  const seen = new Set<string>();
  const add = (kind: keyof VfRefs, dst: string, via: string) => {
    const key = `${kind}|${dst.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out[kind].push({ dst, via });
  };
  const local = (name: string) => stripNs(name, ns);
  const ownNs = (prefix: string) =>
    prefix === "c" || (ns != null && prefix.toLowerCase() === ns.toLowerCase());

  const src = stripComments(markup);
  const stdObj = standardControllerOf(src);
  if (stdObj) add("objects", `CustomObject:${local(stdObj)}`, "standardController");

  // Offsets of the `value` attribute text of input/select tags: merge fields
  // there are writes.
  const writeRanges: Array<[number, number]> = [];
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(src); m !== null; m = TAG_RE.exec(src)) {
    const [, prefix = "", name = "", attrs = ""] = m;
    const attrsStart = m.index + 1 + prefix.length + 1 + name.length;
    if (ownNs(prefix)) add("components", `ApexComponent:${local(name)}`, `${prefix}:${name}`);
    if (prefix.toLowerCase() !== "apex") continue;
    const tag = name.toLowerCase();
    ATTR_RE.lastIndex = 0;
    for (let a = ATTR_RE.exec(attrs); a !== null; a = ATTR_RE.exec(attrs)) {
      const attr = (a[1] ?? "").toLowerCase();
      const value = (a[2] ?? a[3] ?? "").trim();
      if (
        (tag === "include" && attr === "pagename") ||
        (tag === "composition" && attr === "template")
      ) {
        if (IDENT.test(value)) add("pages", `ApexPage:${local(value)}`, `apex:${tag}`);
      }
      if (attr === "value" && WRITE_TAG_RE.test(name)) {
        const start = attrsStart + a.index;
        writeRanges.push([start, start + a[0].length]);
      }
    }
  }

  for (const [start, end] of mergeExpressions(src)) {
    const write = writeRanges.some(([s, e]) => start >= s && end <= e);
    const expr = blankStrings(src.slice(start, end));
    PATH_RE.lastIndex = 0;
    for (let m = PATH_RE.exec(expr); m !== null; m = PATH_RE.exec(expr)) {
      const root = m[1] ?? "";
      const segs = (m[2] ?? "")
        .split(".")
        .map((x) => x.trim())
        .filter(Boolean);
      const rootLower = root.toLowerCase();
      const first = segs[0] ?? "";
      if (rootLower === "$label") {
        add("labels", `CustomLabel:${local(first)}`, "$Label");
      } else if (rootLower === "$page") {
        add("pages", `ApexPage:${local(first)}`, "$Page");
      } else if (rootLower === "$objecttype") {
        const obj = local(first);
        add("objects", `CustomObject:${obj}`, "$ObjectType");
        if ((segs[1] ?? "").toLowerCase() === "fields" && segs[2]) {
          add("reads", `CustomField:${obj}.${local(segs[2])}`, "$ObjectType");
        }
      } else if (stdObj && rootLower === stdObj.toLowerCase()) {
        const obj = local(stdObj);
        if (segs.length === 1) {
          add(write ? "writes" : "reads", `CustomField:${obj}.${local(first)}`, "merge-field");
        } else if (/__r$/i.test(first)) {
          add("reads", `CustomField:${obj}.${local(first.slice(0, -3))}__c`, "merge-field");
        }
      }
    }
  }
  return out;
}

let lastText: string | null = null;
let lastNs: string | null = null;
let lastRefs: VfRefs | null = null;

/** `extractVfRefs(markup, ns)[kind]`, memoised on the last markup (one rule
 *  file asks for several kinds of the same page in a row). */
export function vfRefs(markup: string, kind: string, ns: string | null): VfRef[] {
  if (lastRefs === null || lastText !== markup || lastNs !== ns) {
    lastRefs = extractVfRefs(markup, ns);
    lastText = markup;
    lastNs = ns;
  }
  return (lastRefs as unknown as Record<string, VfRef[] | undefined>)[kind] ?? [];
}
