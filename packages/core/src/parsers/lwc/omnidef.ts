import type { EdgeFact, RelType } from "../../domain/index.js";
import { REL_TYPES } from "../../domain/index.js";
import { makeEdge, stripNs } from "../common.js";
import type { ParseContext } from "../contract.js";
import { type ElementKind, TARGET_LABEL, classifyElement } from "../vlocity/common.js";

/**
 * Compiled-OmniScript LWCs (`<type><SubType><Lang>_def.js`) carry the whole
 * OmniScript definition as `export const OMNIDEF = {…}` (or, for large
 * scripts, base64 chunks in sibling `omnidef_chunkN.js` files). The element
 * property bag is `propSetMap` rather than the DataPack's `propertySet`.
 *
 * The LWC is the OmniScript's runtime, so element references use the
 * OmniScript rel family (IP calls use the existing LWC_CALLS_IP), which also
 * lets the Vlocity Apex resolver pick up `OS_INVOKES_REMOTE` from it.
 */
const KIND_REL: Partial<Record<ElementKind, RelType>> = {
  dataraptor: REL_TYPES.OS_USES_DR,
  ip: REL_TYPES.LWC_CALLS_IP,
  remote: REL_TYPES.OS_INVOKES_REMOTE,
  card: REL_TYPES.OS_EMBEDS_VC,
  omniscript: REL_TYPES.OS_EMBEDS_OS,
  lwc: REL_TYPES.OS_EMBEDS_LWC,
  rest: REL_TYPES.CALLS_NAMED_CREDENTIAL,
};

export const isOmnidefFile = (fname: string): boolean => /(^|\/)[^/]*_def\.js$/.test(fname);
export const isOmnidefChunkFile = (fname: string): boolean =>
  /(^|\/)omnidef_chunk\d+\.js$/.test(fname);

const INLINE_RE = /export\s+const\s+OMNIDEF\s*=\s*(\{[\s\S]*\})\s*;?\s*$/;
const CHUNK_IMPORT_RE = /import\s*\{\s*(\w+)\s*\}\s*from\s*['"]\.\/(omnidef_chunk\d+)\.js['"]/g;
const CHUNK_VALUE_RE = /export\s+const\s+(\w+)\s*=\s*["']([A-Za-z0-9+/=]*)["']/;

function baseName(f: string): string {
  return f.slice(f.lastIndexOf("/") + 1);
}

/** Parse the OMNIDEF object of a `_def.js` file, or null when it is not one. */
export function readOmnidef(defFile: string, files: Record<string, string>): any | null {
  const src = files[defFile] ?? "";
  const inline = INLINE_RE.exec(src);
  if (inline) {
    try {
      return JSON.parse(inline[1] ?? "");
    } catch {
      // Not plain JSON: fall through to the chunked form / give up.
    }
  }
  if (!src.includes("omnidef_chunk")) return null;
  const chunkByBase = new Map<string, string>();
  for (const [k, v] of Object.entries(files)) {
    if (isOmnidefChunkFile(k)) chunkByBase.set(baseName(k).replace(/\.js$/, ""), v);
  }
  let b64 = "";
  for (const m of src.matchAll(CHUNK_IMPORT_RE)) {
    const chunk = chunkByBase.get(m[2] ?? "");
    const val = chunk ? CHUNK_VALUE_RE.exec(chunk) : null;
    if (!val || val[1] !== m[1]) return null;
    b64 += val[2] ?? "";
  }
  if (!b64) return null;
  try {
    return JSON.parse(decodeURIComponent(Buffer.from(b64, "base64").toString("latin1")));
  } catch {
    return null;
  }
}

const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

/** Edges from a compiled-OmniScript LWC: its elements' targets, Navigate
 *  Action LWC targets, and `REFERENCES OmniScript:<Type>_<SubType>_<Lang>`. */
export function omnidefEdges(def: any, lwcQname: string, ctx: ParseContext): EdgeFact[] {
  const edges: EdgeFact[] = [];
  const seen = new Set<string>();
  const push = (rel: RelType, dst: string, attrs: Record<string, unknown>) => {
    const key = `${rel}|${dst}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(makeEdge(ctx, lwcQname, rel, dst, { via: "omnidef", ...attrs }));
  };

  const bpType = str(def?.bpType);
  const bpSubType = str(def?.bpSubType);
  if (bpType && bpSubType) {
    const os = [bpType, bpSubType, str(def?.bpLang)].filter(Boolean).join("_");
    push(REL_TYPES.REFERENCES, `OmniScript:${stripNs(os, ctx.namespace)}`, {
      via: "compiled-omniscript",
    });
  }

  const visit = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const o = v as Record<string, unknown>;
    const ps = o.propSetMap;
    if (typeof o.type === "string" && ps && typeof ps === "object") {
      const el: Record<string, unknown> = { type: o.type, propertySet: ps };
      for (const k of ["isActive", "IsActive", "active", "Active"]) if (k in o) el[k] = o[k];
      for (const ref of classifyElement(el)) {
        const rel = KIND_REL[ref.kind];
        if (!rel) continue;
        const name =
          ref.kind === "remote" || ref.kind === "rest"
            ? ref.target
            : stripNs(ref.target, ctx.namespace);
        push(rel, `${TARGET_LABEL[ref.kind]}:${name}`, ref.attrs);
      }
      // Navigate Action to another compiled OmniScript / LWC: `targetLWC: "c:x"`.
      const p = ps as Record<string, unknown>;
      const target = /^c:([A-Za-z]\w*)$/i.exec(str(p.targetLWC));
      if (target && /omniscript|component|lwc/i.test(str(p.targetType))) {
        push(REL_TYPES.REFERENCES, `LWC:${stripNs(target[1] ?? "", ctx.namespace)}`, {
          via: "navigate-action",
        });
      }
    }
    for (const x of Object.values(o)) visit(x);
  };
  visit(def?.children);
  return edges;
}
