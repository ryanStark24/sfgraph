import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { GraphStore, SnapshotStore } from "@ryanstark24/sfgraph-core";
import {
  type OrgId,
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

/** Per-orgId cache so we reuse stores across tool calls. */
const contextCache = new Map<string, ToolContext>();

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
  contextCache.set(rawKey, ctx);
  return ctx;
}

/**
 * Close every cached store and clear the cache. Wired into shutdown handlers
 * so file handles aren't leaked when the MCP server exits.
 */
export async function closeAllContexts(): Promise<void> {
  const entries = [...contextCache.values()];
  contextCache.clear();
  for (const ctx of entries) {
    try {
      await (ctx.graphStore as unknown as { close?: () => Promise<void> | void }).close?.();
    } catch {
      // best-effort
    }
  }
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
    Database = nodeRequire("better-sqlite3");
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
    try {
      validateOrgIdentifier(candidate);
    } catch {
      continue; // skip files that aren't valid org ids
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

async function defaultFactory(opts: { orgId?: string }): Promise<ToolContext> {
  const orgIdOrAlias = opts.orgId ?? "default";
  // Hard-fail on malformed input BEFORE any path joinery.
  validateOrgIdentifier(orgIdOrAlias);
  const paths = getSfgraphPaths();

  // Resolve alias -> orgId up-front so the on-disk file is always
  // <dataDir>/<orgId>.sqlite, not <dataDir>/<alias>.sqlite.
  let resolvedOrgId = orgIdOrAlias;
  const looksLikeId = orgIdOrAlias.length === 15 || orgIdOrAlias.length === 18;
  if (!looksLikeId) {
    const found = await resolveAliasToOrgId(paths.data, orgIdOrAlias);
    if (found) {
      validateOrgIdentifier(found);
      resolvedOrgId = found;
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
