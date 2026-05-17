import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import type { OrgCapabilities } from "../capabilities.js";
import { scheduleQuery, soqlWithTimeout } from "../rate-limit.js";

export interface VlocityTypeDef {
  vlocityDataPackType: string;
  /** Raw SOQL with `%vlocity_namespace%` placeholder. */
  query: string;
}

interface RawYamlEntry {
  VlocityDataPackType?: string;
  query?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(HERE, "query-definitions.yml");

let CACHED_REGISTRY: Record<string, VlocityTypeDef> | null = null;

/** Load and cache the vendored Vlocity DataPack query registry. */
export function loadVlocityRegistry(): Record<string, VlocityTypeDef> {
  if (CACHED_REGISTRY) return CACHED_REGISTRY;
  const text = readFileSync(REGISTRY_PATH, "utf8");
  const parsed = parseYaml(text) as Record<string, RawYamlEntry> | null;
  const out: Record<string, VlocityTypeDef> = {};
  if (parsed && typeof parsed === "object") {
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") continue;
      const vdpType = value.VlocityDataPackType;
      const query = value.query;
      if (typeof vdpType !== "string" || typeof query !== "string") continue;
      out[key] = { vlocityDataPackType: vdpType, query };
    }
  }
  CACHED_REGISTRY = out;
  return out;
}

interface VRow {
  Id?: string;
  Name?: string;
  LastModifiedDate?: string;
  [k: string]: unknown;
}

interface VElementRow {
  Id?: string;
  Name?: string;
  [k: string]: unknown;
}

/** Strip a Vlocity namespace prefix + `__c` suffix so the parser walk sees
 *  the conventional keys (`Type`, `propertySet`, `Definition`, …) instead
 *  of `vlocity_cmt__Type__c` etc. Keeps `Id`, `Name`, `LastModifiedDate`
 *  intact. */
function normaliseFieldName(key: string, namespace: string): string {
  let k = key;
  if (k.startsWith(`${namespace}__`)) k = k.slice(namespace.length + 2);
  if (k.endsWith("__c") || k.endsWith("__r")) k = k.slice(0, -3);
  return k;
}

/** Parse a long-text JSON field value defensively — Vlocity stores design-
 *  time config as stringified JSON; if parsing fails we keep the raw text
 *  under `_raw` so a parser fallback can still see something. */
function tryParseJsonField(value: unknown): unknown {
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
function normaliseRow(row: Record<string, unknown>, namespace: string): Record<string, unknown> {
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

interface ChildFetchSpec {
  /** Per-namespace SOQL fragment selecting the child rows. Use `%PARENT_IDS%`
   *  as placeholder for the IN-list of parent Ids. */
  soql: (namespace: string, parentIdList: string) => string;
  /** Field on the child row pointing back at the parent. Stripped of
   *  namespace + __c when grouping. */
  parentField: string;
  /** Key under which children get attached to the parent. */
  attachAs: string;
}

/** Datapack-type-specific child queries. Only types with non-empty entries
 *  produce edges in the parser walk. Anything not listed yields a parent-
 *  only row (which is still useful as a node). */
const CHILD_FETCHES: Record<string, ChildFetchSpec> = {
  OmniScript: {
    soql: (ns, ids) =>
      `SELECT Id, Name, ${ns}__Type__c, ${ns}__PropertySet__c, ${ns}__OmniScriptId__c FROM ${ns}__Element__c WHERE ${ns}__OmniScriptId__c IN (${ids})`,
    parentField: "OmniScriptId",
    attachAs: "elements",
  },
  IntegrationProcedure: {
    // Same Element__c table; IntegrationProcedures are OmniScripts with
    // IsProcedure__c = true.
    soql: (ns, ids) =>
      `SELECT Id, Name, ${ns}__Type__c, ${ns}__PropertySet__c, ${ns}__OmniScriptId__c FROM ${ns}__Element__c WHERE ${ns}__OmniScriptId__c IN (${ids})`,
    parentField: "OmniScriptId",
    attachAs: "elements",
  },
  DataRaptor: {
    soql: (ns, ids) =>
      `SELECT Id, Name, ${ns}__InputFieldName__c, ${ns}__OutputFieldName__c, ${ns}__DRBundleId__c FROM ${ns}__DRMapItem__c WHERE ${ns}__DRBundleId__c IN (${ids})`,
    parentField: "DRBundleId",
    attachAs: "mapItems",
  },
};

/** Long-text fields that need to be SELECTed explicitly per-type because
 *  the vendored vlocity_build registry omits them. Keyed by VlocityDataPackType. */
const EXTRA_BLOB_FIELDS: Record<string, string[]> = {
  OmniScript: ["PropertySet__c"],
  IntegrationProcedure: ["PropertySet__c"],
  VlocityCard: ["Definition__c", "Active__c"],
  DataRaptor: ["Type__c", "InputType__c", "OutputType__c"],
};

/** Build an enriched SOQL by appending the missing blob columns. We do this
 *  as a textual rewrite of the registry's SELECT clause rather than parsing
 *  SOQL — preserves the existing namespace placeholder substitution. */
function enrichSoql(baseSoql: string, vdpType: string, namespace: string): string {
  const extras = EXTRA_BLOB_FIELDS[vdpType];
  if (!extras || extras.length === 0) return baseSoql;
  const cols = extras.map((c) => `${namespace}__${c}`).join(", ");
  // Insert before the first " from " (case-insensitive). Be tolerant of
  // both quoting / casing variants used in the vendored YAML.
  return baseSoql.replace(/(\s+from\s+)/i, `, ${cols}$1`);
}

/**
 * Fetch element children (one query per type-namespace pair) and group by
 * parent Id. Runs only for types listed in CHILD_FETCHES. Without this,
 * the parser walk() for OmniScript/IntegrationProcedure/DataRaptor finds
 * zero element nodes and emits zero IP_CALLS_DR / OS_USES_DR / DR_READS_FIELD
 * edges — Vlocity nodes exist in isolation.
 */
async function fetchChildrenByParent(
  conn: any,
  vdpType: string,
  namespace: string,
  parentIds: string[],
  onError?: (label: string, err: Error) => void,
): Promise<Map<string, Array<Record<string, unknown>>>> {
  const byParent = new Map<string, Array<Record<string, unknown>>>();
  const spec = CHILD_FETCHES[vdpType];
  if (!spec || parentIds.length === 0) return byParent;
  const CHUNK = 200;
  for (let i = 0; i < parentIds.length; i += CHUNK) {
    const slice = parentIds.slice(i, i + CHUNK);
    const idList = slice.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(",");
    const soql = spec.soql(namespace, idList);
    let res: { records?: VElementRow[] } | null = null;
    try {
      res = (await scheduleQuery(() =>
        soqlWithTimeout(conn.query(soql), `vlocity ${vdpType} children (${namespace})`),
      )) as { records?: VElementRow[] } | null;
    } catch (e) {
      // Child fetch failed for this chunk — could be schema drift (e.g.
      // DRMapItem.DRBundleId__c removed in newer vlocity_cmt packages) or
      // a transient pool/socket failure. Surface via onError so callers can
      // distinguish "feature absent" from "schema drift" instead of seeing
      // identical empty output. Continue to the next chunk — partial
      // children are still useful.
      onError?.(`vlocity:${vdpType}:children:${namespace}`, e as Error);
      continue;
    }
    for (const r of res?.records ?? []) {
      const norm = normaliseRow(r as Record<string, unknown>, namespace);
      const parentId = String(norm[spec.parentField] ?? "");
      if (!parentId) continue;
      const arr = byParent.get(parentId) ?? [];
      arr.push(norm);
      byParent.set(parentId, arr);
    }
  }
  return byParent;
}

/**
 * Yield a RawMember per record across every detected Vlocity namespace and every
 * registry entry. Namespace substitution is `%vlocity_namespace%` → `<ns>`.
 *
 * For datapack types listed in CHILD_FETCHES, also fetches the element
 * graph (Element__c / DRMapItem__c) and attaches it under the configured
 * key — without this enrichment the parsers find zero inner nodes and
 * emit zero edges, so Vlocity nodes exist in the graph but have no
 * relationships.
 */
export async function* iterVlocityRecords(
  conn: any,
  caps: OrgCapabilities,
  orgId: string,
  onError?: (label: string, err: Error) => void,
): AsyncIterable<RawMember> {
  const namespaces = caps.vlocityNamespaces ?? [];
  if (namespaces.length === 0) return;
  const registry = loadVlocityRegistry();
  const entries = Object.values(registry);

  // Flatten (namespace, typeDef) into one task list. Each task does its
  // own SOQL (with per-call timeout, no longer can hang forever on a
  // dead socket) + optional child fetch. Yields are NOT order-preserving
  // across tasks — that's fine, downstream merge is order-independent.
  type Task = { namespace: string; typeDef: (typeof entries)[number] };
  const tasks: Task[] = [];
  for (const namespace of namespaces) {
    for (const typeDef of entries) tasks.push({ namespace, typeDef });
  }

  type Settled = { idx: number; t: Task; records: VRow[]; childrenByParent: Map<string, Array<Record<string, unknown>>> };

  const runTask = async (idx: number, t: Task): Promise<Settled> => {
    const baseSoql = t.typeDef.query.split("%vlocity_namespace%").join(t.namespace);
    const soql = enrichSoql(baseSoql, t.typeDef.vlocityDataPackType, t.namespace);
    let res: { records?: VRow[] } | null = null;
    try {
      res = (await scheduleQuery(() =>
        soqlWithTimeout(
          conn.query(soql),
          `vlocity ${t.typeDef.vlocityDataPackType} (${t.namespace})`,
        ),
      )) as { records?: VRow[] } | null;
    } catch (e) {
      // Per-type query failed. Common causes: type doesn't exist in this
      // org (different Vlocity industry namespaces install different
      // DataPack types — INVALID_TYPE / sObject not supported), socket
      // timeout, schema drift. Report via onError so the caller can
      // distinguish "type genuinely absent" from "type present but query
      // wedged" — these used to look identical (empty output) which made
      // schema-drift bugs invisible.
      onError?.(`vlocity:${t.typeDef.vlocityDataPackType}:${t.namespace}`, e as Error);
      return { idx, t, records: [], childrenByParent: new Map() };
    }
    const records = res?.records ?? [];
    const childSpec = CHILD_FETCHES[t.typeDef.vlocityDataPackType];
    const childrenByParent = childSpec
      ? await fetchChildrenByParent(
          conn,
          t.typeDef.vlocityDataPackType,
          t.namespace,
          records.map((r) => String(r.Id ?? "")).filter((id) => id.length > 0),
          onError,
        )
      : new Map<string, Array<Record<string, unknown>>>();
    return { idx, t, records, childrenByParent };
  };

  // Sliding window of 4 in-flight tasks. Matches the BATCH_WINDOW pattern
  // used by security/flow/integration/generic-metadata extractors. Yields
  // are streamed as each task returns — empty types (~1s response, 0
  // records) don't park the slot for slow types; slow types fail their
  // own per-query timeout (60s) without dragging peers down.
  const WINDOW = 4;
  const inFlight = new Map<number, Promise<Settled>>();
  let nextIdx = 0;
  while (inFlight.size < WINDOW && nextIdx < tasks.length) {
    const idx = nextIdx++;
    const taskRef = tasks[idx];
    if (!taskRef) continue;
    inFlight.set(idx, runTask(idx, taskRef));
  }
  while (inFlight.size > 0) {
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.idx);
    if (nextIdx < tasks.length) {
      const idx = nextIdx++;
      const taskRef = tasks[idx];
      if (taskRef) inFlight.set(idx, runTask(idx, taskRef));
    }
    const { t, records, childrenByParent } = settled;
    const childSpec = CHILD_FETCHES[t.typeDef.vlocityDataPackType];
    for (const r of records) {
      const name = String(r.Name ?? r.Id ?? "");
      const normalised = normaliseRow(r as Record<string, unknown>, t.namespace);
      if (childSpec && r.Id) {
        const kids = childrenByParent.get(String(r.Id));
        if (kids && kids.length > 0) normalised[childSpec.attachAs] = kids;
      }
      yield {
        ref: {
          category: METADATA_CATEGORY.VLOCITY,
          memberType: t.typeDef.vlocityDataPackType,
          memberName: name,
          lastModifiedAt: r.LastModifiedDate ?? "",
          sourceUri: `sf://${orgId}/${t.typeDef.vlocityDataPackType}/${name}`,
          namespace: t.namespace,
        },
        content: JSON.stringify(normalised),
      };
    }
  }
}
