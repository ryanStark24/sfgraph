import envPaths from "env-paths";

export interface SfgraphPaths {
  data: string;
  cache: string;
  log: string;
  config: string;
  temp: string;
}

/**
 * Resolve sfgraph's filesystem paths. Env-var overrides take precedence so
 * sandboxed IDE child processes (Cursor's MCP runtime, Claude Desktop on
 * macOS, VS Code with restricted workspace trust) can be told explicitly
 * where the data the shell wrote actually lives.
 *
 *   SFGRAPH_DATA_DIR     per-org SQLite files + workspaces
 *   SFGRAPH_CONFIG_DIR   sfgraph.json + machine-id
 *   SFGRAPH_CACHE_DIR    embedding cache
 *   SFGRAPH_LOG_DIR      append-only logs
 *   SFGRAPH_TEMP_DIR     scratch
 *
 * When unset, falls back to env-paths defaults (~/Library/Application
 * Support/sfgraph on macOS, ~/.local/share/sfgraph on Linux,
 * %APPDATA%/sfgraph on Windows).
 */
export function getSfgraphPaths(): SfgraphPaths {
  const p = envPaths("sfgraph", { suffix: "" });
  return {
    data: process.env.SFGRAPH_DATA_DIR ?? p.data,
    cache: process.env.SFGRAPH_CACHE_DIR ?? p.cache,
    log: process.env.SFGRAPH_LOG_DIR ?? p.log,
    config: process.env.SFGRAPH_CONFIG_DIR ?? p.config,
    temp: process.env.SFGRAPH_TEMP_DIR ?? p.temp,
  };
}
