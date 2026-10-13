import { createHash } from "node:crypto";
import {
  type EdgeFact,
  METADATA_CATEGORY,
  type NodeFact,
  REL_TYPES,
  type RelType,
} from "../../domain/index.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext, ParseResult, Parser } from "../contract.js";
import { AURA_NODE_HASH_SALT } from "../hash-salts.js";
export { AURA_NODE_HASH_SALT } from "../hash-salts.js";

/**
 * corecorr-08: Aura bundles (filesystem source format), parsed so Apex
 * controllers, embedded components and labels used only from Aura are not
 * reported as unreferenced.
 *
 * Emitted from `AuraComponent:<bundle>`:
 *  - CONTROLLED_BY -> `ApexClass:<cls>` for the root tag's `controller="[c.]Cls"`
 *    (own namespace stripped; a foreign one kept as `ApexClass:ns.Cls`, as VF does);
 *  - EMBEDS_AURA -> `AuraComponent:<name>` / EMBEDS_LWC -> `LWC:<name>` for
 *    `<c:name>` (or the org's own namespace) tags. One bundle can't tell the
 *    kind, so the first letter is a provisional guess (LWC names start
 *    lowercase); `resolveAuraEmbeds` re-targets it after the merge against
 *    the bundles that exist (review I4);
 *  - REFERENCES_LABEL -> `CustomLabel:<name>` for `$Label.<ns>.<name>` in
 *    markup and in the controller/helper/renderer JS.
 * Not covered: server-action calls (`c.method` in JS), events, `extends`.
 */
export interface AuraBundleInput {
  bundleName: string;
  files: Record<string, string>;
}

const MARKUP_EXT = /\.(cmp|app|intf|evt)$/i;
// Attribute values may contain `>`, so the root tag body skips quoted runs.
const ROOT_TAG_RE =
  /<aura:(component|application|interface|event)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i;
// Not preceded by a name character or `-` (so `data-controller` is not it).
const CONTROLLER_ATTR_RE = /(?<![\w-])controller\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const TAG_RE = /<([A-Za-z][\w]*):([A-Za-z][\w]*)\b/g;
const LABEL_RE = /\$Label\.([A-Za-z]\w*)\.([A-Za-z]\w*)/g;

function bundleContentHash(files: Record<string, string>): string {
  const h = createHash("sha256");
  h.update(AURA_NODE_HASH_SALT);
  h.update("\0");
  for (const k of Object.keys(files).sort()) {
    h.update(k);
    h.update("\0");
    h.update(files[k] ?? "");
    h.update("\0");
  }
  return h.digest("hex");
}

function stripMarkupComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

/** After one of these (or at the start / after a keyword), `/` opens a regex. */
const REGEX_PREFIX = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/** End index (exclusive) of the regex literal starting at `s[i] === "/"`. */
function regexEnd(s: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < s.length && s[j] !== "\n") {
    const c = s[j];
    if (c === "\\") j += 2;
    else {
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        j += 1;
        while (j < s.length && /[A-Za-z]/.test(s[j] as string)) j += 1;
        return j;
      }
      j += 1;
    }
  }
  return j; // unterminated: treat the rest of the line as the literal
}

/**
 * Drop `/* *\/` and `//` comments (including trailing ones) from JS, keeping
 * string, template and regex literals intact so `"http://x"`, `/https?:\/\//`
 * or `/'/g` don't open a false comment or string (review minor 9, R1-5).
 * A `/` is a regex when the previous significant token is an operator,
 * punctuator or keyword (the usual tokenizer heuristic); otherwise division.
 */
function stripJsComments(s: string): string {
  let out = "";
  let i = 0;
  let prev = ""; // last significant char emitted
  let word = ""; // identifier ending at `prev`, for keyword checks
  let gap = false; // whitespace since `prev`
  while (i < s.length) {
    const ch = s[i] as string;
    const next = s[i + 1];
    if (ch === "/" && next === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      out += " ";
    } else if (ch === "/" && next === "/") {
      const end = s.indexOf("\n", i + 2);
      i = end < 0 ? s.length : end;
    } else if (ch === "/" && (prev === "" || REGEX_PREFIX.has(prev) || REGEX_KEYWORDS.has(word))) {
      const end = regexEnd(s, i);
      out += s.slice(i, end);
      i = end;
      prev = "/";
      word = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== ch && (ch === "`" || s[j] !== "\n")) {
        j += s[j] === "\\" ? 2 : 1;
      }
      out += s.slice(i, j + 1);
      i = j + 1;
      prev = ch;
      word = "";
    } else {
      out += ch;
      i += 1;
      if (/\s/.test(ch)) {
        gap = true;
        continue;
      }
      if (/[\w$]/.test(ch)) word = !gap && /[\w$]/.test(prev) ? word + ch : ch;
      else word = "";
      prev = ch;
      gap = false;
    }
  }
  return out;
}

export class AuraBundleParser implements Parser<AuraBundleInput> {
  readonly category = METADATA_CATEGORY.AURA;
  readonly type = "AuraDefinitionBundle";

  async parse(input: AuraBundleInput, ctx: ParseContext): Promise<ParseResult> {
    const bundleName = stripNs(input.bundleName, ctx.namespace);
    const qname = `AuraComponent:${bundleName}`;
    const ownNs = (ns: string) =>
      ns === "c" || (ctx.namespace != null && ns.toLowerCase() === ctx.namespace.toLowerCase());
    const edges: EdgeFact[] = [];
    const seen = new Set<string>();
    const add = (rel: RelType, dst: string, attrs?: Record<string, unknown>) => {
      const key = `${rel}|${dst}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push(makeEdge(ctx, qname, rel, dst, attrs));
    };
    const labelRefs = (text: string) => {
      LABEL_RE.lastIndex = 0;
      for (let m = LABEL_RE.exec(text); m !== null; m = LABEL_RE.exec(text)) {
        const [, ns = "", name = ""] = m;
        const label = ownNs(ns) ? name : `${ns}__${name}`;
        add(REL_TYPES.REFERENCES_LABEL, `CustomLabel:${stripNs(label, ctx.namespace)}`);
      }
    };

    let bundleKind: string | undefined;
    for (const fname of Object.keys(input.files).sort()) {
      const raw = input.files[fname] ?? "";
      if (MARKUP_EXT.test(fname)) {
        const src = stripMarkupComments(raw);
        const root = ROOT_TAG_RE.exec(src);
        if (root) {
          bundleKind ??= root[1]?.toLowerCase();
          const cm = CONTROLLER_ATTR_RE.exec(root[2] ?? "");
          const ctrl = (cm?.[1] ?? cm?.[2])?.trim();
          if (ctrl) {
            // `c.Cls` and the org's own `ns.Cls` are local classes; a foreign
            // `ns.Cls` keeps its prefix, the form the VF CONTROLLED_BY rule
            // (rules/apex-page.yml) emits, so it never lands on a local class.
            const dot = ctrl.indexOf(".");
            const local = dot < 0 || ownNs(ctrl.slice(0, dot));
            const cls = dot < 0 ? ctrl : local ? ctrl.slice(dot + 1) : ctrl;
            if (cls) {
              add(
                REL_TYPES.CONTROLLED_BY,
                `ApexClass:${local ? stripNs(cls, ctx.namespace) : cls}`,
              );
            }
          }
        }
        TAG_RE.lastIndex = 0;
        for (let m = TAG_RE.exec(src); m !== null; m = TAG_RE.exec(src)) {
          const [tag, ns = "", name = ""] = m;
          if (!ownNs(ns) || name === bundleName) continue;
          const first = name.charAt(0);
          if (first >= "a" && first <= "z") {
            add(REL_TYPES.EMBEDS_LWC, `LWC:${name}`, { tag: tag.slice(1) });
          } else {
            add(REL_TYPES.EMBEDS_AURA, `AuraComponent:${name}`, { tag: tag.slice(1) });
          }
        }
        labelRefs(src);
      } else if (fname.endsWith(".js")) {
        labelRefs(stripJsComments(raw));
      }
    }

    const nodes: NodeFact[] = [
      makeNode(
        ctx,
        "AuraComponent",
        qname,
        {
          name: bundleName,
          ...(bundleKind ? { bundleKind } : {}),
          files: Object.keys(input.files).sort(),
        },
        bundleContentHash(input.files),
      ),
    ];
    return { nodes, edges };
  }
}
