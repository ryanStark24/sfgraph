import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  type GraphStore,
  type SnapshotStore,
  type VectorStore,
  graphFileReadiness,
  loadBetterSqlite3,
} from "@ryanstark24/sfgraph-core";
import {
  ErrorCode,
  type OrgId,
  SfgraphError,
  asOrgId,
  getSfgraphPaths,
  safeOrgDbPath,
  validateOrgIdentifier,
} from "@ryanstark24/sfgraph-shared";

export interface ToolContext {
  graphStore: GraphStore;
  snapshotStore: SnapshotStore;
  /** Shares the same SQLite handle as graphStore, so it doesn't double up
   *  file descriptors. Optional because test factories build minimal
   *  contexts without it; tools that need it (e.g. find_similar) check
   *  for presence. Null at runtime when vec0 / sqlite-vec failed to load
   *  on this Node ABI. */
  vectorStore?: VectorStore | null;
  orgId: OrgId;
  /** Raw SQLite handle for cached analysis-table reads (optional). */
  db?: unknown;
}

export type ToolContextFactory = (opts: { orgId?: string }) => Promise<ToolContext>;

let factory: ToolContextFactory | null = null;

/**
 * Per-org cache so we reuse stores across tool calls. Bounded to
 * `CONTEXT_CACHE_MAX` entries — when full, the oldest entry is evicted
 * and its store is closed (deferred while a tool call still holds a lease
 * on it, see `runWithContextLeases`). Prevents unbounded file-handle /
 * memory growth when an agent rotates through many orgs.
 *
 * Keyed by the RESOLVED canonical `ctx.orgId` (audit rel-04): an alias and
 * the orgId of the same DB share one open store. `keyIndex` remembers which
 * canonical key each user-supplied spelling resolved to.
 */
const CONTEXT_CACHE_MAX = 8;
interface CacheEntry {
  ctx: ToolContext;
  /** Number of in-flight tool calls currently holding this context. */
  leases: number;
  /** Evicted from the cache while leased: close when the last lease ends. */
  closePending: boolean;
  /** SQLite file backing the context and its `dev:ino` when opened (review I2). */
  dbFile: { path: string; id: string } | null;
}
const contextCache = new Map<string, CacheEntry>();
const keyIndex = new Map<string, string>();
/** In-flight builds keyed by the raw user key (audit rel-03). */
const inFlight = new Map<string, Promise<CacheEntry>>();
/** Per-tool-call lease scope (set of entries leased by the current call). */
/** Value: the org's sync generation when the call first leased it (T15 R2-1). */
const leaseScope = new AsyncLocalStorage<Map<CacheEntry, number | null>>();

/**
 * Salesforce Organization IDs start with the `00D` key-prefix and are
 * 15 or 18 chars total. We use this regex (rather than naked string length)
 * to decide whether a user-supplied identifier is an orgId or an alias —
 * a 15/18-char alias would otherwise be misclassified.
 */
const SF_ORG_ID_RE = /^00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

function isSalesforceOrgId(s: string): boolean {
  return SF_ORG_ID_RE.test(s);
}

async function closeStoreQuietly(ctx: ToolContext): Promise<void> {
  try {
    await (ctx.graphStore as unknown as { close?: () => Promise<void> | void }).close?.();
  } catch {
    // best-effort
  }
}

function evict(key: string): void {
  const entry = contextCache.get(key);
  contextCache.delete(key);
  for (const [raw, canonical] of keyIndex) {
    if (canonical === key) keyIndex.delete(raw);
  }
  if (!entry) return;
  // Never close a store an in-flight tool call is still using (audit rel-04):
  // defer until its last lease is released.
  if (entry.leases > 0) entry.closePending = true;
  else void closeStoreQuietly(entry.ctx);
}

function rememberInCache(key: string, entry: CacheEntry): void {
  // Evict oldest if full. Map preserves insertion order so the first key is
  // the oldest. Eviction must be synchronous w.r.t. the cache state.
  while (contextCache.size >= CONTEXT_CACHE_MAX) {
    const oldestKey = contextCache.keys().next().value;
    if (oldestKey === undefined) break;
    evict(oldestKey);
  }
  contextCache.set(key, entry);
}

/**
 * Put a freshly built context into the cache under its canonical orgId. If
 * another spelling of the same org (alias vs orgId) is already cached, the
 * duplicate store is closed and the cached one is reused.
 */
function adopt(rawKey: string, ctx: ToolContext): CacheEntry {
  const canonical = String(ctx.orgId);
  const existing = contextCache.get(canonical);
  if (existing) {
    if (existing.ctx !== ctx && existing.ctx.graphStore !== ctx.graphStore) {
      void closeStoreQuietly(ctx);
    }
    keyIndex.set(rawKey, canonical);
    return existing;
  }
  const entry: CacheEntry = { ctx, leases: 0, closePending: false, dbFile: dbFileOf(ctx) };
  rememberInCache(canonical, entry);
  keyIndex.set(rawKey, canonical);
  keyIndex.set(canonical, canonical);
  return entry;
}

function fileId(p: string): string | null {
  try {
    const st = statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** The on-disk file a context reads, from its shared SQLite handle. */
function dbFileOf(ctx: ToolContext): CacheEntry["dbFile"] {
  const handle = (ctx.db ?? (ctx.graphStore as unknown as { db?: unknown }).db) as
    | { name?: unknown }
    | undefined;
  const p = typeof handle?.name === "string" ? handle.name : "";
  if (!p || p === ":memory:") return null;
  const id = fileId(p);
  return id ? { path: p, id } : null;
}

/**
 * review I2: `ingest --rebuild` renames the DB away and writes a new file; the
 * cached handles still point at the old inode (whose data_version never moves
 * again). True when the path now names a different file.
 */
function fileSwapped(entry: CacheEntry): boolean {
  if (!entry.dbFile) return false;
  const now = fileId(entry.dbFile.path);
  return now !== null && now !== entry.dbFile.id;
}

/** review R1-1: the swapped-in file has finished building (core's readiness rule). */
function newFileReady(entry: CacheEntry): boolean {
  if (!entry.dbFile) return true;
  return graphFileReadiness(entry.dbFile.path, String(entry.ctx.orgId)).ready;
}

function lease(entry: CacheEntry): void {
  const scope = leaseScope.getStore();
  if (!scope || scope.has(entry)) return;
  scope.set(entry, syncStatusOf(entry)?.generation ?? null);
  entry.leases += 1;
}

function syncStatusOf(
  entry: CacheEntry,
): { generation: number; in_progress: boolean; started_at: string | null } | null {
  try {
    return entry.ctx.graphStore.getSyncStatus(entry.ctx.orgId);
  } catch {
    return null;
  }
}

/**
 * T15 R2-1: warnings for the contexts the current tool call read. A call that
 * read an org while a sync of it is in progress, while a rebuild of its file is
 * still being built (the call answered from the previous graph), or across a
 * sync that completed mid-call gets one line per such org, so no partial or
 * stale answer is silent. Empty outside a lease scope.
 */
export function leasedSyncWarnings(): string[] {
  const scope = leaseScope.getStore();
  if (!scope) return [];
  const out: string[] = [];
  for (const [entry, genAtLease] of scope) {
    const org = String(entry.ctx.orgId);
    if (fileSwapped(entry) && !newFileReady(entry)) {
      out.push(
        `WARNING: a rebuild of org ${org} is in progress; this answer comes from the previous graph and may be out of date.`,
      );
      continue;
    }
    const st = syncStatusOf(entry);
    if (!st) continue;
    if (st.in_progress) {
      out.push(
        `WARNING: a sync of org ${org} is in progress${st.started_at ? ` (started ${st.started_at})` : ""}; this answer may be partial. Re-run once it completes.`,
      );
    } else if (genAtLease !== null && st.generation !== genAtLease) {
      out.push(
        `WARNING: org ${org} was re-synced during this call; parts of this answer may predate the sync. Re-run for a consistent answer.`,
      );
    }
  }
  return out;
}

/**
 * Run one tool call inside a lease scope: every context it obtains through
 * `getToolContext` is protected from being closed by cache eviction until
 * `fn` settles. The MCP dispatcher wraps each tool call in this.
 */
export async function runWithContextLeases<T>(fn: () => Promise<T>): Promise<T> {
  const scope = new Map<CacheEntry, number | null>();
  try {
    return await leaseScope.run(scope, fn);
  } finally {
    for (const entry of scope.keys()) {
      entry.leases -= 1;
      if (entry.leases <= 0 && entry.closePending) {
        entry.closePending = false;
        void closeStoreQuietly(entry.ctx);
      }
    }
  }
}

export function setToolContextFactory(fn: ToolContextFactory | null): void {
  factory = fn;
  // Tests swap factories — clear cache so they don't see stale stores.
  contextCache.clear();
  keyIndex.clear();
  inFlight.clear();
}

/**
 * Resolve a `ToolContext` for the given org. Validates the identifier,
 * caches the result by canonical orgId so repeated tool calls reuse the
 * same open stores instead of opening fresh handles each time. Concurrent
 * first calls for the same key share one in-flight build.
 */
export async function getToolContext(opts: { orgId?: string } = {}): Promise<ToolContext> {
  if (!factory) {
    factory = defaultFactory;
  }
  const rawKey = opts.orgId ?? "default";
  // Always validate the user-supplied identifier at the entry point — even
  // when a test factory is installed — so security checks aren't bypassed.
  validateOrgIdentifier(rawKey);
  const cachedKey = keyIndex.get(rawKey) ?? rawKey;
  const cached = contextCache.get(cachedKey);
  if (cached && fileSwapped(cached) && newFileReady(cached)) {
    // Rebuild swapped the file and finished: drop the stale stores (closed
    // once unleased) and build a fresh context on the new file.
    evict(cachedKey);
  } else if (cached) {
    // review R1-1: a swapped file that is still being built is not adopted;
    // the old inode stays readable (POSIX, even after unlink), so tools keep
    // answering from the complete old graph until the rebuild finishes.
    lease(cached);
    return cached.ctx;
  }
  let pending = inFlight.get(rawKey);
  if (!pending) {
    const build = factory;
    const p = build(opts).then((ctx) => adopt(rawKey, ctx));
    pending = p;
    inFlight.set(rawKey, p);
    const clear = () => {
      if (inFlight.get(rawKey) === p) inFlight.delete(rawKey);
    };
    p.then(clear, clear);
  }
  const entry = await pending;
  lease(entry);
  return entry.ctx;
}

/**
 * Close every cached store and clear the cache. Wired into shutdown handlers
 * so file handles aren't leaked when the MCP server exits. Idempotent.
 */
export async function closeAllContexts(): Promise<void> {
  const entries = [...contextCache.values()];
  contextCache.clear();
  keyIndex.clear();
  for (const entry of entries) {
    entry.closePending = false;
    await closeStoreQuietly(entry.ctx);
  }
}

/** Exposed for tests so they can assert the cache bound. */
export function _contextCacheSize(): number {
  return contextCache.size;
}

const nodeRequire = createRequire(import.meta.url);

type ReadonlyDb = {
  prepare: (s: string) => {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
  close: () => void;
};

function openReadonly(dbPath: string): ReadonlyDb | null {
  try {
    const Ctor = loadBetterSqlite3(nodeRequire) as unknown as new (
      p: string,
      o?: unknown,
    ) => ReadonlyDb;
    return new Ctor(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/**
 * Check that `dbPath` is a real sfgraph graph without writing to it (audit
 * rel-06): a 0-byte file, a non-SQLite file, or a SQLite file with no
 * `_sfgraph_orgs` row is "not ingested", never something to migrate into an
 * empty graph. Returns null when valid, else the reason.
 */
function invalidGraphReason(dbPath: string): string | null {
  let size = 0;
  try {
    size = statSync(dbPath).size;
  } catch {
    return "the file cannot be read";
  }
  if (size === 0) return "the file is empty (0 bytes; interrupted copy or restore?)";
  const db = openReadonly(dbPath);
  if (!db) return "the file is not a readable SQLite database";
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM _sfgraph_orgs").get() as
      | { n: number }
      | undefined;
    if (!row || Number(row.n) === 0) return "it has no _sfgraph_orgs row";
    return null;
  } catch {
    return "it is not an sfgraph graph (no _sfgraph_orgs table)";
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

interface RegisteredOrg {
  orgId: string;
  alias: string | null;
}

/**
 * Read the local org registry: one entry per `<orgId>.sqlite` in the data dir
 * that has an `_sfgraph_orgs` row. Read-only; unreadable / non-sfgraph files
 * are skipped. Never touches the sf CLI or keychain.
 */
function readOrgRegistry(dataDir: string): RegisteredOrg[] {
  if (!existsSync(dataDir)) return [];
  let files: string[] = [];
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith(".sqlite") && !f.startsWith("backups"));
  } catch {
    return [];
  }
  const out: RegisteredOrg[] = [];
  for (const f of files) {
    const candidate = f.replace(/\.sqlite$/, "");
    if (!isSalesforceOrgId(candidate)) continue; // skip files whose name isn't a real orgId
    const dbPath = path.join(dataDir, f);
    try {
      if (statSync(dbPath).size === 0) continue;
    } catch {
      continue;
    }
    const db = openReadonly(dbPath);
    if (!db) continue;
    try {
      const rows = db.prepare("SELECT id, alias FROM _sfgraph_orgs").all() as Array<{
        id: string;
        alias: string | null;
      }>;
      for (const r of rows) {
        if (r?.id) out.push({ orgId: String(r.id), alias: r.alias ? String(r.alias) : null });
      }
    } catch {
      // ignore unreadable / non-sfgraph dbs
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  return out;
}

/**
 * Resolve an alias against the local registry so the on-disk file stays
 * keyed by orgId (not by the user-supplied alias). Exact match first, then
 * case-insensitive (audit tools-23). Throws when a case-insensitive match is
 * ambiguous across different orgs.
 */
function matchAlias(registry: RegisteredOrg[], alias: string): string | null {
  const exact = registry.find((r) => r.alias === alias);
  if (exact) return exact.orgId;
  const lower = alias.toLowerCase();
  const ci = [
    ...new Set(registry.filter((r) => r.alias?.toLowerCase() === lower).map((r) => r.orgId)),
  ];
  if (ci.length === 1) return ci[0] ?? null;
  if (ci.length > 1) {
    throw new SfgraphError(
      ErrorCode.E_INVALID_ORG_IDENTIFIER,
      `ambiguous org alias '${alias}': it matches several ingested orgs case-insensitively (${ci.join(", ")}). Pass the exact alias or the orgId.`,
    );
  }
  return null;
}

/**
 * sf-CLI aliases captured by `sfgraph install` / `sfgraph refresh-orgs` in
 * `<dataDir>/orgs-snapshot.json` (alias -> username -> orgId). A plain JSON
 * read: no AuthInfo, no keychain.
 */
function readSnapshotAliases(dataDir: string): RegisteredOrg[] {
  try {
    const p = path.join(dataDir, "orgs-snapshot.json");
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      aliases?: Record<string, unknown>;
      authorizations?: Record<string, { orgId?: unknown }>;
    };
    const out: RegisteredOrg[] = [];
    for (const [alias, username] of Object.entries(raw.aliases ?? {})) {
      if (typeof username !== "string") continue;
      const orgId = raw.authorizations?.[username]?.orgId;
      if (typeof orgId === "string" && isSalesforceOrgId(orgId)) out.push({ orgId, alias });
    }
    return out;
  } catch {
    return [];
  }
}

function describeRegistry(registry: RegisteredOrg[]): string {
  if (registry.length === 0) return "No org has been ingested yet.";
  const names = registry.map((r) => (r.alias ? `${r.alias} (${r.orgId})` : r.orgId));
  return `Registered aliases: ${names.join(", ")}.`;
}

/**
 * Opt-in (SFGRAPH_ALIAS_SF_FALLBACK=1|true): consult the sf CLI's auth files
 * (@salesforce/core). Off by default because @salesforce/core can block on a
 * macOS keychain prompt (audit tools-09). Shared by alias resolution and
 * list_orgs.
 */
export function sfAliasFallbackEnabled(): boolean {
  const v = process.env.SFGRAPH_ALIAS_SF_FALLBACK;
  return v === "1" || v === "true";
}

const DEFAULT_ALIAS_RESOLVE_TIMEOUT_MS = 5000;

/** SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS, default 5000. */
export function aliasResolveTimeoutMs(): number {
  const n = Number(process.env.SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ALIAS_RESOLVE_TIMEOUT_MS;
}

/**
 * Race `work` against the sf-CLI timeout. Resolves to the value, or to the
 * string "timeout" (the abandoned call keeps running but can't hang the
 * caller; the timer is unref'd so it never holds the process open).
 */
export async function withSfCliTimeout<T>(
  work: () => Promise<T>,
  ms: number = aliasResolveTimeoutMs(),
): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(work), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Opt-in fallback: resolve an alias through the sf CLI's authenticated orgs,
 * bounded by the timeout above; a timeout is an error, never a hang.
 */
async function resolveAliasViaSfCli(alias: string): Promise<string | null> {
  const core = await import("@ryanstark24/sfgraph-core");
  const ms = aliasResolveTimeoutMs();
  const out = await withSfCliTimeout(
    () =>
      core.resolveOrg(alias).then(
        (resolved) =>
          resolved?.orgId && isSalesforceOrgId(String(resolved.orgId))
            ? String(resolved.orgId)
            : null,
        () => null, // alias not known to sf CLI
      ),
    ms,
  );
  if (out === "timeout") {
    throw new SfgraphError(
      ErrorCode.E_INVALID_ORG_IDENTIFIER,
      `resolving org alias '${alias}' through the sf CLI timed out after ${ms} ms (a keychain prompt may be blocking). Pass the orgId instead.`,
    );
  }
  return out;
}

async function defaultFactory(opts: { orgId?: string }): Promise<ToolContext> {
  const orgIdOrAlias = opts.orgId ?? "default";
  // Hard-fail on malformed input BEFORE any path joinery.
  validateOrgIdentifier(orgIdOrAlias);
  const paths = getSfgraphPaths();

  // Resolve alias -> orgId up-front so the on-disk file is always
  // <dataDir>/<orgId>.sqlite, not <dataDir>/<alias>.sqlite. The local
  // registry is consulted first and an unknown alias fails fast, before any
  // sf-CLI / AuthInfo / keychain access (audit tools-09).
  let resolvedOrgId = orgIdOrAlias;
  if (!isSalesforceOrgId(orgIdOrAlias)) {
    const registry = readOrgRegistry(paths.data);
    let found =
      matchAlias(registry, orgIdOrAlias) ??
      matchAlias(readSnapshotAliases(paths.data), orgIdOrAlias);
    if (!found && sfAliasFallbackEnabled()) {
      found = await resolveAliasViaSfCli(orgIdOrAlias);
    }
    if (!found) {
      // Reject rather than silently creating an empty `<alias>.sqlite`.
      throw new SfgraphError(
        ErrorCode.E_INVALID_ORG_IDENTIFIER,
        `unknown org alias '${orgIdOrAlias}': it is not a Salesforce 15/18-char orgId and no ingested sfgraph org has this alias. ${describeRegistry(registry)} Call list_orgs to see ingested orgs, or run 'sfgraph ingest --org ${orgIdOrAlias}' first.`,
      );
    }
    validateOrgIdentifier(found);
    resolvedOrgId = found;
  }

  const dbPath = safeOrgDbPath(paths.data, resolvedOrgId);
  // A syntactically-valid orgId that was never ingested has no DB file. Opening
  // it would CREATE an empty SQLite, and every graph-backed tool would then
  // return a confident empty answer ("no risks", "no dead code", "0 nodes")
  // instead of "this org isn't ingested." Reject up-front. (The alias path above
  // already rejects unknown aliases; this catches the valid-orgId case.)
  if (!existsSync(dbPath)) {
    throw new SfgraphError(
      ErrorCode.E_INVALID_ORG_IDENTIFIER,
      `org '${orgIdOrAlias}' (orgId ${resolvedOrgId}) has not been ingested — no graph exists at ${dbPath}. Run 'sfgraph ingest --org ${orgIdOrAlias}' first. (Tools read the local graph; they never create one.)`,
    );
  }
  const invalid = invalidGraphReason(dbPath);
  if (invalid) {
    throw new SfgraphError(
      ErrorCode.E_INVALID_ORG_IDENTIFIER,
      `org '${orgIdOrAlias}' (orgId ${resolvedOrgId}) has no usable graph at ${dbPath}: ${invalid}. Re-run 'sfgraph ingest --org ${orgIdOrAlias}'. (Tools never create or re-ingest a graph. Opening one applies pending schema migrations and rebuilds the indexes of an interrupted rebuild whose owner process is gone on this host; nothing else is repaired.)`,
    );
  }
  const { SqliteGraphStore, SqliteSnapshotStore, SqliteVectorStore } = await import(
    "@ryanstark24/sfgraph-core"
  );
  // review R1-2: never swap files under one context; getToolContext evicts
  // the whole context (graph, snapshot and vector stores together) instead.
  const graphStore = new SqliteGraphStore({ dbPath, fileCheckIntervalMs: -1 });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: unknown }).db as never,
    skipMigrations: true,
  });
  await snapshotStore.init();
  const db = (graphStore as unknown as { db: unknown }).db;
  // VectorStore reuses the GraphStore's SQLite handle (skipMigrations:true —
  // GraphStore's migration runner already created the vec0 tables) and
  // loads the sqlite-vec extension on this connection so MATCH queries work.
  // If sqlite-vec isn't available (e.g. native-binding install skipped),
  // null out and let tools surface "no vector index" instead of crashing.
  let vectorStore: VectorStore | null = null;
  try {
    const vs = new SqliteVectorStore({
      dbPath,
      db: (graphStore as unknown as { db: unknown }).db as never,
      skipMigrations: true,
    });
    await vs.init();
    vectorStore = vs;
  } catch {
    vectorStore = null;
  }
  const ctx: ToolContext = {
    graphStore,
    snapshotStore,
    vectorStore,
    orgId: asOrgId(resolvedOrgId),
    db,
  };
  return ctx;
}
