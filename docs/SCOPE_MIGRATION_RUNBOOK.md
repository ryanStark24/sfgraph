# Scope Migration Runbook

This runbook migrates legacy unscoped graph rows into project-scoped keys (`projectScope::qualifiedName`).

## Preconditions

- Stop any long-running ingest/refresh jobs.
- Know the project export directory used for this graph.
- Ensure a backup of `./data/sfgraph.duckdb` and `./data/vectors` exists.

## 1) Dry run

```bash
uv run sfgraph migrate-scope /absolute/path/to/export
```

Review:

- `migrated_nodes`
- `migrated_edges`
- `skipped_nodes`
- `skipped_edges`

## 2) Apply migration

```bash
uv run sfgraph migrate-scope /absolute/path/to/export --apply
```

Optional prune pass for leftover legacy rows under export path:

```bash
uv run sfgraph migrate-scope /absolute/path/to/export --apply --prune-legacy
```

## 3) Re-index vectors and reconcile edges

Run a refresh (preferred) or full ingest:

```bash
uv run sfgraph refresh /absolute/path/to/export
```

## 4) Verify isolation

- Query status:

```bash
uv run sfgraph status
```

- Ensure freshness includes expected `project_scope` and no unexpected pending files.
- Spot-check query:

```bash
uv run sfgraph query "what uses Account.Status__c?"
```

## Rollback

- Stop server/processes.
- Restore `sfgraph.duckdb` and vector storage from backup.
