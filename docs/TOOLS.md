# MCP Tools

This document describes the MCP tools exposed by `sfgraph`.

## Ingestion and Runtime

### `ping`

Purpose:

- basic health check

Typical use:

- confirm the server is alive and the parser pool initialized

### `start_ingest_job(export_dir, mode?, include_globs?, exclude_globs?)`

Purpose:

- start full ingest in the background and return immediately with a `job_id`

Returns:

- `job_id`
- `state`
- `created_at`

### `start_refresh_job(export_dir, mode?, include_globs?, exclude_globs?)`

Purpose:

- start incremental re-ingest in the background

Returns:

- `job_id`
- `state`
- `created_at`

### `start_vectorize_job(export_dir)`

Purpose:

- rebuild vectors in the background

Returns:

- `job_id`
- `state`
- `created_at`

### `get_ingest_job(job_id)`

Purpose:

- fetch status/result for one job

### `list_ingest_jobs()`

Purpose:

- list jobs across known workspaces

### `cancel_ingest_job(job_id)`

Purpose:

- request cancellation of a running job

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

Preferred entrypoint (use this first):

- `analyze(question, ...)` one-call router for most Q&A

Intent tools (use directly when your client can classify intent):

- `analyze_field(...)` for "where is field populated/assigned/used"
- `analyze_object_event(...)` for "what happens when Object is inserted/updated/deleted"
- `analyze_component(...)` for "in class/flow/IP/DR where is token set or used"
- `analyze_change(...)` for "what breaks if I change X"

Use `query(...)` as a compatibility fallback only when you explicitly want broad node discovery.

## Deprecated Blocking Tools

- `ingest_org(export_dir)`
- `refresh(export_dir, ...)`
- `vectorize(export_dir)`

These still exist for compatibility, but new clients should prefer job-native tools above.

### `query(question, ...)`

Purpose:

- natural-language-ish entry point for common lineage/impact questions
- compatibility fallback for ambiguous questions; `analyze(...)` should be preferred in new clients

### `analyze(question, mode?, strict?, max_results?, max_hops?, time_budget_ms?, offset?)`

Purpose:

- primary one-call Q&A endpoint for MCP clients
- routes to exact-first analyzers for field/object-event/component/change questions
- uses strict mode by default to reduce semantic-noise answers

Typical use:

- `analyze("where is Service_Id__c populated?")`
- `analyze("what happens when QuoteLineItem is inserted?")`
- `analyze("in class OSS_ServiceabilityTask, where is accessId populated?")`

## LLM Prompt Contract (Recommended)

To reduce tool-call cost and round trips, use this request shape:

1. Set workspace context once:
- `set_active_export_dir(export_dir)`

2. Ask one focused question at a time:
- `analyze(question="...single question...", strict=true, mode="auto")`

3. Only call deep tools if evidence is insufficient:
- fallback order: `analyze_component` / `analyze_field` -> `trace_upstream` -> `query`

Prompting tips:
- include concrete object/class/field/token names
- ask for `method + source file + line` when you need exact evidence
- avoid multi-question prompts ("and also ...") in one call

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
- low-level helper; prefer `analyze_field` for production Q&A workflows

### `analyze_field(field_name, focus?)`

Purpose:

- strict field-centric analysis for reads/writes
- combines exact repo evidence with graph evidence

Typical use:

- `where is Service_Id__c populated`
- `who reads Account.Clarity_Customer_ID__c`

### `analyze_object_event(object_name, event)`

Purpose:

- object lifecycle map from trigger/event entrypoints

Typical use:

- `what happens when QuoteLineItem is inserted`

### `analyze_component(component_name, token?, focus?)`

Purpose:

- component-focused lineage and exact token tracing

Typical use:

- `in class OSS_ServiceabilityTask, where is accessId populated`

### `analyze_change(target?, changed_files?, ...)`

Purpose:

- change-impact analysis from component or file targets

Typical use:

- `what breaks if I change AccountService`
- release impact checks from touched files

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
2. `start_ingest_job(...)`
3. `get_ingest_job(job_id)` while ingest is running
4. `analyze(...)` for primary Q&A checks
4. `get_ingestion_status()`
5. `query("what writes to Account.Status__c?")`
6. `list_unknown_dynamic_edges(limit=10)`
7. `impact_from_git_diff(...)`
