import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadBetterSqlite3 } from "@ryanstark24/sfgraph-core";
import { getSfgraphPaths, validateOrgIdentifier } from "@ryanstark24/sfgraph-shared";

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
    /** Optional — when present, used to fill in `alias` for orgs whose
     *  listAllAuthorizations entry has alias=null even though the user has
     *  the alias bound in `sf` CLI. */
    aliasByUsername?: Map<string, string>;
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

/** Read the alias map + authorizations from the install-time snapshot if it
 *  exists. The snapshot is written by `sfgraph install` running OUTSIDE the
 *  sandbox, then read by the sandboxed MCP child here. This is the only
 *  reliable alias source when Cursor's sandbox blocks ~/.sf/alias.json. */
function readSnapshot(dataDir: string): {
  defaultAlias: string | null;
  aliasByUsername: Map<string, string>;
  authorizations: AuthorizationRow[];
} | null {
  try {
    const p = path.join(dataDir, "orgs-snapshot.json");
    if (!existsSync(p)) return null;
    const { readFileSync } = nodeRequire("node:fs") as typeof import("node:fs");
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      defaultAlias?: string | null;
      aliases?: Record<string, string>;
      authorizations?: Record<string, { orgId: string; instanceUrl: string }>;
    };
    const aliasByUsername = new Map<string, string>();
    for (const [alias, username] of Object.entries(raw.aliases ?? {})) {
      if (typeof username === "string") aliasByUsername.set(username, alias);
    }
    const authorizations: AuthorizationRow[] = Object.entries(raw.authorizations ?? {}).map(
      ([username, info]) => ({
        alias: aliasByUsername.get(username) ?? null,
        username,
        orgId: info.orgId,
        instanceUrl: info.instanceUrl,
      }),
    );
    return {
      defaultAlias: raw.defaultAlias ?? null,
      aliasByUsername,
      authorizations,
    };
  } catch {
    return null;
  }
}

async function defaultLoadSfCore(): Promise<{
  AuthInfo: {
    listAllAuthorizations: () => Promise<AuthorizationRow[]>;
  };
  /** Username -> alias lookup. AuthInfo.listAllAuthorizations() returns
   *  alias=null even when `sf org list` shows it because the two APIs read
   *  from different places. StateAggregator's `aliases.getAll()` is the
   *  authoritative source for alias→username bindings; we invert it. */
  aliasByUsername: Map<string, string>;
}> {
  const modName = "@salesforce/core";
  const sfCore = (await import(modName)) as unknown as {
    AuthInfo: { listAllAuthorizations: () => Promise<AuthorizationRow[]> };
    StateAggregator?: {
      create: () => Promise<{
        aliases: {
          getAll: () => Record<string, string>;
        };
      }>;
    };
  };
  const aliasByUsername = new Map<string, string>();
  if (sfCore.StateAggregator?.create) {
    try {
      const agg = await sfCore.StateAggregator.create();
      const all = agg.aliases.getAll();
      for (const [alias, username] of Object.entries(all)) {
        if (typeof username === "string" && username.length > 0) {
          aliasByUsername.set(username, alias);
        }
      }
    } catch {
      // StateAggregator failed; alias enumeration just stays empty.
    }
  }
  return { AuthInfo: sfCore.AuthInfo, aliasByUsername };
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

/** Diagnostic counter — captured into the summary so silent open failures
 *  (missing native binding, wrong arch, etc.) don't hide behind '0 orgs'. */
let lastOpenDbError: string | null = null;

function defaultOpenDb(p: string): {
  prepare: (s: string) => { get: (a: string) => unknown };
  close: () => void;
} | null {
  if (!existsSync(p)) return null;
  try {
    const Database = loadBetterSqlite3<new (p: string, o?: unknown) => unknown>(nodeRequire);
    const db = new Database(p, { readonly: true, fileMustExist: true });
    return db as { prepare: (s: string) => { get: (a: string) => unknown }; close: () => void };
  } catch (e) {
    lastOpenDbError = (e as Error).message;
    return null;
  }
}

defineTool({
  name: "list_orgs",
  description:
    "USE THIS as the FIRST step in any sfgraph workflow to enumerate the user's available Salesforce orgs and their ingest status. Shows aliases, orgIds, default-org marker, ingested-locally flag, last-synced timestamp, stale flag. Works even when the sf CLI auth isn't reachable from this process (falls back to scanning the local data dir).",
  inputSchema,
  async execute(_input) {
    const deps = depsOverride ?? {};
    const loadSfCore = deps.loadSfCore ?? defaultLoadSfCore;
    const resolveDefault = deps.resolveDefaultOrgAlias ?? defaultResolveDefault;
    const dataDir = deps.dataDir ?? getSfgraphPaths().data;
    const openDb = deps.openDb ?? defaultOpenDb;

    let auths: AuthorizationRow[] = [];
    let aliasByUsername: Map<string, string> = new Map();
    let loadError: string | null = null;
    try {
      const sfCore = await loadSfCore();
      auths = await sfCore.AuthInfo.listAllAuthorizations();
      if (sfCore.aliasByUsername) aliasByUsername = sfCore.aliasByUsername;
    } catch (e) {
      loadError = (e as Error).message;
    }

    let defaultAlias: string | null = null;
    try {
      defaultAlias = await resolveDefault();
    } catch {
      defaultAlias = null;
    }

    // Sandbox fallback: when the MCP child can't read ~/.sf/ directly
    // (Cursor's macOS sandbox), AuthInfo/StateAggregator/ConfigAggregator
    // all come back empty. `sfgraph install` runs OUTSIDE the sandbox and
    // snapshots that state to <dataDir>/orgs-snapshot.json. Merge it in
    // here as the authoritative source when the live calls returned
    // nothing useful.
    const snap = readSnapshot(dataDir);
    if (snap) {
      if (auths.length === 0) auths = snap.authorizations;
      if (aliasByUsername.size === 0) aliasByUsername = snap.aliasByUsername;
      if (!defaultAlias && snap.defaultAlias) defaultAlias = snap.defaultAlias;
    }

    const now = Date.now();
    const byOrgId = new Map<
      string,
      {
        alias: string | null;
        username: string;
        orgId: string;
        instanceUrl: string;
        isDefault: boolean;
        ingested: boolean;
        lastSyncedAt: number | null;
        ageDays: number | null;
        stale: boolean;
      }
    >();

    // Pass 1 — orgs visible via @salesforce/core (the sf CLI auth dir).
    // When the MCP server runs as a child process of Cursor / Claude with
    // no shell env, this call sometimes returns empty even though the user
    // is authenticated in their shell. Pass 2 below catches that case by
    // scanning the local data dir for ingested orgs.
    for (const a of auths) {
      const username = a.username ?? "";
      // Prefer the alias on the AuthorizationRow; if absent, fall back to
      // the username -> alias map from StateAggregator. This is the actual
      // fix for 'all aliases show _none_': AuthInfo.listAllAuthorizations
      // routinely returns alias=null even when `sf org list` shows one.
      const alias = (a.alias ?? null) || aliasByUsername.get(username) || null;
      const orgId = a.orgId ?? "";
      const instanceUrl = a.instanceUrl ?? "";
      const isDefault = !!defaultAlias && (defaultAlias === alias || defaultAlias === username);
      if (!orgId) continue;
      // Try to open this org's local DB to read last-synced timestamp.
      let lastSyncedAt: number | null = null;
      let ingested = false;
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
          // table missing or schema older than v4
        }
        try {
          db.close();
        } catch {
          // ignore
        }
      }
      byOrgId.set(orgId, {
        alias,
        username,
        orgId,
        instanceUrl,
        isDefault,
        ingested,
        lastSyncedAt,
        ageDays: null,
        stale: true,
      });
    }

    // Pass 2 — orgs visible via the local data dir. ANY <orgId>.sqlite that
    // contains an _sfgraph_orgs row is a valid usable graph regardless of
    // whether the sf CLI auth is currently accessible to this process.
    if (existsSync(dataDir)) {
      let files: string[] = [];
      try {
        files = readdirSync(dataDir).filter(
          (f) => f.endsWith(".sqlite") && !f.startsWith("backups"),
        );
      } catch {
        files = [];
      }
      for (const f of files) {
        const orgId = f.replace(/\.sqlite$/, "");
        if (!orgId || orgId.includes("/")) continue;
        // Harden: skip any file whose stem isn't a valid org identifier.
        try {
          validateOrgIdentifier(orgId);
        } catch {
          continue;
        }
        const dbPath = path.join(dataDir, f);
        const db = openDb(dbPath);
        if (!db) continue;
        let storedAlias: string | null = null;
        let storedInstance: string | null = null;
        let lastSyncedAt: number | null = null;
        try {
          const row = db
            .prepare("SELECT alias, instance_url, last_synced_at FROM _sfgraph_orgs WHERE id = ?")
            .get(orgId) as
            | {
                alias: string | null;
                instance_url: string | null;
                last_synced_at: number | null;
              }
            | undefined;
          if (row) {
            storedAlias = row.alias ?? null;
            storedInstance = row.instance_url ?? null;
            if (row.last_synced_at != null) lastSyncedAt = Number(row.last_synced_at);
          }
        } catch {
          // table missing or schema older than v4
        }
        try {
          db.close();
        } catch {
          // ignore
        }
        const existing = byOrgId.get(orgId);
        if (existing) {
          existing.ingested = true;
          if (lastSyncedAt != null) existing.lastSyncedAt = lastSyncedAt;
        } else {
          byOrgId.set(orgId, {
            alias: storedAlias,
            username: "",
            orgId,
            instanceUrl: storedInstance ?? "",
            isDefault: !!defaultAlias && !!storedAlias && defaultAlias === storedAlias,
            ingested: true,
            lastSyncedAt,
            ageDays: null,
            stale: true,
          });
        }
      }
    }

    const orgs = [...byOrgId.values()].map((o) => {
      const ageDays = o.lastSyncedAt != null ? Math.floor((now - o.lastSyncedAt) / DAY_MS) : null;
      const stale = ageDays == null ? true : ageDays >= STALE_THRESHOLD_DAYS;
      return { ...o, ageDays, stale };
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
    const authCount = auths.length;
    const ingestedCount = orgs.filter((o) => o.ingested).length;
    const dbErrSuffix = lastOpenDbError ? ` [openDb error: ${lastOpenDbError}]` : "";
    const summary = loadError
      ? `sf-cli auth unavailable in this process (${loadError}); discovered ${orgs.length} org${orgs.length === 1 ? "" : "s"} from local sfgraph data dir (${ingestedCount} ingested)${dbErrSuffix}`
      : `${orgs.length} org${orgs.length === 1 ? "" : "s"} total — ${authCount} via sf CLI, ${ingestedCount} ingested locally${dbErrSuffix}`;
    // Reset for next invocation so a transient error doesn't stick.
    lastOpenDbError = null;
    return {
      summary,
      markdown: md,
      data: { orgs, defaultAlias },
    };
  },
});
