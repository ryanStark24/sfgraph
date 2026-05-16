# Where data lives on your machine

| Path | Contents |
|---|---|
| `~/.sfgraph/<orgId>.sqlite` | Per-org graph + vectors (single file) |
| `~/.sfgraph/backups/*.sqlite` | Pre-migration backups (rolling, last 5) |
| `~/.sfgraph/workspaces/<projectHash>.json` | Project-to-org binding for WIP analysis |
| `~/.sfgraph/<orgId>.skips.json` | Per-org skip report from the last ingest (used by `--retry-skipped`) |
| `~/.sfgraph/orgs-snapshot.json` | `sf`-CLI alias + default-org snapshot for sandboxed MCP children |
| `~/.config/sfgraph/sfgraph.json` | Telemetry config (default off) |
| `~/.config/sfgraph/machine-id` | Random UUID — only created if you enable telemetry |
| `~/.claude/skills/sf-*` | 17 SKILL.md playbooks for Claude |
| `~/.cursor/rules/sf-*.mdc` | Same, Cursor flavor |
| `<MCP-config>.json` | MCP server entry (per editor) |

What `sfgraph` **never** stores locally: passwords, access tokens (they stay in `~/.sfdx/` owned by `sf`), or your codebase content (telemetry events are field-allowlisted).

For the full privacy threat model — read-only enforcement, sanitizer behavior, telemetry payload structure — see [`PRIVACY.md`](PRIVACY.md).
