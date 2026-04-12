# sfgraph

`sfgraph` is a Salesforce metadata graph and MCP server for impact analysis across Apex, Aura, Flows, LWC, objects, and OmniStudio/Vlocity assets.

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
- Aura bundles and Apex controller links
- Lightning Web Components
- OmniStudio / Vlocity components including DataRaptors, Integration Procedures, and OmniScripts

The query layer is built around trust and operational safety:

- Evidence-first answers with paths, node context, and source references
- Freshness metadata such as `indexed_commit`, `indexed_at`, `dirty_files_pending`, and `partial_results`
- Typed edge semantics like `soql_select`, `soql_where`, `dml_update`, `dr_output`, `flow_filter`, and `ui_bind`
- Upstream and downstream lineage tracing with hop, time, and result limits
- Project-scoped storage keys to prevent cross-project contamination
- Explicit unknown/dynamic edge reporting instead of false certainty

## Documentation

Start here depending on what you need:

- Product overview and install: this README
- Architecture and internals: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Next implementation architecture: [`docs/ARCHITECTURE_V2_IMPLEMENTATION.md`](docs/ARCHITECTURE_V2_IMPLEMENTATION.md)
- MCP tool reference: [`docs/TOOLS.md`](docs/TOOLS.md)
- IDE and client setup: [`docs/IDE_SETUP.md`](docs/IDE_SETUP.md)
- Troubleshooting: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
- Scope migration: [`docs/SCOPE_MIGRATION_RUNBOOK.md`](docs/SCOPE_MIGRATION_RUNBOOK.md)
- Release process: [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)
- Release notes: [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md)

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

### Option 3: Run via `npx` bootstrap package

This repo now includes an npm launcher package that can bootstrap a Python runtime automatically and start the MCP server in one step.

Current beta usage:

```bash
npx -y @ryanstark24/sfgraph-mcp@beta
```

What it does:

- creates a cached Python virtual environment
- installs the Python package into that environment
- reuses the cached environment on later runs
- injects the Apex parser Node dependency for the worker runtime

Optional flags:

```bash
npx -y @ryanstark24/sfgraph-mcp --reinstall
npx -y @ryanstark24/sfgraph-mcp --package-spec sfgraph
npx -y @ryanstark24/sfgraph-mcp --runtime-dir /custom/path
```

### Optional environment variables

- `SFGRAPH_ALLOW_NETWORK=1`: explicitly allow outbound network access for optional features
- `OPENAI_API_KEY`: optional, only for LLM-assisted query-agent behavior when `SFGRAPH_ALLOW_NETWORK=1`
- `OPENAI_BASE_URL`: optional custom OpenAI-compatible base URL
- `SFGRAPH_AGENT_MODEL`: optional model override, defaults to `gpt-4.1-mini`
- `SFGRAPH_DISABLE_LLM_AGENTS=1`: force heuristic-only query behavior

By default, `sfgraph` runs in local-only mode:

- metadata parsing and graph storage stay on the local machine
- LLM query-agent calls are disabled unless `SFGRAPH_ALLOW_NETWORK=1`
- embedding model downloads are disabled unless `SFGRAPH_ALLOW_NETWORK=1`

If no `OPENAI_API_KEY` is set, the core product still works. Ingest, trace, diff, impact analysis, and MCP tools do not depend on it.

## Quick Start

### CLI

CLI is the recommended ingest path for reliability and predictable UX. Use MCP primarily for interactive querying and job polling from IDE clients.

```bash
# Full ingest
uv run sfgraph ingest /absolute/path/to/export --data-dir ./data

# Incremental refresh
uv run sfgraph refresh /absolute/path/to/export --data-dir ./data

# Optional org-aware enrichment (uses Salesforce CLI)
uv run sfgraph ingest /absolute/path/to/export --data-dir ./data --enrich-org --org-alias my-org
uv run sfgraph refresh /absolute/path/to/export --data-dir ./data --enrich-org --org-alias my-org

# Ask a question
uv run sfgraph query "what uses Account.Status__c?" --data-dir ./data

# Check freshness / status
uv run sfgraph status --data-dir ./data

# Check live ingest progress
uv run sfgraph progress --data-dir ./data

# Run benchmark
uv run sfgraph benchmark /absolute/path/to/export --data-dir ./data

# Run acceptance suite (quality + latency + token-size estimates)
uv run sfgraph acceptance --data-dir ./data --suite docs/acceptance_question_suite.json

# Run MCP/daemon self-test (real tool-call path)
uv run python -m sfgraph.cli selftest /absolute/path/to/export --data-dir ./data --suite docs/acceptance_quality_gate_suite.json --mode graph_only
```

For public Apex+Vlocity dry runs, see [`docs/ONLINE_DATASET_BENCHMARK.md`](docs/ONLINE_DATASET_BENCHMARK.md).

Available commands:

- `serve`
- `ingest`
- `refresh`
- `query`
- `diagnostics`
- `subgraph`
- `progress`
- `status`
- `migrate-scope`
- `benchmark`
- `acceptance`
- `selftest`

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

- Preferred for specific questions:
  - `analyze` (recommended one-call Q&A entrypoint)
  - `analyze_field`
  - `analyze_object_event`
  - `analyze_component`
  - `analyze_change`
- Compatibility fallback:
  - `query`

- `start_ingest_job(export_dir, mode?, include_globs?, exclude_globs?, org_alias?, enrich_org?)`
- `start_refresh_job(export_dir, mode?, include_globs?, exclude_globs?, org_alias?, enrich_org?)`
- `start_vectorize_job(export_dir)`
- `get_ingest_job(job_id)`
- `list_ingest_jobs()`
- `cancel_ingest_job(job_id)`
- `resume_ingest_job(job_id)`
- `ingest_org(export_dir, ..., org_alias?, enrich_org?)` (deprecated compatibility)
- `refresh(export_dir, ..., org_alias?, enrich_org?)` (deprecated compatibility)
- `watch_refresh(export_dir, duration_seconds?, poll_interval?, debounce_seconds?, max_refreshes?)`
- `get_ingestion_progress()`
- `get_ingestion_status()`
- `export_diagnostics_md(export_dir?, run_id?, job_id?, destination?)`
- `graph_subgraph(node_id?, question?, hops?, max_nodes?, format?, focus?)`
- `analyze(question, mode?, strict?, max_results?, max_hops?, time_budget_ms?, offset?)`
- `query(question, max_hops?, max_results?, time_budget_ms?, offset?)`
- `trace_upstream(node_id, max_hops?, max_results?, time_budget_ms?, offset?)`
- `trace_downstream(node_id, max_hops?, max_results?, time_budget_ms?, offset?)`
- `get_node(node_id)`
- `explain_field(field_qualified_name)`
- `analyze_field(field_name, focus?, max_results?)`
- `analyze_object_event(object_name, event, max_results?)`
- `analyze_component(component_name, token?, focus?, max_results?)`
- `analyze_change(target?, changed_files?, max_hops?, max_results_per_component?)`
- `impact_from_git_diff(base_ref?, head_ref?, max_hops?, max_results_per_component?)`
- `cross_layer_flow_map(node_id, max_hops?, max_results?)`
- `list_unknown_dynamic_edges(limit?, offset?)`
- `create_snapshot(name?)`

## Standards-Driven Vlocity Support

The Vlocity / OmniStudio layer now uses a modular standards core so we can
improve coverage without growing parser heuristics into an unreadable blob.

- bundled baseline rules live in `src/sfgraph/config/vlocity_standards_baseline.yaml`
- runtime bundles merge:
  - bundled baseline
  - local datapack inference
  - optional org enrichment from Salesforce CLI metadata queries
- ingest metadata now persists:
  - full `parse_failures`
  - full `warnings`
  - `vlocity_standards`
- diagnostics markdown is written automatically to:
  - `data/ingestion_diagnostics.md`
- `analyze(...)` now includes a short-lived in-process cache and stage-budget tracking
  so repeated exact questions can return with fewer internal round trips
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
- server name: `sfgraph`

Detailed setup examples for Cursor, VS Code MCP clients, Claude Desktop, and other `stdio`-based clients are in [`docs/IDE_SETUP.md`](docs/IDE_SETUP.md).

If you publish the npm launcher, clients that support `npx`-style MCP entries can use:

```json
{
  "servers": {
    "sfgraph": {
      "command": "npx",
      "args": ["-y", "@ryanstark24/sfgraph-mcp@beta"]
    }
  }
}
```

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

- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Tool reference: [`docs/TOOLS.md`](docs/TOOLS.md)
- IDE setup: [`docs/IDE_SETUP.md`](docs/IDE_SETUP.md)
- Troubleshooting: [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)
- Scope migration: [`docs/SCOPE_MIGRATION_RUNBOOK.md`](docs/SCOPE_MIGRATION_RUNBOOK.md)
- Release checklist: [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md)
- Release notes: [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md)
