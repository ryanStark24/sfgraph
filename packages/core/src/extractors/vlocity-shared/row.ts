/** Strip a Vlocity namespace prefix + `__c` suffix so the parser walk sees
 *  the conventional keys (`Type`, `propertySet`, `Definition`, …) instead
 *  of `vlocity_cmt__Type__c` etc. Keeps `Id`, `Name`, `LastModifiedDate`
 *  intact. */
export function normaliseFieldName(key: string, namespace: string): string {
  let k = key;
  if (k.startsWith(`${namespace}__`)) k = k.slice(namespace.length + 2);
  if (k.endsWith("__c") || k.endsWith("__r")) k = k.slice(0, -3);
  return k;
}

/** Parse a long-text JSON field value defensively — Vlocity stores design-
 *  time config as stringified JSON; if parsing fails we keep the raw text
 *  under `_raw` so a parser fallback can still see something. */
export function tryParseJsonField(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { _raw: value };
  }
}

/** Normalise every key on a row (strip namespace prefix) and decode the
 *  known JSON-blob fields (`PropertySet`, `Definition`, `Content`,
 *  `DefinitionFileContent`). Returns a plain object the parsers' walk()
 *  can traverse. */
export function normaliseRow(row: Record<string, unknown>, namespace: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const key = normaliseFieldName(k, namespace);
    out[key] = v;
  }
  for (const blobKey of ["PropertySet", "Definition", "Content", "DefinitionFileContent"]) {
    if (typeof out[blobKey] === "string") {
      const parsed = tryParseJsonField(out[blobKey]);
      if (parsed !== null) out[blobKey] = parsed;
    }
  }
  // Surface `propertySet` under the lowercase key the parsers check for.
  if (out.PropertySet !== undefined && out.propertySet === undefined) {
    out.propertySet = out.PropertySet;
  }
  return out;
}

/** Canonical DataPack member name for a normalised Vlocity row (keys `Type`,
 *  `SubType`, `Language`). OmniScript/IP are keyed by Type_SubType[_Language]
 *  rather than record Id; other types by Name. */
export function memberNameFor(vdpType: string, row: Record<string, unknown>, onFallback?: (id: string) => void): string {
  const s = (k: string) => (typeof row[k] === "string" ? (row[k] as string).trim() : "");
  const fallback = String(row.Name ?? row.Id ?? "");
  if (vdpType === "OmniScript" || vdpType === "IntegrationProcedure") {
    const type = s("Type");
    const sub = s("SubType");
    const lang = s("Language");
    if (!type || !sub) {
      onFallback?.(String(row.Id ?? ""));
      return fallback;
    }
    if (vdpType === "OmniScript") return lang ? `${type}_${sub}_${lang}` : `${type}_${sub}`;
    return lang && lang.toLowerCase() !== "procedure" ? `${type}_${sub}_${lang}` : `${type}_${sub}`;
  }
  return fallback;
}
