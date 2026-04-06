# MCP Tools

This document describes the MCP tools exposed by `sfgraph`.

## Ingestion and Runtime

### `ping`

Purpose:

- basic health check

Typical use:

- confirm the server is alive and the parser pool initialized

### `ingest_org(export_dir)`

Purpose:

- full ingest of a Salesforce export directory

Returns:

- run id
- total nodes and edges
- parser stats
- unresolved symbol count
- warnings

### `refresh(export_dir)`

Purpose:

- incremental re-ingest for changed/new/deleted files

Returns:

- changed files
- deleted files
- affected neighbor files
- updated graph counts

### `watch_refresh(export_dir, ...)`

Purpose:

- poll a workspace and trigger debounced refresh runs

Use when:

- testing iterative local updates

### `get_ingestion_status()`

Purpose:

- summarize current graph state and freshness

Key fields:

- `indexed_commit`
- `indexed_at`
- `dirty_files_pending`
- `partial_results`
- `rules`
- `active_run` when an ingest or refresh is currently in progress

### `get_ingestion_progress()`

Purpose:

- return the latest persisted progress snapshot for a running or recently completed ingest/refresh

Key fields:

- `state` such as `idle`, `running`, or `completed`
- `phase` such as `discovering`, `parsing`, `writing_nodes`, `writing_edges`, or `completed`
- `total_files`
- `processed_files`
- `failed_files`
- `current_file`
- `completion_ratio`
- `parser_stats`

## Query and Lineage

### `query(question, ...)`

Purpose:

- natural-language-ish entry point for common lineage/impact questions

Behavior:

- routes to trace, cross-layer map, or node-search paths
- includes evidence and confidence tiers

### `get_node(node_id)`

Purpose:

- fetch a node and its incoming/outgoing edges

Supports:

- unscoped ids
- scoped ids like `scope::qualifiedName`

### `trace_upstream(node_id, ...)`

Purpose:

- find where a value or component originates from

### `trace_downstream(node_id, ...)`

Purpose:

- find blast radius and dependents

### `cross_layer_flow_map(node_id, ...)`

Purpose:

- show paths across UI, Flow, DataRaptor, Integration Procedure, Apex, and field/object usage

### `explain_field(field_qualified_name)`

Purpose:

- summarize readers, writers, and dependents for a field

### `list_unknown_dynamic_edges(limit?, offset?)`

Purpose:

- expose dynamic/unresolved edges instead of hiding them

Use when:

- validating confidence
- reviewing dynamic SOQL or indirect references

## Change-Aware Tools

### `impact_from_git_diff(base_ref?, head_ref?, ...)`

Purpose:

- estimate impacted components from a git diff

Returns:

- changed files
- impacted components
- risk summary

### `test_gap_intelligence_from_git_diff(base_ref?, head_ref?, ...)`

Purpose:

- summarize test coverage confidence for diff impact

## Snapshots and Migration

### `create_snapshot(name?)`

Purpose:

- save the current graph state to a JSON snapshot

### `diff_snapshots(snapshot_a_path, snapshot_b_path, ...)`

Purpose:

- compare two graph snapshots

### `migrate_project_scope(export_dir, dry_run?, prune_legacy?)`

Purpose:

- migrate older unscoped graph rows to scoped ids

Recommended default:

- run with `dry_run=true` first

## Practical Testing Sequence

For a new workspace, a good smoke test order is:

1. `ping`
2. `ingest_org(...)`
3. `get_ingestion_progress()` while ingest is running
4. `get_ingestion_status()`
5. `query("what writes to Account.Status__c?")`
6. `list_unknown_dynamic_edges(limit=10)`
7. `impact_from_git_diff(...)`
