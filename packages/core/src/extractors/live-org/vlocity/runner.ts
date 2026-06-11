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
  /** Per-namespace SOQL fragment selecting the child rows. The second arg is
   *  the quoted IN-list of parent keys (Ids or Names per `linkBy`). */
  soql: (namespace: string, parentKeyList: string) => string;
  /** Normalised child field (namespace + __c stripped) used to GROUP children
   *  back to a parent. Its values must equal the parent's `linkBy` property. */
  parentField: string;
  /** Which parent property the children correlate to. Default "Id" (master-
   *  detail FK like Element.OmniScriptId). Some objects have NO such FK in
   *  certain managed-package versions — notably DRMapItem in vlocity_cmt has
   *  no DRBundleId field at all; it correlates to its DRBundle purely by
   *  Name (DRMapItem.Name === DRBundle.Name, the same correlation the Vlocity
   *  build tool uses). Set "Name" for those. */
  linkBy?: "Id" | "Name";
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
  // DRMapItem stores field mappings structurally, NOT as Input/OutputField:
  // one side names a real SObject + field (Interface* for Extract, Domain*
  // for Load, Lookup* for lookups), the other is a JSON/XML path. Two bugs
  // here, both only surfaced by real DRMapItem data:
  //   1. The old query selected `InputFieldName__c`/`OutputFieldName__c` —
  //      fields that do NOT exist on DRMapItem__c — so it threw INVALID_FIELD
  //      and every DataRaptor came back childless. These are the real columns.
  //   2. DRMapItem__c has NO `DRBundleId__c` field in vlocity_cmt; the old
  //      `WHERE DRBundleId__c IN (...)` ALSO threw INVALID_FIELD. The child
  //      correlates to its parent by NAME (DRMapItem.Name === DRBundle.Name),
  //      so we filter and group by Name (linkBy: "Name").
  DataRaptor: {
    soql: (ns, names) =>
      `SELECT Id, Name, ${ns}__InterfaceObjectName__c, ${ns}__InterfaceFieldAPIName__c, ${ns}__DomainObjectAPIName__c, ${ns}__DomainObjectFieldAPIName__c, ${ns}__LookupDomainObjectName__c, ${ns}__LookupDomainObjectFieldName__c, ${ns}__Formula__c, ${ns}__FormulaConverted__c, ${ns}__TransformValuesMap__c FROM ${ns}__DRMapItem__c WHERE Name IN (${names})`,
    // Children carry the bundle name in their own `Name`; group on it and
    // attach to the parent whose Name matches.
    parentField: "Name",
    linkBy: "Name",
    // DataRaptorParser reads dp.elements (shared shape with the OmniScript /
    // IntegrationProcedure element walk); attaching under any other key left
    // the parser looking at an empty array.
    attachAs: "elements",
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

  // The vendored registry lists ~48 DataPack types, but a given vlocity_cmt
  // package version only installs SOME of their backing SObjects (e.g.
  // `QueryBuilder__c` is absent in many versions). Querying a non-existent
  // object throws INVALID_TYPE — caught per-type below, but it's a wasted
  // round-trip and a noisy skip. Describe the org ONCE up-front and skip any
  // type whose FROM object isn't actually present. If describeGlobal fails,
  // fall back to attempting all (the per-type catch still protects us).
  let knownObjects: Set<string> | null = null;
  try {
    const dg = (await conn.describeGlobal()) as { sobjects?: Array<{ name?: string }> } | null;
    const names = (dg?.sobjects ?? []).map((s) => String(s.name ?? "").toLowerCase());
    if (names.length > 0) knownObjects = new Set(names);
  } catch {
    /* describeGlobal unavailable — don't pre-filter; rely on per-type catch */
  }
  // Extract the FROM object of a registry query with the namespace substituted.
  const fromObject = (query: string, ns: string): string | null => {
    const m = query
      .split("%vlocity_namespace%")
      .join(ns)
      .match(/\bfrom\s+([A-Za-z0-9_]+)/i);
    return m?.[1] ? m[1].toLowerCase() : null;
  };

  // Flatten (namespace, typeDef) into one task list. Each task does its
  // own SOQL (with per-call timeout, no longer can hang forever on a
  // dead socket) + optional child fetch. Yields are NOT order-preserving
  // across tasks — that's fine, downstream merge is order-independent.
  type Task = { namespace: string; typeDef: (typeof entries)[number] };
  const tasks: Task[] = [];
  let skippedAbsent = 0;
  for (const namespace of namespaces) {
    for (const typeDef of entries) {
      if (knownObjects) {
        const obj = fromObject(typeDef.query, namespace);
        if (obj && !knownObjects.has(obj)) {
          skippedAbsent += 1;
          continue; // SObject not installed in this package version — don't query it
        }
      }
      tasks.push({ namespace, typeDef });
    }
  }
  if (skippedAbsent > 0) {
    console.log(
      `ingest:   vlocity: skipped ${skippedAbsent} DataPack type(s) whose SObject is not present in this org (e.g. QueryBuilder)`,
    );
  }

  type Settled = {
    idx: number;
    t: Task;
    records: VRow[];
    childrenByParent: Map<string, Array<Record<string, unknown>>>;
  };

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
    // Collect the parent keys the children correlate to — Id for FK-linked
    // children (Element.OmniScriptId), Name for name-linked ones (DRMapItem).
    const linkBy = childSpec?.linkBy ?? "Id";
    const childrenByParent = childSpec
      ? await fetchChildrenByParent(
          conn,
          t.typeDef.vlocityDataPackType,
          t.namespace,
          records
            .map((r) => String((linkBy === "Name" ? r.Name : r.Id) ?? ""))
            .filter((k) => k.length > 0),
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
      if (childSpec) {
        // Match children by the same key the fetch grouped on (Id or Name).
        const parentKey = String((childSpec.linkBy === "Name" ? r.Name : r.Id) ?? "");
        const kids = parentKey ? childrenByParent.get(parentKey) : undefined;
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
