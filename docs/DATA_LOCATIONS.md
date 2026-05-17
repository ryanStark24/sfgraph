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
| `<data-dir>/backups/*.sqlite` | Pre-migration backups (rolling, last 5) |
| `<data-dir>/workspaces/<projectHash>.json` | Project-to-org binding for WIP analysis |
| `<data-dir>/<orgId>.skips.json` | Per-org skip report from the last ingest (used by `--retry-skipped`) |
| `<data-dir>/orgs-snapshot.json` | `sf`-CLI alias + default-org snapshot for sandboxed MCP children |
| `<config-dir>/sfgraph.json` | Telemetry config (default off) |
| `<config-dir>/machine-id` | Random UUID — only created if you enable telemetry |
| `~/.claude/skills/sf-*` | 17 SKILL.md playbooks for Claude |
| `~/.cursor/rules/sf-*.mdc` | Same, Cursor flavor |
| `<MCP-config>.json` | MCP server entry (per editor) |

What `sfgraph` **never** stores locally: passwords, access tokens (they stay in `~/.sfdx/` owned by `sf`), or your codebase content (telemetry events are field-allowlisted).

For the full privacy threat model — read-only enforcement, sanitizer behavior, telemetry payload structure — see [`PRIVACY.md`](PRIVACY.md).
