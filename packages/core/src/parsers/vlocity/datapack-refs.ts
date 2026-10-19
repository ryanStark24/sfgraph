import { REL_TYPES, type RelType } from "../../domain/index.js";
import { TARGET_LABEL, addRemoteMethod, classifyDataSource } from "./common.js";

export interface DataPackRef {
  rel: RelType;
  dst: string;
  attrs: Record<string, unknown>;
}

const OS_URL_RE =
  /OmniScriptType([/=])([^/?&#"']+)[/&]OmniScriptSubType[/=]([^/?&#"']+)[/&]OmniScriptLang[/=]([^/?&#"'\s]+)/gi;
const BUNDLE_KEY_RE = /(?:DRBundleName|BundleName)$/;

/** `c:x` / `c__target=c:x` Lightning component references (default namespace only). */
const LWC_REF_RE = /(?<=^|[\s"'=/&<>(\[{,;])c:([A-Za-z_][A-Za-z0-9_]*)/g;
/** Keys whose string value may be the exact name of an IP/DR/OS. */
const NAME_MATCH_KEY_RE = /^(?:ProcessName|SetupValue|AutoTaskParameters)$|ProcName$/i;

/** Distinct string values under name-match keys (resolved post-ingest against
 *  existing IP/DR/OS names by `resolveVlocityNameMatches`). */
export function collectNameMatchCandidates(record: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown, key: string | null, depth: number) => {
    if (depth > 20) return;
    if (typeof v === "string") {
      if (key && NAME_MATCH_KEY_RE.test(key) && v.trim()) out.add(v.trim());
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
    }
  };
  visit(record, null, 0);
  return [...out];
}

function decode(s: string): string {
  // Decode repeatedly (double-encoded URLs); stop on malformed escapes.
  let cur = s;
  for (let i = 0; i < 2 && cur.includes("%"); i++) {
    try {
      cur = decodeURIComponent(cur);
    } catch {
      break;
    }
  }
  return cur;
}

/**
 * Generic reference scanner for Vlocity DataPack records that have no parser
 * of their own (VlocityAction, DocumentTemplate, …). Walks every string value:
 *  - OmniScript launch URLs `OmniScriptType/<T>/OmniScriptSubType/<S>/OmniScriptLang/<L>`
 *    (URL-decoded first; also the query form `OmniScriptType=T&OmniScriptSubType=S&OmniScriptLang=L`) -> REFERENCES -> `OmniScript:<T>_<S>_<L>`
 *  - fields whose (normalised) name ends in `DRBundleName` / `BundleName` with a
 *    non-empty string value -> REFERENCES -> `DataRaptor:<value>`
 *  - `Cards: ["name", …]` string arrays -> REFERENCES -> `VlocityCard:<name>`
 *  - any `dataSource` / `Datasource` object (or JSON string) -> classifyDataSource
 *  - `c:x` / `c__target=c:x` in string values -> REFERENCES -> `LWC:x` (c namespace only)
 */
export function scanDataPackRefs(record: unknown): DataPackRef[] {
  const out: DataPackRef[] = [];
  const byDst = new Map<string, DataPackRef>();
  const add = (dst: string, attrs: Record<string, unknown>) => {
    const key = dst.toLowerCase(); // the store's edge key is NOCASE
    const prev = byDst.get(key);
    if (prev) {
      addRemoteMethod(prev.attrs, attrs.remoteMethod);
      return;
    }
    const ref: DataPackRef = { rel: REL_TYPES.REFERENCES, dst, attrs: { ...attrs } };
    addRemoteMethod(ref.attrs, attrs.remoteMethod);
    byDst.set(key, ref);
    out.push(ref);
  };
  const addDataSource = (v: unknown) => {
    let ds: unknown = v;
    if (typeof v === "string" && v.trimStart().startsWith("{")) {
      try {
        ds = JSON.parse(v);
      } catch {
        return;
      }
    }
    for (const r of classifyDataSource(ds)) add(`${TARGET_LABEL[r.kind]}:${r.target}`, r.attrs);
  };
  const visit = (v: unknown, key: string | null, depth: number) => {
    if (depth > 20) return;
    if (key && key.toLowerCase() === "datasource" && v && typeof v !== "number") {
      addDataSource(v);
    }
    if (key === "Cards" && Array.isArray(v)) {
      for (const c of v)
        if (typeof c === "string" && c.trim()) add(`VlocityCard:${c.trim()}`, { via: "Cards" });
    }
    if (typeof v === "string") {
      if (v.includes("c:"))
        for (const m of v.matchAll(LWC_REF_RE)) add(`LWC:${m[1]}`, { via: key ?? "lwc" });
      if (key && BUNDLE_KEY_RE.test(key) && v.trim()) {
        add(`DataRaptor:${v.trim()}`, { via: key });
        return;
      }
      if (v.toLowerCase().includes("omniscript")) {
        const d = decode(v);
        for (const m of d.matchAll(OS_URL_RE)) {
          const [, sep, ...parts] = m;
          // Query-string form (`Type=a+b&...`): '+' encodes a space.
          const [t, s, l] = sep === "=" ? parts.map((x) => x.replace(/\+/g, " ")) : parts;
          if (t && s && l) add(`OmniScript:${t}_${s}_${l}`, { via: key ?? "url" });
        }
      }
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
    }
  };
  visit(record, null, 0);
  return out;
}
