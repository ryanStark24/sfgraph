import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { type GraphStore, type SnapshotStore, loadBetterSqlite3 } from "@ryanstark24/sfgraph-core";
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
  orgId: OrgId;
  /** Raw SQLite handle for cached analysis-table reads (optional). */
  db?: unknown;
}

export type ToolContextFactory = (opts: { orgId?: string }) => Promise<ToolContext>;

let factory: ToolContextFactory | null = null;

/**
 * Per-orgId cache so we reuse stores across tool calls. Bounded to
 * `CONTEXT_CACHE_MAX` entries — when full, the oldest entry is evicted
 * and its store is closed. Prevents unbounded file-handle / memory growth
 * when an agent rotates through many orgs.
 */
const CONTEXT_CACHE_MAX = 8;
const contextCache = new Map<string, ToolContext>();

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

function rememberInCache(key: string, ctx: ToolContext): void {
  // Evict oldest if full. Map preserves insertion order so the first key is
  // the oldest. fire-and-forget close — eviction must be synchronous w.r.t.
  // the cache state.
  while (contextCache.size >= CONTEXT_CACHE_MAX) {
    const oldestKey = contextCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = contextCache.get(oldestKey);
    contextCache.delete(oldestKey);
    if (oldest) void closeStoreQuietly(oldest);
  }
  contextCache.set(key, ctx);
}

export function setToolContextFactory(fn: ToolContextFactory | null): void {
  factory = fn;
  // Tests swap factories — clear cache so they don't see stale stores.
  contextCache.clear();
}

/**
 * Resolve a `ToolContext` for the given org. Validates the identifier,
 * caches the result by canonical orgId so repeated tool calls reuse the
 * same open stores instead of opening fresh handles each time.
 */
export async function getToolContext(opts: { orgId?: string } = {}): Promise<ToolContext> {
  if (!factory) {
    factory = defaultFactory;
  }
  const rawKey = opts.orgId ?? "default";
  // Always validate the user-supplied identifier at the entry point — even
  // when a test factory is installed — so security checks aren't bypassed.
  validateOrgIdentifier(rawKey);
  const cached = contextCache.get(rawKey);
  if (cached) return cached;
  const ctx = await factory(opts);
  // Cache by the raw key so repeated calls with the same alias / id reuse
  // the same store. The factory's own canonical-orgId resolution is still
  // applied inside ctx.orgId.
  rememberInCache(rawKey, ctx);
  return ctx;
}

/**
 * Close every cached store and clear the cache. Wired into shutdown handlers
 * so file handles aren't leaked when the MCP server exits. Idempotent.
 */
export async function closeAllContexts(): Promise<void> {
  const entries = [...contextCache.values()];
  contextCache.clear();
  for (const ctx of entries) {
    await closeStoreQuietly(ctx);
  }
}

/** Exposed for tests so they can assert the cache bound. */
export function _contextCacheSize(): number {
  return contextCache.size;
}

/**
 * Resolve an alias to the canonical orgId by scanning local `<orgId>.sqlite`
 * files for an `_sfgraph_orgs` row with `alias = ?`. Returns the orgId if
 * found, else `null`. Doing this BEFORE we build the DB path keeps the
 * on-disk file keyed by orgId (not by the user-supplied alias).
 */
async function resolveAliasToOrgId(dataDir: string, alias: string): Promise<string | null> {
  if (!existsSync(dataDir)) return null;
  let files: string[] = [];
  try {
    files = readdirSync(dataDir).filter((f) => f.endsWith(".sqlite") && !f.startsWith("backups"));
  } catch {
    return null;
  }
  const { createRequire } = await import("node:module");
  const nodeRequire = createRequire(import.meta.url);
  let Database: unknown;
  try {
    Database = loadBetterSqlite3(nodeRequire);
  } catch {
    return null;
  }
  const Ctor = Database as new (
    p: string,
    o?: unknown,
  ) => {
    prepare: (s: string) => { get: (a: string) => unknown };
    close: () => void;
  };
  for (const f of files) {
    const candidate = f.replace(/\.sqlite$/, "");
    if (!isSalesforceOrgId(candidate)) {
      continue; // skip files whose name isn't a real orgId
    }
    const dbPath = path.join(dataDir, f);
    try {
      const db = new Ctor(dbPath, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare("SELECT id FROM _sfgraph_orgs WHERE alias = ?").get(alias) as
          | { id: string }
          | undefined;
        if (row?.id) return row.id;
      } finally {
        db.close();
      }
    } catch {
      // ignore unreadable / non-sfgraph dbs
    }
  }
  return null;
}

/**
 * Try to resolve an alias to an orgId via the `sf` CLI's authenticated
 * orgs. Used as a fallback so a freshly-authenticated alias that has never
 * been ingested still works without silently creating an empty DB keyed by
 * the alias string.
 */
async function resolveAliasViaSfCli(alias: string): Promise<string | null> {
  try {
    const core = await import("@ryanstark24/sfgraph-core");
    const resolved = await core.resolveOrg(alias);
    if (resolved?.orgId && isSalesforceOrgId(String(resolved.orgId))) {
      return String(resolved.orgId);
    }
  } catch {
    /* alias not known to sf CLI */
  }
  return null;
}

async function defaultFactory(opts: { orgId?: string }): Promise<ToolContext> {
  const orgIdOrAlias = opts.orgId ?? "default";
  // Hard-fail on malformed input BEFORE any path joinery.
  validateOrgIdentifier(orgIdOrAlias);
  const paths = getSfgraphPaths();

  // Resolve alias -> orgId up-front so the on-disk file is always
  // <dataDir>/<orgId>.sqlite, not <dataDir>/<alias>.sqlite.
  let resolvedOrgId = orgIdOrAlias;
  if (isSalesforceOrgId(orgIdOrAlias)) {
    resolvedOrgId = orgIdOrAlias;
  } else {
    const fromLocal = await resolveAliasToOrgId(paths.data, orgIdOrAlias);
    if (fromLocal) {
      validateOrgIdentifier(fromLocal);
      resolvedOrgId = fromLocal;
    } else {
      const fromSf = await resolveAliasViaSfCli(orgIdOrAlias);
      if (fromSf) {
        validateOrgIdentifier(fromSf);
        resolvedOrgId = fromSf;
      } else {
        // Unknown alias: no existing ingested DB and no sf-CLI binding. Reject
        // rather than silently creating an empty `<alias>.sqlite`.
        throw new SfgraphError(
          ErrorCode.E_INVALID_ORG_IDENTIFIER,
          `unknown org identifier '${orgIdOrAlias}': not a Salesforce 15/18-char orgId, no existing sfgraph DB has this alias, and the sf CLI does not recognise it. Run 'sf org login web --alias ${orgIdOrAlias}' and then 'sfgraph ingest --org ${orgIdOrAlias}' first.`,
        );
      }
    }
  }

  const dbPath = safeOrgDbPath(paths.data, resolvedOrgId);
  const { SqliteGraphStore, SqliteSnapshotStore } = await import("@ryanstark24/sfgraph-core");
  const graphStore = new SqliteGraphStore({ dbPath });
  await graphStore.init();
  const snapshotStore = new SqliteSnapshotStore({
    dbPath,
    db: (graphStore as unknown as { db: unknown }).db as never,
    skipMigrations: true,
  });
  await snapshotStore.init();
  const db = (graphStore as unknown as { db: unknown }).db;
  const ctx: ToolContext = { graphStore, snapshotStore, orgId: asOrgId(resolvedOrgId), db };
  return ctx;
}
