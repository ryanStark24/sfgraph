import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getSfgraphPaths } from "@ryanstark24/sfgraph-shared";

const nodeRequire = createRequire(import.meta.url);
import { defineTool, z } from "./_define.js";

const inputSchema = z.object({}).strict();

const DAY_MS = 1000 * 60 * 60 * 24;
const STALE_THRESHOLD_DAYS = 7;

interface AuthorizationRow {
  alias?: string | null;
  username?: string | null;
  orgId?: string | null;
  instanceUrl?: string | null;
}

interface ListOrgsDeps {
  loadSfCore?: () => Promise<{
    AuthInfo: {
      listAllAuthorizations: () => Promise<AuthorizationRow[]>;
    };
    ConfigAggregator?: unknown;
  }>;
  resolveDefaultOrgAlias?: () => Promise<string | null>;
  dataDir?: string;
  openDb?: (
    p: string,
  ) => { prepare: (s: string) => { get: (a: string) => unknown }; close: () => void } | null;
}

let depsOverride: ListOrgsDeps | null = null;

/** Test seam — replace the SF core loader / DB opener / paths. */
export function __setListOrgsDeps(d: ListOrgsDeps | null): void {
  depsOverride = d;
}

async function defaultLoadSfCore(): Promise<{
  AuthInfo: {
    listAllAuthorizations: () => Promise<AuthorizationRow[]>;
  };
}> {
  const modName = "@salesforce/core";
  const sfCore = (await import(modName)) as unknown as {
    AuthInfo: { listAllAuthorizations: () => Promise<AuthorizationRow[]> };
  };
  return { AuthInfo: sfCore.AuthInfo };
}

async function defaultResolveDefault(): Promise<string | null> {
  try {
    const mod = (await import("@ryanstark24/sfgraph-core")) as unknown as {
      resolveDefaultOrgAlias?: () => Promise<string | null>;
    };
    if (typeof mod.resolveDefaultOrgAlias === "function") {
      return await mod.resolveDefaultOrgAlias();
    }
  } catch {
    // ignore
  }
  return null;
}

function defaultOpenDb(p: string): {
  prepare: (s: string) => { get: (a: string) => unknown };
  close: () => void;
} | null {
  if (!existsSync(p)) return null;
  try {
    // better-sqlite3 ships with @ryanstark24/sfgraph-core.
    const Database = nodeRequire("better-sqlite3");
    const db = new Database(p, { readonly: true, fileMustExist: true });
    return db as { prepare: (s: string) => { get: (a: string) => unknown }; close: () => void };
  } catch {
    return null;
  }
}

defineTool({
  name: "list_orgs",
  description:
    "List all sf-authenticated orgs along with their local sfgraph ingest status (last synced timestamp, age, stale flag).",
  inputSchema,
  async execute(_input) {
    const deps = depsOverride ?? {};
    const loadSfCore = deps.loadSfCore ?? defaultLoadSfCore;
    const resolveDefault = deps.resolveDefaultOrgAlias ?? defaultResolveDefault;
    const dataDir = deps.dataDir ?? getSfgraphPaths().data;
    const openDb = deps.openDb ?? defaultOpenDb;

    let auths: AuthorizationRow[] = [];
    let loadError: string | null = null;
    try {
      const { AuthInfo } = await loadSfCore();
      auths = await AuthInfo.listAllAuthorizations();
    } catch (e) {
      loadError = (e as Error).message;
    }

    let defaultAlias: string | null = null;
    try {
      defaultAlias = await resolveDefault();
    } catch {
      defaultAlias = null;
    }

    const now = Date.now();
    const orgs = auths.map((a) => {
      const alias = (a.alias ?? null) || null;
      const username = a.username ?? "";
      const orgId = a.orgId ?? "";
      const instanceUrl = a.instanceUrl ?? "";
      const isDefault = !!defaultAlias && (defaultAlias === alias || defaultAlias === username);
      let lastSyncedAt: number | null = null;
      let ingested = false;
      if (orgId) {
        const dbPath = path.join(dataDir, `${orgId}.sqlite`);
        const db = openDb(dbPath);
        if (db) {
          ingested = true;
          try {
            const row = db
              .prepare("SELECT last_synced_at FROM _sfgraph_orgs WHERE id = ?")
              .get(orgId) as { last_synced_at: number | null } | undefined;
            if (row && row.last_synced_at != null) {
              lastSyncedAt = Number(row.last_synced_at);
            }
          } catch {
            // table missing
          }
          try {
            db.close();
          } catch {
            // ignore
          }
        }
      }
      const ageDays = lastSyncedAt != null ? Math.floor((now - lastSyncedAt) / DAY_MS) : null;
      const stale = ageDays == null ? true : ageDays >= STALE_THRESHOLD_DAYS;
      return {
        alias,
        username,
        orgId,
        instanceUrl,
        isDefault,
        ingested,
        lastSyncedAt,
        ageDays,
        stale,
      };
    });

    const rows = orgs
      .map(
        (o) =>
          `| ${o.alias ?? "_none_"} | \`${o.orgId || "_unknown_"}\` | ${o.isDefault ? "yes" : ""} | ${o.ingested ? "yes" : "no"} | ${o.lastSyncedAt != null ? new Date(o.lastSyncedAt).toISOString() : "_never_"} | ${o.stale ? "yes" : "no"} |`,
      )
      .join("\n");
    const header =
      "| Alias | Org Id | Default | Ingested | Last Synced | Stale |\n|---|---|---|---|---|---|";
    const md = orgs.length === 0 ? "_no orgs_" : `${header}\n${rows}`;
    const summary = loadError
      ? `unable to enumerate sf orgs (${loadError}); returning empty list`
      : `${orgs.length} org${orgs.length === 1 ? "" : "s"} authenticated`;
    return {
      summary,
      markdown: md,
      data: { orgs, defaultAlias },
    };
  },
});
