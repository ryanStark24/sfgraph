# Where data lives on your machine

sfgraph resolves its filesystem paths via the [`env-paths`](https://www.npmjs.com/package/env-paths) library, which gives each platform the conventional location. The `<data-dir>` and `<config-dir>` placeholders below resolve to:

| Platform | `<data-dir>` | `<config-dir>` |
|---|---|---|
| macOS | `~/Library/Application Support/sfgraph/` | `~/Library/Preferences/sfgraph/` |
| Linux | `~/.local/share/sfgraph/` (or `$XDG_DATA_HOME/sfgraph/`) | `~/.config/sfgraph/` (or `$XDG_CONFIG_HOME/sfgraph/`) |
| Windows | `%APPDATA%\sfgraph\` | `%APPDATA%\sfgraph\` |

Override either by setting `SFGRAPH_DATA_DIR` / `SFGRAPH_CONFIG_DIR` / `SFGRAPH_CACHE_DIR` / `SFGRAPH_LOG_DIR` / `SFGRAPH_TEMP_DIR` before invoking the CLI (used by sandboxed MCP child runtimes that need an explicit path).

| Path | Contents |
|---|---|
| `<data-dir>/<orgId>.sqlite` | Per-org graph + vectors (single file) |
| `<data-dir>/backups/<orgId>.rebuild-<ISO>.sqlite` | `ingest --rebuild` backups: a full copy of the graph as it was before the rebuild (plus `-wal`/`-shm`). The newest 1 per org is kept (`SFGRAPH_REBUILD_BACKUPS_KEPT`), pruned after the rebuild's sync completes. `<backup>.sqlite.incomplete` marks a backup of a graph whose rebuild never finished. |
| `<data-dir>/<orgId>.rebuild-pending.json` | Present while an org's `--rebuild` has not finished its sync |
| `<data-dir>/.sfgraph-backups/` | Pre-migration backups (rolling, last 5) |
| `<data-dir>/embedding-cache/` | Embedding vector cache, shared by all orgs; only grows |
| `<data-dir>/workspaces/<projectHash>.json` | Project-to-org binding for WIP analysis |
| `<data-dir>/<orgId>.skips.json` | Per-org skip report from the last ingest (used by `--retry-skipped`) |
| `<data-dir>/orgs-snapshot.json` | `sf`-CLI alias + default-org snapshot for sandboxed MCP children |
| `<config-dir>/sfgraph.json` | Telemetry config (default off) |
| `<config-dir>/machine-id` | Random UUID — only created if you enable telemetry |
| `~/.claude/skills/sf-*` | 17 SKILL.md playbooks for Claude |
| `~/.cursor/rules/sf-*.mdc` | Same, Cursor flavor |
| `<MCP-config>.json` | MCP server entry (per editor) |

**How much space is it?** `sfgraph storage` lists every graph, backup and cache with sizes (add `--json` for scripts). Snapshots live inside each graph file as version tables, so many snapshots make the graph file larger: sfgraph keeps the newest 5 auto snapshots per org (`SFGRAPH_SNAPSHOTS_KEPT`; the rest go on the next sync, unless you set an age floor with `SFGRAPH_SNAPSHOT_RETAIN_DAYS`). Removing rows frees pages inside the file but does not shrink it; `sfgraph storage clean --vacuum` rewrites the file without them (it needs free disk of twice the file's size and no other process holding the graph). Graphs of orgs you no longer use stay until you run `sfgraph storage drop <org> --apply`. See [`CLI.md`](CLI.md#sfgraph-storage).

What `sfgraph` **never** stores locally: passwords, access tokens (they stay in `~/.sfdx/` owned by `sf`), or your codebase content (telemetry events are field-allowlisted). Custom setting row values are not stored either, unless you ingest with `--store-setting-rows`; see [`PRIVACY.md`](PRIVACY.md#custom-setting-rows). Custom metadata record values and the Apex, LWC and Flow source that a project or org ingest reads are stored in the graph, as the ingest is for.

For the full privacy threat model — read-only enforcement, sanitizer behavior, telemetry payload structure — see [`PRIVACY.md`](PRIVACY.md).
