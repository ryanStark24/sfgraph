import { METADATA_CATEGORY } from "../../../domain/index.js";
import type { RawMember } from "../../interfaces/metadata-source.js";
import { scheduleQuery, soqlWithTimeout } from "../rate-limit.js";
import { type RetryOptions, drainSoqlPages, querySoqlAll } from "../retry.js";

interface ToolingClassRow {
  Id: string;
  Name: string;
  Body?: string | null;
  NamespacePrefix?: string | null;
  LastModifiedDate?: string | null;
  ApiVersion?: number | string | null;
  Status?: string | null;
}

interface ToolingTriggerRow extends ToolingClassRow {
  TableEnumOrId?: string | null;
}

const APEX_CLASS_SOQL =
  "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, ApiVersion, Status FROM ApexClass";
/** Light listing (no Body) used to find local/managed name collisions before
 *  the body drain starts. */
const APEX_CLASS_NAMES_SOQL = "SELECT Name, NamespacePrefix FROM ApexClass";
const APEX_TRIGGER_SOQL =
  "SELECT Id, Name, Body, NamespacePrefix, LastModifiedDate, ApiVersion, Status, TableEnumOrId FROM ApexTrigger";

/**
 * Build the minimal `<*MetaXml>` envelope the parser would otherwise get
 * from `force-app/.../<Name>.cls-meta.xml`. Keeps apiVersion + Status from
 * the Tooling row available to the parser via the standard metaXml input
 * channel — without this, live-ingested Apex nodes always had
 * apiVersion: null, while filesystem-ingested ones had the real value.
 */
function buildApexMetaXml(
  outerTag: "ApexClass" | "ApexTrigger",
  row: ToolingClassRow,
  shadowsManaged: string[] = [],
): string | undefined {
  const av = row.ApiVersion;
  const status = row.Status;
  if (av == null && !status && shadowsManaged.length === 0) return undefined;
  const parts: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<${outerTag}>`];
  if (av != null) parts.push(`  <apiVersion>${String(av)}</apiVersion>`);
  if (status) parts.push(`  <status>${status}</status>`);
  // sfgraph extension (not a Salesforce field): managed-package namespaces
  // whose same-named class this local class shadows in the graph.
  for (const ns of shadowsManaged) parts.push(`  <shadowsManaged>${ns}</shadowsManaged>`);
  parts.push(`</${outerTag}>`);
  return parts.join("\n");
}

/**
 * Local-vs-managed name collisions, keyed by lower-cased class name (qnames
 * are `ApexClass:<Name>` COLLATE NOCASE, with no namespace, so a local class
 * and a managed class of the same name are ONE node).
 */
interface ApexNameIndex {
  /** lower-cased names that have a local (NamespacePrefix null) class */
  local: Set<string>;
  /** lower-cased name -> managed namespaces carrying that name */
  managed: Map<string, Set<string>>;
}

function indexApexNames(
  rows: Array<Pick<ToolingClassRow, "Name" | "NamespacePrefix">>,
): ApexNameIndex {
  const idx: ApexNameIndex = { local: new Set(), managed: new Map() };
  for (const r of rows) {
    if (!r?.Name) continue;
    const key = r.Name.toLowerCase();
    if (!r.NamespacePrefix) idx.local.add(key);
    else {
      const set = idx.managed.get(key) ?? new Set<string>();
      set.add(r.NamespacePrefix);
      idx.managed.set(key, set);
    }
  }
  return idx;
}

/** Body to emit: managed-package bodies are redacted by the org, so they are
 *  stubbed to "" unless SFGRAPH_INCLUDE_MANAGED=1. */
function includeManagedBodies(): boolean {
  return process.env.SFGRAPH_INCLUDE_MANAGED === "1";
}

function stubBody(r: ToolingClassRow, includeManaged: boolean): string {
  return r.NamespacePrefix && !includeManaged ? "" : (r.Body ?? "");
}

/** The RawMember shape for an ApexClass / ApexTrigger row. Shared by
 *  {@link iterApex} and {@link iterOne} so both produce byte-identical
 *  content (and therefore the same node hash). */
function apexMember(
  type: "ApexClass" | "ApexTrigger",
  r: ToolingClassRow,
  includeManaged: boolean,
  shadows: string[] = [],
): RawMember {
  return {
    ref: {
      category:
        type === "ApexClass" ? METADATA_CATEGORY.APEX_CLASS : METADATA_CATEGORY.APEX_TRIGGER,
      memberType: type,
      memberName: r.Name,
      lastModifiedAt: r.LastModifiedDate ?? null,
      sourceUri: `sf://tooling/${type}/${r.Name}`,
      namespace: r.NamespacePrefix ?? null,
    },
    // JSON envelope so adaptParserInput can forward metaXml (containing
    // apiVersion + Status) alongside the body. Plain-body content from
    // the filesystem path still parses correctly via the adapter's
    // shape detection.
    content: JSON.stringify({
      body: stubBody(r, includeManaged),
      metaXml: buildApexMetaXml(type, r, shadows),
      ...(r.NamespacePrefix && !includeManaged ? { managed: true } : {}),
    }),
  };
}

/** Options for {@link iterApex} (page-fetch retry tuning; tests pass
 *  `retryBackoffMs: 0`). */
export type IterApexOptions = RetryOptions;

/**
 * Drain a Tooling SOQL query across ALL pages. `conn.tooling.query` returns at
 * most one page (200 rows); without following `nextRecordsUrl` via `queryMore`
 * the extractor silently capped Apex at the first 200 members — on a large org
 * (7k+ classes) that dropped ~97% of the source, and that first page is
 * dominated by managed-package classes whose body is stubbed, so almost
 * nothing parsed. Streams rows so we never hold the whole (body-heavy) result
 * set in memory at once. Each page fetch is re-tried with backoff; a page that
 * still fails throws "drain truncated after N rows" (see retry.ts).
 */
function drainToolingQuery<T>(
  conn: any,
  soql: string,
  label: string,
  opts: IterApexOptions,
): AsyncIterable<T> {
  return drainSoqlPages<T>(conn.tooling, soql, label, scheduleQuery, opts);
}

export async function* iterApex(
  conn: any,
  options: IterApexOptions = {},
): AsyncIterable<RawMember> {
  const drainOpts = options;
  // For managed-package Apex, Body comes back redacted (empty / "(hidden)") —
  // parsing it produces nothing useful. We still emit the node (so calling
  // code's edges resolve to a real target) with an empty body, which the
  // parser turns into a bare node. Set SFGRAPH_INCLUDE_MANAGED=1 to keep the
  // redacted Body instead.
  const includeManaged = includeManagedBodies();

  // Classes and triggers are drained independently: a failure fetching one
  // must not drop the other (an unhandled jsforce rejection also crashes
  // node 24+, hence the per-stream try/catch). But a failure must NOT be
  // swallowed — a partial drain used to log "apex ✓" with skips=0 (large live org:
  // 3,600 of 7,662 classes). The first failure is re-thrown after both
  // streams ran, so the bulk-retrieve failSoft wrapper records an `apex` skip
  // while keeping every row already yielded.
  const failures: Error[] = [];

  // Local wins over managed (same name => same qname). A light Name /
  // NamespacePrefix listing tells us up front which names collide, so a
  // managed row is dropped whichever order the drain returns the rows in,
  // and the local row carries `shadowsManaged`. If the listing fails, the
  // drain still runs: managed rows are held back until the drain ends and
  // only emitted when no local class of that name was seen, and the
  // listing failure is surfaced with the others.
  let names: ApexNameIndex | null = null;
  try {
    names = indexApexNames(
      await querySoqlAll<ToolingClassRow>(
        conn.tooling,
        APEX_CLASS_NAMES_SOQL,
        "tooling ApexClass names",
        scheduleQuery,
        drainOpts,
      ),
    );
  } catch (e) {
    failures.push(e as Error);
  }
  const classMember = (r: ToolingClassRow, shadows: string[] = []): RawMember =>
    apexMember("ApexClass", r, includeManaged, shadows);
  const seenLocal = new Set<string>();
  const heldManaged: ToolingClassRow[] = [];
  let classDrainComplete = false;
  try {
    for await (const r of drainToolingQuery<ToolingClassRow>(
      conn,
      APEX_CLASS_SOQL,
      "tooling ApexClass",
      drainOpts,
    )) {
      const key = r.Name.toLowerCase();
      if (r.NamespacePrefix) {
        if (names?.local.has(key) || seenLocal.has(key)) continue; // shadowed
        if (!names) heldManaged.push(r);
        else yield classMember(r);
        continue;
      }
      seenLocal.add(key);
      yield classMember(r, [...(names?.managed.get(key) ?? [])].sort());
    }
    classDrainComplete = true;
  } catch (e) {
    failures.push(e as Error);
  }
  // Held managed rows (listing failed) are only safe to emit once the body
  // drain finished: after a truncated drain a local class of the same name
  // may sit on an unfetched page, and the managed stub would overwrite it
  // (review M1). The failure is re-thrown below, so the `apex` skip makes
  // `--retry-skipped` fetch them.
  if (classDrainComplete) {
    for (const r of heldManaged) {
      if (!seenLocal.has(r.Name.toLowerCase())) yield classMember(r);
    }
  }

  try {
    for await (const r of drainToolingQuery<ToolingTriggerRow>(
      conn,
      APEX_TRIGGER_SOQL,
      "tooling ApexTrigger",
      drainOpts,
    )) {
      yield apexMember("ApexTrigger", r, includeManaged);
    }
  } catch (e) {
    failures.push(e as Error);
  }

  if (failures.length > 0) {
    throw new Error(failures.map((f) => f.message).join("; "), { cause: failures[0] });
  }
}

/**
 * Re-fetch a single Apex member by name. Not called by the live ingest today
 * (incremental mode does not re-fetch content); kept on the public surface
 * (`iterOneApex`) and built with the same envelope as {@link iterApex} —
 * managed-body stub, metaXml and `shadowsManaged` — so adopting it cannot
 * flip a node's hash or drop the attribute (review M2).
 */
export async function iterOne(conn: any, name: string): Promise<RawMember | null> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const includeManaged = includeManagedBodies();
  const fetchRows = async (soql: string, type: "ApexClass" | "ApexTrigger") => {
    const res = (await scheduleQuery(() =>
      soqlWithTimeout(conn.tooling.query(soql), `tooling ${type} ${name}`),
    )) as { records?: ToolingClassRow[] } | null;
    return res?.records ?? [];
  };
  // Every class with this name (local + managed namespaces; at most a
  // handful). NULLS FIRST puts the local class first; the pick below does
  // not rely on the ordering.
  const classRows = await fetchRows(
    `${APEX_CLASS_SOQL} WHERE Name = '${escaped}' ORDER BY NamespacePrefix NULLS FIRST`,
    "ApexClass",
  );
  const local = classRows.find((r) => !r.NamespacePrefix);
  if (local) {
    const shadows = [
      ...new Set(classRows.map((r) => r.NamespacePrefix).filter((ns): ns is string => !!ns)),
    ].sort();
    return apexMember("ApexClass", local, includeManaged, shadows);
  }
  if (classRows[0]) return apexMember("ApexClass", classRows[0], includeManaged);
  const trig = (
    await fetchRows(`${APEX_TRIGGER_SOQL} WHERE Name = '${escaped}' LIMIT 1`, "ApexTrigger")
  )[0];
  return trig ? apexMember("ApexTrigger", trig, includeManaged) : null;
}
