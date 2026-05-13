# Migrating from the Python prototype to sfgraph 1.0

The Python prototype lives at `legacy/` and is preserved through v1.0.x. New
work targets the TypeScript engine under `packages/`.

## Cheat-sheet

| Python (legacy)                                | TypeScript (sfgraph 1.0)             |
| ---------------------------------------------- | ------------------------------------ |
| `python -m sfg ingest --source ./metadata`     | `sfgraph ingest --org <alias>`       |
| `python -m sfg query --field Account.X`        | MCP tool `analyze_field`             |
| `python -m sfg impact <file>`                  | MCP tool `impact_from_git_diff`      |
| `python -m sfg snapshot`                       | MCP tool `snapshot_create`           |
| Local SQLite under `.sfg/`                     | `~/.sfgraph/<org>.sqlite`            |
| YAML config                                    | `~/.sfgraph/config.json`             |
| Cron-style refresh                             | `sfgraph ingest --mode incremental`  |

## What changed

1. **Live sync first.** No more bring-your-own metadata-export. `sfgraph ingest`
   talks to a Salesforce org via `@salesforce/core` + `jsforce` wrapped in a
   read-only Proxy. The Python pipeline assumed a local checkout.
2. **Multi-org.** Every node/edge carries `org_id`. The Python pipeline kept
   one DB per project; sfgraph stores them in `~/.sfgraph/<alias>.sqlite` and
   answers cross-org queries in one process.
3. **MCP-only surface.** All analysis is exposed as MCP tools, not a Python
   CLI. Use `sfgraph install` to wire Cursor/Claude/VS Code.
4. **Snapshots replace ad-hoc backups.** The legacy `sfg snapshot` dumped JSON.
   sfgraph keeps snapshot/node-snapshot/edge-snapshot tables in the same DB
   file with 30-day retention.
5. **Vector index is colocated.** sqlite-vec lives in the same `.sqlite` file
   instead of FAISS shards.
6. **Telemetry is failure-only, sanitized, default off.** The Python pipeline
   logged to stdout; sfgraph writes to `~/.sfgraph/telemetry/*.jsonl` only on
   error.

## Data migration

There is no automatic migration path. Run `sfgraph ingest --mode full` once
per org to populate the v1 schema. Snapshots/vectors are rebuilt during the
first ingest.

## Removed features

- The Python `graphviz` exporter — sfgraph emits Mermaid in MCP tool responses.
- YAML-driven custom rules — analysis lives in `packages/core/src/analyze/`.
- Cron scaffolding — schedule `sfgraph ingest --mode incremental` from your
  OS task scheduler.

## Keeping `legacy/`

The Python tree is retained through 1.0.x for reference and one-off scripts.
It will be removed in 1.0.1 after the v1.0.0 npm publish is verified.
