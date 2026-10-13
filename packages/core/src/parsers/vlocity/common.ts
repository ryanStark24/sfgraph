import { createHash } from "node:crypto";
import type { EdgeFact, NodeFact, RelType } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { xmlParser } from "../_xml-helpers.js";
import { makeEdge, makeNode, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";
import { VLOCITY_ELEMENT_HASH_SALT } from "../hash-salts.js";
export { VLOCITY_ELEMENT_HASH_SALT } from "../hash-salts.js";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Malformed payloads still yield `{}` (so the component keeps a node and
 * inbound edges resolve), but that `{}` carries the parse error under this
 * non-enumerable key; parsers surface it through `payloadParseErrors`.
 */
const PAYLOAD_PARSE_ERROR: unique symbol = Symbol("payloadParseError");

function malformed(kind: string, err: unknown): any {
  const out = {};
  Object.defineProperty(out, PAYLOAD_PARSE_ERROR, {
    value: `malformed ${kind} payload: ${err instanceof Error ? err.message : String(err)}`,
    enumerable: false,
  });
  return out;
}

export function asJson(input: unknown): any {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch (err) {
      return malformed("JSON", err);
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
      } catch (err) {
        return malformed("JSON", err);
      }
    }
    if (s.startsWith("<")) {
      try {
        const doc = xmlParser.parse(s);
        const roots = Object.keys(doc).filter((k) => k !== "?xml");
        if (roots.length === 1) return doc[roots[0] as string] ?? {};
        return doc;
      } catch (err) {
        return malformed("XML", err);
      }
    }
    return s === "" ? {} : malformed("DataPack", new Error("neither JSON nor XML"));
  }
  return input ?? {};
}

/**
 * `[ParseError node]` when `parsed` came from a malformed payload (see
 * asJson / asStructured), else `[]`. The component's own node is still
 * emitted by the caller; this records why it has no edges.
 */
export function payloadParseErrors(
  ctx: ParseContext,
  owner: NodeFact,
  parsed: unknown,
): NodeFact[] {
  const msg =
    parsed && typeof parsed === "object"
      ? (parsed as Record<symbol, unknown>)[PAYLOAD_PARSE_ERROR]
      : undefined;
  if (typeof msg !== "string") return [];
  const qn = `ParseError:${String(owner.qualifiedName)}`;
  return [makeNode(ctx, "ParseError", qn, { message: msg, label: owner.label }, sha256(qn + msg))];
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

export type ElementKind = "dataraptor" | "ip" | "remote" | "card" | "omniscript" | "lwc" | "rest";
export interface ElementRef {
  kind: ElementKind;
  target: string;
  attrs: Record<string, unknown>;
}

/** Qualified-name label per element kind, shared by the three Vlocity parsers. */
export const TARGET_LABEL: Record<ElementKind, string> = {
  dataraptor: "DataRaptor",
  ip: "IntegrationProcedure",
  omniscript: "OmniScript",
  lwc: "LWC",
  card: "VlocityCard",
  remote: "Remote",
  rest: "NamedCredential",
};

const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

/** True when the element carries an Active/IsActive flag that is explicitly false. */
export function isExplicitlyInactive(el: any): boolean {
  for (const k of ["IsActive", "isActive", "Active", "active"]) {
    const f = el?.[k];
    if (f === false || (typeof f === "string" && f.trim().toLowerCase() === "false")) return true;
  }
  return false;
}

/**
 * Classify one visited node of a Vlocity DataPack tree into zero or more
 * references to other components (linkage spec 4.2). Empty strings never
 * produce a ref; nodes without an explicit string Type produce nothing.
 */
export function classifyElement(v: unknown): ElementRef[] {
  if (!v || typeof v !== "object") return [];
  const rawType = (v as any).Type ?? (v as any).type;
  if (typeof rawType !== "string" || !rawType) return [];
  const ps: any = (v as any).propertySet ?? v;
  if (!ps || typeof ps !== "object" || "_raw" in ps) return [];
  const t = rawType.toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: ElementRef[] = [];
  const push = (kind: ElementKind, target: string, attrs: Record<string, unknown> = {}) => {
    if (target) out.push({ kind, target, attrs });
  };
  if (t.includes("dataraptor")) push("dataraptor", str(ps.bundle) || str(ps.dataRaptorBundleName));
  else if (t.includes("integrationprocedure") || t === "ipaction" || t === "ip")
    push("ip", str(ps.integrationProcedureKey) || str(ps.bundle));
  else if (t === "omniscript") {
    const ty = str(ps.Type);
    const sub = str(ps["Sub Type"]);
    if (ty && sub) push("omniscript", [ty, sub, str(ps.Language)].filter(Boolean).join("_"));
  } else if (t.includes("lightningwebcomponent") || t.includes("lwc"))
    push("lwc", str(ps.lwcName) || str(ps.componentName) || str(ps.bundle));
  else if (t.includes("card")) push("card", str(ps.cardName) || str(ps.bundle));
  else if (t.includes("restaction") || t.includes("http")) {
    const nc = str(ps.namedCredential);
    if (nc) push("rest", nc, { restMethod: ps.restMethod });
    else push("remote", str(ps.restPath) || str(ps.endpointURL));
  } else if (t.includes("remote"))
    push("remote", str(ps.remoteClass) || "unknown", {
      remoteClass: str(ps.remoteClass),
      remoteMethod: str(ps.remoteMethod),
    });
  // Any element type (Try Catch Block, Log Catch Block, …) may carry a
  // remoteClass; emit it once. Inactive elements are still emitted, tagged
  // below (a reference in source is never dropped).
  const rc = str(ps.remoteClass);
  if (rc && !out.some((r) => r.kind === "remote" && r.attrs.remoteClass === rc))
    push("remote", rc, { remoteClass: rc, remoteMethod: str(ps.remoteMethod) });
  const seen = new Set<string>();
  for (const [src, role] of [
    [ps.preTransformBundle, "preTransform"],
    [ps.postTransformBundle, "postTransform"],
    [ps.remoteOptions?.preTransformBundle, "preTransform"],
    [ps.remoteOptions?.postTransformBundle, "postTransform"],
  ] as const) {
    const n = str(src);
    if (n && !seen.has(`${n}|${role}`)) {
      seen.add(`${n}|${role}`);
      out.push({ kind: "dataraptor", target: n, attrs: { role } });
    }
  }
  // Never drop a reference from an inactive element: tag it instead.
  if (isExplicitlyInactive(v)) for (const r of out) r.attrs = { ...r.attrs, inactive: true };
  return out;
}

const SET_VALUE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Literal identifier values of every Set Values element's `elementValueMap`
 * in a DataPack tree (`{RollupProcName: "Billing_Rollups"}`).
 * A Set Values step can name a component that a later step runs by
 * reference; these are name-match candidates (see name-match-resolver), not
 * edges. Merge fields (`%x%`), formulas, labels with spaces, paths, numbers
 * and nested objects are skipped. First-seen order, deduped.
 */
export function setValuesCandidates(dp: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const rawType = (v as any).Type ?? (v as any).type;
    if (typeof rawType !== "string") return;
    if (rawType.toLowerCase().replace(/[^a-z0-9]/g, "") !== "setvalues") return;
    const ps: any = (v as any).propertySet;
    const map = ps && typeof ps === "object" ? ps.elementValueMap : undefined;
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    for (const val of Object.values(map)) {
      if (typeof val !== "string" || !SET_VALUE_NAME_RE.test(val) || seen.has(val)) continue;
      seen.add(val);
      out.push(val);
    }
  };
  visit(dp);
  walk(dp, (v) => visit(v));
  return out;
}

/**
 * Classify a VlocityCard `dataSource` object (`{type, value:{bundle, ipMethod,
 * remoteClass, remoteMethod}}`). Shape-driven: `value.ipMethod` is an
 * Integration Procedure, `value.bundle` a DataRaptor (unless the type says
 * Integration Procedure), `value.remoteClass` an Apex remote.
 */
export function classifyDataSource(ds: unknown): ElementRef[] {
  if (!ds || typeof ds !== "object") return [];
  const val: any = (ds as any).value;
  if (!val || typeof val !== "object") return [];
  const type = str((ds as any).type)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const out: ElementRef[] = [];
  const bundle = str(val.bundle);
  const ipMethod = str(val.ipMethod);
  const rc = str(val.remoteClass);
  if (ipMethod) out.push({ kind: "ip", target: ipMethod, attrs: { via: "dataSource" } });
  if (bundle) {
    const kind: ElementKind = type.includes("integrationprocedure") ? "ip" : "dataraptor";
    if (!(kind === "ip" && ipMethod === bundle))
      out.push({ kind, target: bundle, attrs: { via: "dataSource" } });
  }
  if (rc)
    out.push({
      kind: "remote",
      target: rc,
      attrs: { remoteClass: rc, remoteMethod: str(val.remoteMethod), via: "dataSource" },
    });
  return out;
}

/**
 * Several Remote Actions on one class collapse into a single edge per
 * (rel, dst) (the store's key). `remoteMethod` keeps the first method; when a
 * second distinct one appears, `remoteMethods` lists them all, so no method is
 * lost (read them with remoteMethodsOf). Callers key the edge case-insensitively.
 */
export function addRemoteMethod(attrs: Record<string, unknown>, method: unknown): void {
  if (typeof method !== "string" || method === "") return;
  const first = typeof attrs.remoteMethod === "string" ? attrs.remoteMethod : "";
  if (first === "") {
    attrs.remoteMethod = method;
    return;
  }
  const list = remoteMethodsOf(attrs);
  // Apex method names are case-insensitive.
  const lower = method.toLowerCase();
  if (!list.some((m) => m.toLowerCase() === lower)) attrs.remoteMethods = [...list, method];
}

/** Every remote method an edge names: `remoteMethods`, else `remoteMethod`. */
export function remoteMethodsOf(attrs: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = Array.isArray(attrs.remoteMethods) ? attrs.remoteMethods : [];
  for (const m of [...list, attrs.remoteMethod])
    if (typeof m === "string" && m !== "" && !out.includes(m)) out.push(m);
  return out;
}

/**
 * Walk a DataPack tree, classify each value into refs and build one edge per
 * (rel, dst). Remote refs keep every method (see addRemoteMethod). `inactive=true` is kept only when EVERY contributing ref is
 * inactive (own flag or any inactive ancestor); one active ref makes the edge
 * active. Order of the walk never affects the stored flag.
 */
export function collectRefEdges(
  dp: unknown,
  ctx: ParseContext,
  src: string,
  refsFor: (v: any, key: string | number | null) => ElementRef[],
  relFor: (kind: ElementKind) => RelType | undefined,
): EdgeFact[] {
  const acc = new Map<
    string,
    { rel: RelType; dst: string; attrs: Record<string, unknown>; inactive: boolean }
  >();
  const visit = (v: any, key: string | number | null, anc: boolean) => {
    for (const ref of refsFor(v, key)) {
      const rel = relFor(ref.kind);
      if (!rel) continue;
      const name =
        ref.kind === "remote" || ref.kind === "rest"
          ? ref.target
          : stripNs(ref.target, ctx.namespace);
      const dst = `${TARGET_LABEL[ref.kind]}:${name}`;
      const { inactive: own, ...rest } = ref.attrs;
      const inactive = anc || own === true;
      // Lower-cased like the store's NOCASE edge key, so `CPQAppHandler` and
      // `CpqAppHandler` merge their method lists instead of overwriting.
      const k = `${rel}|${dst}`.toLowerCase();
      const prev = acc.get(k);
      if (prev) {
        prev.inactive = prev.inactive && inactive;
        addRemoteMethod(prev.attrs, rest.remoteMethod);
      } else {
        const attrs = { ...rest };
        addRemoteMethod(attrs, rest.remoteMethod);
        acc.set(k, { rel, dst, attrs, inactive });
      }
    }
    if (v && typeof v === "object") {
      const next = anc || (!Array.isArray(v) && isExplicitlyInactive(v));
      if (Array.isArray(v)) v.forEach((x, i) => visit(x, i, next));
      else for (const [k, x] of Object.entries(v)) visit(x, k, next);
    }
  };
  if (Array.isArray(dp)) dp.forEach((x, i) => visit(x, i, false));
  else if (dp && typeof dp === "object")
    for (const [k, x] of Object.entries(dp)) visit(x, k, false);
  return [...acc.values()].map((a) =>
    makeEdge(ctx, src, a.rel, a.dst, a.inactive ? { ...a.attrs, inactive: true } : a.attrs),
  );
}
