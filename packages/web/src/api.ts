import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { type GraphStore, REL_TYPES, SqliteGraphStore } from "@ryanstark24/sfgraph-core";
import { asOrgId, asQualifiedName, getSfgraphPaths } from "@ryanstark24/sfgraph-shared";

/** Per-orgId open-store cache. Web server reuses stores across requests. */
const stores = new Map<string, GraphStore>();

async function getStore(orgId: string): Promise<GraphStore> {
  const cached = stores.get(orgId);
  if (cached) return cached;
  const { data } = getSfgraphPaths();
  const dbPath = path.join(data, `${orgId}.sqlite`);
  if (!existsSync(dbPath)) {
    throw new Error(`no ingested graph for org '${orgId}' (expected ${dbPath})`);
  }
  const store = new SqliteGraphStore({ dbPath });
  await store.init();
  stores.set(orgId, store);
  return store;
}

export async function closeAllStores(): Promise<void> {
  for (const s of stores.values()) {
    try {
      await s.close();
    } catch {
      /* best effort */
    }
  }
  stores.clear();
}

const SF_ORG_ID_RE = /^00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

export interface OrgListEntry {
  orgId: string;
  alias: string;
  apiVersion: string | null;
  lastSyncedAt: number | null;
  nodeCount: number;
  edgeCount: number;
}

/** Scan the data dir for `<orgId>.sqlite` files and pull metadata + counts.
 *  Reuses the per-org store cache so opening for the listing also primes the
 *  subsequent /api/search and /api/neighborhood calls.
 *
 *  Failures are logged to stderr (visible in the `sfgraph serve` terminal)
 *  AND attached to the response under `_errors` so the UI can surface them.
 *  Previously this swallowed errors silently, which made common failure
 *  modes (better-sqlite3 ABI mismatch, locked DB) look like "no orgs". */
export async function listOrgs(): Promise<{
  orgs: OrgListEntry[];
  errors: Array<{ orgId: string; error: string }>;
}> {
  const { data } = getSfgraphPaths();
  if (!existsSync(data)) {
    console.error(`sfgraph-web: data dir does not exist: ${data}`);
    return { orgs: [], errors: [{ orgId: "(data-dir)", error: `does not exist: ${data}` }] };
  }
  const files = readdirSync(data).filter(
    (f) => f.endsWith(".sqlite") && SF_ORG_ID_RE.test(f.replace(/\.sqlite$/, "")),
  );
  if (files.length === 0) {
    console.error(`sfgraph-web: no <orgId>.sqlite files in ${data}`);
    return {
      orgs: [],
      errors: [{ orgId: "(data-dir)", error: `no ingested orgs in ${data}` }],
    };
  }
  const out: OrgListEntry[] = [];
  const errors: Array<{ orgId: string; error: string }> = [];
  for (const f of files) {
    const orgId = f.replace(/\.sqlite$/, "");
    try {
      const store = await getStore(orgId);
      const oid = asOrgId(orgId);
      const org = store.getOrg(oid);
      out.push({
        orgId,
        alias: org?.alias ?? orgId,
        apiVersion: org?.apiVersion ?? null,
        lastSyncedAt: org?.lastSyncedAt ?? null,
        nodeCount: store.countNodes(oid),
        edgeCount: store.countEdges(oid),
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      console.error(`sfgraph-web: failed to open ${orgId}.sqlite — ${msg}`);
      errors.push({ orgId, error: msg });
    }
  }
  return {
    orgs: out.sort((a, b) => a.alias.localeCompare(b.alias)),
    errors,
  };
}

export interface SearchHit {
  qname: string;
  label: string;
}

/**
 * Minimum needle length. Single-character queries scan the whole graph and
 * match thousands of qnames — useless for autocomplete and a free DoS vector
 * on a large org.
 */
const SEARCH_MIN_QUERY_LEN = 2;

/**
 * Cap on qnames scanned per request. `listAllQnames` is O(N) across every
 * label table; on a 50k-node org this is multi-second per call. The cap
 * lets us short-circuit instead of locking the event loop.
 */
const SEARCH_MAX_SCAN = 25000;

/** Substring-match autocomplete over qnames. Returns at most `limit` hits. */
export async function search(orgId: string, q: string, limit = 25): Promise<SearchHit[]> {
  if (!q || q.length < SEARCH_MIN_QUERY_LEN) return [];
  const store = await getStore(orgId);
  const oid = asOrgId(orgId);
  const needle = q.toLowerCase();
  const all = store.listAllQnames(oid);
  const hits: SearchHit[] = [];
  let scanned = 0;
  for (const qn of all) {
    scanned++;
    if (scanned > SEARCH_MAX_SCAN) break;
    if (String(qn).toLowerCase().includes(needle)) {
      const node = store.getNode(oid, qn);
      hits.push({ qname: String(qn), label: node?.label ?? "Unknown" });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export interface GraphNode {
  id: string;
  label: string;
  attrs?: Record<string, unknown>;
}
export interface GraphEdge {
  source: string;
  target: string;
  relType: string;
}
export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated?: boolean;
}

/** Bidirectional BFS around a center node up to `depth` hops. */
export async function neighborhood(
  orgId: string,
  qname: string,
  depth: number,
  relTypes?: string[],
): Promise<GraphPayload> {
  const store = await getStore(orgId);
  const oid = asOrgId(orgId);
  const center = asQualifiedName(qname);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const allowedRels = relTypes && relTypes.length > 0 ? new Set(relTypes) : null;
  const NODE_CAP = 250;
  let truncated = false;

  const addNode = (qn: string): void => {
    if (nodes.has(qn)) return;
    const n = store.getNode(oid, asQualifiedName(qn));
    nodes.set(qn, { id: qn, label: n?.label ?? "Unknown" });
  };

  addNode(qname);
  let frontier: string[] = [qname];
  seen.add(qname);
  // Tight cap check: a single high-fan-out node (e.g. CustomObject:Account
  // has 1000+ field/permission edges) can blow past the limit inside one
  // frontier iteration if we only check at the top. Check after every
  // node add and break early.
  outer: for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      const outE = store.listEdgesFrom(oid, asQualifiedName(cur));
      const inE = store.listEdgesTo(oid, asQualifiedName(cur));
      for (const e of outE) {
        if (allowedRels && !allowedRels.has(String(e.relType))) continue;
        if (nodes.size >= NODE_CAP) {
          truncated = true;
          break outer;
        }
        const dst = String(e.dstQualifiedName);
        addNode(dst);
        edges.push({ source: cur, target: dst, relType: String(e.relType) });
        if (!seen.has(dst)) {
          seen.add(dst);
          next.push(dst);
        }
      }
      for (const e of inE) {
        if (allowedRels && !allowedRels.has(String(e.relType))) continue;
        if (nodes.size >= NODE_CAP) {
          truncated = true;
          break outer;
        }
        const src = String(e.srcQualifiedName);
        addNode(src);
        edges.push({ source: src, target: cur, relType: String(e.relType) });
        if (!seen.has(src)) {
          seen.add(src);
          next.push(src);
        }
      }
    }
    frontier = next;
  }
  return { nodes: [...nodes.values()], edges, truncated };
}

/** Pull every node matching one of `labels`, plus the edges among them.
 *  Capped at `limit` nodes to keep the browser from melting. */
export async function overview(
  orgId: string,
  labels: string[],
  limit = 1500,
): Promise<GraphPayload> {
  const store = await getStore(orgId);
  const oid = asOrgId(orgId);
  const nodes = new Map<string, GraphNode>();
  for (const lbl of labels) {
    const ns = store.listNodesByLabel(oid, lbl, limit);
    for (const n of ns) {
      if (nodes.size >= limit) break;
      nodes.set(String(n.qualifiedName), { id: String(n.qualifiedName), label: n.label });
    }
    if (nodes.size >= limit) break;
  }
  const edges: GraphEdge[] = [];
  // For overview, only emit edges where BOTH endpoints are in the node set.
  for (const qn of nodes.keys()) {
    const outE = store.listEdgesFrom(oid, asQualifiedName(qn));
    for (const e of outE) {
      const dst = String(e.dstQualifiedName);
      if (nodes.has(dst)) edges.push({ source: qn, target: dst, relType: String(e.relType) });
    }
  }
  return { nodes: [...nodes.values()], edges, truncated: nodes.size >= limit };
}

/**
 * Full-graph view: every node in the org (capped at `limit`) plus every
 * edge between visible nodes. Used by the "Render entire org" button in
 * the web UI — gives the Obsidian-style global view instead of the
 * per-label or per-trace subsets.
 *
 * We enumerate node-bearing labels rather than calling `listAllQnames`
 * because we want a stable label assignment for colouring without doing
 * one `getNode` per id.
 */
const ALL_KNOWN_LABELS: string[] = [
  "ApexClass",
  "ApexTrigger",
  "ApexMethod",
  "TestMethod",
  "ApexPage",
  "LightningComponentBundle",
  "LWC",
  "LWCBundle",
  "AuraDefinitionBundle",
  "Flow",
  "FlowVersion",
  "CustomObject",
  "CustomField",
  "Profile",
  "PermissionSet",
  "PermissionSetGroup",
  "SharingRule",
  "NamedCredential",
  "ExternalServiceRegistration",
  "StaticResource",
  "CustomLabel",
  "Workflow",
];

export async function fullGraph(orgId: string, limit = 5000): Promise<GraphPayload> {
  const store = await getStore(orgId);
  const oid = asOrgId(orgId);
  const nodes = new Map<string, GraphNode>();
  for (const lbl of ALL_KNOWN_LABELS) {
    if (nodes.size >= limit) break;
    const ns = store.listNodesByLabel(oid, lbl, limit);
    for (const n of ns) {
      if (nodes.size >= limit) break;
      nodes.set(String(n.qualifiedName), { id: String(n.qualifiedName), label: n.label });
    }
  }
  // All edges where both endpoints are in our node set.
  const edges: GraphEdge[] = [];
  for (const qn of nodes.keys()) {
    const outE = store.listEdgesFrom(oid, asQualifiedName(qn));
    for (const e of outE) {
      const dst = String(e.dstQualifiedName);
      if (nodes.has(dst)) {
        edges.push({ source: qn, target: dst, relType: String(e.relType) });
      }
    }
  }
  return { nodes: [...nodes.values()], edges, truncated: nodes.size >= limit };
}

/**
 * Schema view: CustomObjects as the centre, plus every node that touches
 * them — Apex that queries them, Flows that reference them, LWC bundles
 * that consume them. Surfaced rel types are the ones that meaningfully
 * connect to data:
 *
 *   - REFERENCES_OBJECT  (Flow / Apex / LWC → CustomObject)
 *   - EXECUTES_SOQL      (Apex → CustomObject via SOQL)
 *   - EXECUTES_DML       (Apex → CustomObject via insert/update/delete)
 *   - READS_FIELD / WRITES_FIELD (then we hop CustomField → its parent)
 *   - TRIGGER_FIRES_ON   (ApexTrigger → CustomObject)
 *
 * This is way more useful than the "CustomObject + CustomField + edges
 * between only those two" original — most orgs don't even store
 * CustomField nodes, and the only outgoing schema-relevant edges are
 * INCOMING to CustomObject from other layers.
 */
export async function schema(orgId: string, limit = 1500): Promise<GraphPayload> {
  const store = await getStore(orgId);
  const oid = asOrgId(orgId);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (qn: string, label: string): void => {
    if (nodes.size >= limit) return;
    if (!nodes.has(qn)) nodes.set(qn, { id: qn, label });
  };

  // Seed with every CustomObject in the org.
  for (const n of store.listNodesByLabel(oid, "CustomObject", limit)) {
    addNode(String(n.qualifiedName), n.label);
  }
  // Also include CustomField if the org has them (some extraction profiles
  // produce field-level nodes, others don't).
  for (const n of store.listNodesByLabel(oid, "CustomField", limit)) {
    addNode(String(n.qualifiedName), n.label);
  }

  const wantedRels = new Set([
    REL_TYPES.REFERENCES_OBJECT,
    REL_TYPES.REFERENCES,
    REL_TYPES.EXECUTES_SOQL,
    REL_TYPES.EXECUTES_DML,
    REL_TYPES.EXECUTES_SOSL,
    REL_TYPES.READS_FIELD,
    REL_TYPES.WRITES_FIELD,
    REL_TYPES.TRIGGER_FIRES_ON,
    REL_TYPES.DEFINES_FIELD,
    REL_TYPES.CONTAINS,
  ] as string[]);

  // For each schema-y node, follow INCOMING edges to find consumers. This is
  // the load-bearing change — most schema relationships are stored as
  // (consumer → CustomObject), so we have to listEdgesTo, not From.
  const schemaSeeds = [...nodes.keys()];
  for (const qn of schemaSeeds) {
    if (nodes.size >= limit) break;
    const inE = store.listEdgesTo(oid, asQualifiedName(qn));
    for (const e of inE) {
      if (!wantedRels.has(String(e.relType))) continue;
      const src = String(e.srcQualifiedName);
      const srcNode = store.getNode(oid, asQualifiedName(src));
      addNode(src, srcNode?.label ?? "Unknown");
      edges.push({ source: src, target: qn, relType: String(e.relType) });
    }
    // Outgoing too (CustomField → CustomObject lookups, when present).
    const outE = store.listEdgesFrom(oid, asQualifiedName(qn));
    for (const e of outE) {
      if (!wantedRels.has(String(e.relType))) continue;
      const dst = String(e.dstQualifiedName);
      const dstNode = store.getNode(oid, asQualifiedName(dst));
      addNode(dst, dstNode?.label ?? "Unknown");
      edges.push({ source: qn, target: dst, relType: String(e.relType) });
    }
  }
  return { nodes: [...nodes.values()], edges, truncated: nodes.size >= limit };
}

/** List the rel-types available in the current graph for filter UI. */
export const ALL_REL_TYPES: string[] = Object.values(REL_TYPES) as string[];

/** Validate that an orgId looks like a Salesforce id before we try to open. */
export function validOrgId(s: string): boolean {
  return SF_ORG_ID_RE.test(s);
}
