import { createHash } from "node:crypto";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function asJson(input: unknown): any {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input ?? {};
}

/**
 * Like asJson but also accepts Metadata-API XML payloads (the OmniStudio
 * retrieve path yields raw XML strings; the SOQL path yields JSON). For XML
 * the single root element is unwrapped so callers see the same top-level
 * shape regardless of source.
 */
export function asStructured(input: unknown): any {
  if (typeof input === "string") {
    const s = input.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return JSON.parse(s);
      } catch {
        return {};
      }
    }
    if (s.startsWith("<")) {
      try {
        const doc = xmlParser.parse(s);
        const roots = Object.keys(doc).filter((k) => k !== "?xml");
        if (roots.length === 1) return doc[roots[0] as string] ?? {};
        return doc;
      } catch {
        return {};
      }
    }
    return {};
  }
  return input ?? {};
}

const NON_SOBJECT_SIDES = new Set(["", "json", "xml", "custom", "none", "null"]);
const SOBJECT_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|mdt|e|b|x))?$/;

/** True when a DataRaptor / DataTransform mapping side names a real
 *  Salesforce SObject rather than the JSON/XML/custom payload side. */
export function isSObjectName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const n = name.trim();
  return !NON_SOBJECT_SIDES.has(n.toLowerCase()) && SOBJECT_NAME_RE.test(n);
}

/** True when a mapping-side field name is a plain field API name (JSON-path
 *  sides use colon-separated paths like `Details:AccountNumber`). */
export function isPlainFieldName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const n = name.trim();
  return n.length > 0 && SOBJECT_NAME_RE.test(n);
}

/** Case-tolerant property lookup: SOQL rows use UpperCamel field names
 *  (`InputFieldName`), Metadata-API XML uses lowerCamel (`inputFieldName`). */
export function pickProp(obj: any, name: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  if (name in obj) return obj[name];
  const lower = name.charAt(0).toLowerCase() + name.slice(1);
  return obj[lower];
}

/**
 * Walk an arbitrary object tree and invoke `visit` on every value (objects/arrays/scalars).
 */
export function walk(
  obj: any,
  visit: (v: any, key: string | number | null, parent: any) => void,
): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      visit(v, i, obj);
      if (v && typeof v === "object") walk(v, visit);
    }
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      visit(v, k, obj);
      if (v && typeof v === "object") walk(v, visit);
    }
  }
}

export interface FieldRef {
  object: string;
  field: string;
}

const FIELD_PATH_RE = /\b([A-Z][A-Za-z0-9_]*(?:__r)?)\.([A-Z][A-Za-z0-9_]*(?:__c)?)\b/g;

export function extractFieldRefs(text: string): FieldRef[] {
  const out: FieldRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(FIELD_PATH_RE.source, "g");
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const o = (m[1] ?? "").replace(/__r$/, "");
    const f = m[2] ?? "";
    const k = `${o}.${f}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ object: o, field: f });
    }
    m = re.exec(text);
  }
  return out;
}

export interface BuildArgs {
  ctx: ParseContext;
  label: string;
  prefix: string; // "DR" | "IP" | "OS" | "VC" | "Omni..."
  name: string;
  raw: any;
  hash: string;
}

export function buildBaseNode(args: BuildArgs): NodeFact {
  return makeNode(
    args.ctx,
    args.label,
    `${args.label}:${stripNs(args.name, args.ctx.namespace)}`,
    {
      name: stripNs(args.name, args.ctx.namespace),
      flavor: args.prefix,
    },
    args.hash,
  );
}

export { REL_TYPES };
