# sfgraph

`sfgraph` is a Salesforce metadata graph and MCP server for impact analysis across Apex, Flows, LWC, objects, and OmniStudio/Vlocity assets.

It ingests a Salesforce export into a local property graph, preserves project isolation, and answers evidence-first questions such as:

- What writes to `Account.Status__c`?
- Which components are impacted by this git diff?
- What is upstream of this DataRaptor or downstream of this OmniScript?
- Which dynamic references are unresolved and need manual review?

## What This MCP Does

`sfgraph` maps relationships across:

- Apex classes and SOQL/DML behavior
- Object and field metadata
- Record-triggered and screen flows
- Lightning Web Components
- OmniStudio / Vlocity components including DataRaptors, Integration Procedures, and OmniScripts

The query layer is built around trust and operational safety:

- Evidence-first answers with paths, node context, and source references
- Freshness metadata such as `indexed_commit`, `indexed_at`, `dirty_files_pending`, and `partial_results`
- Typed edge semantics like `soql_select`, `soql_where`, `dml_update`, `dr_output`, `flow_filter`, and `ui_bind`
- Upstream and downstream lineage tracing with hop, time, and result limits
- Project-scoped storage keys to prevent cross-project contamination
- Explicit unknown/dynamic edge reporting instead of false certainty

## Install

### Option 1: Install from source

Requires Python `3.12+`.

```bash
git clone <your-repo-url>
cd sfgraph
uv sync
npm install
```

macOS note:

```bash
brew install libomp
```

`libomp` is only needed for optional native dependencies. The default DuckDB-backed path works without external services.

`npm install` is required for the Apex parser worker because it depends on `web-tree-sitter-sfapex`.

### Option 2: Install into a clean environment

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install .
npm install
```

### Optional environment variables

- `OPENAI_API_KEY`: optional, only for LLM-assisted query-agent behavior
- `OPENAI_BASE_URL`: optional custom OpenAI-compatible base URL
- `SFGRAPH_AGENT_MODEL`: optional model override, defaults to `gpt-4.1-mini`
- `SFGRAPH_DISABLE_LLM_AGENTS=1`: force heuristic-only query behavior

If no `OPENAI_API_KEY` is set, the core product still works. Ingest, trace, diff, impact analysis, and MCP tools do not depend on it.

## Quick Start

### CLI

```bash
# Full ingest
uv run sfgraph ingest /absolute/path/to/export --data-dir ./data

# Incremental refresh
uv run sfgraph refresh /absolute/path/to/export --data-dir ./data

# Ask a question
uv run sfgraph query "what uses Account.Status__c?" --data-dir ./data

# Check freshness / status
uv run sfgraph status --data-dir ./data

# Run benchmark
uv run sfgraph benchmark /absolute/path/to/export --data-dir ./data
```

Available commands:

- `serve`
- `ingest`
- `refresh`
- `query`
- `status`
- `migrate-scope`
- `benchmark`

### MCP server

```bash
uv run sfgraph serve
```

Or with the module entrypoint:

```bash
PYTHONPATH=src .venv/bin/python -m sfgraph.server
```

The server stores graph data under `./data` relative to the repo root by default.

## Core MCP Tools

- `ingest_org(export_dir)`
- `refresh(export_dir)`
- `watch_refresh(export_dir, duration_seconds?, poll_interval?, debounce_seconds?, max_refreshes?)`
- `get_ingestion_status()`
- `query(question, max_hops?, max_results?, time_budget_ms?, offset?)`
- `trace_upstream(node_id, max_hops?, max_results?, time_budget_ms?, offset?)`
- `trace_downstream(node_id, max_hops?, max_results?, time_budget_ms?, offset?)`
- `get_node(node_id)`
- `explain_field(field_qualified_name)`
- `impact_from_git_diff(base_ref?, head_ref?, max_hops?, max_results_per_component?)`
- `cross_layer_flow_map(node_id, max_hops?, max_results?)`
- `list_unknown_dynamic_edges(limit?, offset?)`
- `create_snapshot(name?)`
- `diff_snapshots(snapshot_a_path, snapshot_b_path, max_examples?)`
- `migrate_project_scope(export_dir, dry_run?, prune_legacy?)`
- `test_gap_intelligence_from_git_diff(base_ref?, head_ref?, max_hops?, max_results_per_component?)`

## Project Isolation

`sfgraph` is designed so separate Salesforce projects do not mix graph entries:

- Graph keys are stored as `projectScope::qualifiedName`
- Vector search is filtered by `project_scope`
- MCP ingest paths are restricted to the current workspace root
- You should still use a separate `data` directory per project when running multiple repos locally

Recommended pattern:

```bash
uv run sfgraph ingest /path/to/projectA/export --data-dir /path/to/projectA/.sfgraph-data
uv run sfgraph ingest /path/to/projectB/export --data-dir /path/to/projectB/.sfgraph-data
```

## Different IDEs

This MCP works with IDEs and MCP clients that support `stdio` servers. The most common pattern is:

- command: Python executable from this repo's environment
- args: `-m sfgraph.server`
- cwd: repo root
- env: `PYTHONPATH=<repo>/src`
- server name: `salesforce-lineage`

Detailed setup examples for Cursor, VS Code MCP clients, Claude Desktop, and other `stdio`-based clients are in [`docs/IDE_SETUP.md`](docs/IDE_SETUP.md).

## VS Code Extension

A companion VS Code extension now lives in [`extensions/vscode-sfgraph`](extensions/vscode-sfgraph).

It provides:

- a status bar control to start and stop the MCP server
- a command to run `uv sync` and `npm install`
- a command to write `.cursor/mcp.json` for the active workspace

This is the right place to add UI for server lifecycle inside VS Code. For other IDEs, we can generate config files when the IDE stores MCP settings on disk, but we cannot directly inject tools into every IDE unless it exposes a supported config or extension API.

## Typical Workflow

1. Export Salesforce metadata into a local project folder.
2. Run a full ingest once.
3. Use `refresh` as files change.
4. Ask lineage, impact, and change-risk questions through CLI or MCP.
5. Use `impact_from_git_diff` and `test_gap_intelligence_from_git_diff` during code review or release prep.

## Operations Docs

- IDE setup: [`docs/IDE_SETUP.md`](docs/IDE_SETUP.md)
- Scope migration: [`docs/SCOPE_MIGRATION_RUNBOOK.md`](docs/SCOPE_MIGRATION_RUNBOOK.md)
- Release checklist: [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)
