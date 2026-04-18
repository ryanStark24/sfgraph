# Troubleshooting

This document covers the most common `sfgraph` setup and runtime issues.

## Server Starts Slowly on First Run

Symptom:

- IDE times out while the server is still bootstrapping

Why:

- first-run bootstrap may create a virtual environment, install Python dependencies, and download model/runtime dependencies

What to do:

```bash
npx -y @ryanstark24/sfgraph-mcp@beta
```

Run it once in a terminal and let it finish before enabling it in the IDE.

## Repository Not Found During npx Bootstrap

Symptom:

- `git clone ... sfgraph.git` fails with `Repository not found`

Why:

- the launcher installs the Python package from GitHub
- the repo must be publicly accessible, or the machine must have GitHub access

What to do:

- ensure the repo is public, or
- use a different package spec override

## DuckDB Lock Error

Symptom:

- `Could not set lock on file ... sfgraph.duckdb`

Why:

- another `sfgraph` process already has the same database open

What to do:

```bash
pkill -f "sfgraph.server" || true
```

Then restart one server instance only.

## Rules Registry Attribute Errors

Symptom:

- `_aliases` or `_semantic_rules` attribute errors in query tools

Why:

- older server builds had a missing-default initialization bug in `RulesRegistry`

What to do:

- reinstall/update the runtime to a newer build

## grpc / qdrant-client ImportError on Python 3.13

Symptom:

- import failure while loading `grpc` or `qdrant_client`

Why:

- some environments behave badly with the dependency stack on Python `3.13`

Current fix:

- the bootstrap launcher now prefers Python `3.12`

What to do:

```bash
rm -rf ~/Library/Caches/sfgraph-mcp
npx -y @ryanstark24/sfgraph-mcp@beta
```

And verify `python3.12` exists on the machine.

## Apex Parser Worker Fails

Symptom:

- `Cannot find module 'web-tree-sitter-sfapex'`

Why:

- the Node-side Apex worker dependency is missing

What to do:

```bash
npm install
```

for source installs, or ensure the launcher package is the published build with bundled Node dependency metadata.

## Query Returns Empty Results

Symptom:

- server is healthy, but `query` or trace tools return nothing useful

Check:

- was `ingest_org` run successfully?
- does `get_ingestion_status()` show current graph state?
- are there parse failures or unresolved symbols?
- are you querying the right workspace/project scope?

Recommended first call:

- use `ask("...")` for user questions instead of raw `query("...")`
- use `analyze_*` tools directly when intent is known (field/event/component/change)

## `get_ingest_job` Seems Fast Once, Then Waits

Symptom:

- first status call returns immediately, later calls appear to wait/hang

Why:

- the daemon may be busy with long-running phases, or there may be workspace contention/restarts
- if a background job was cancelled or crashed, stale route context can make polling confusing

What to do:

- check `get_ingestion_progress()` for `state`, `phase`, `updated_at`
- check `get_ingestion_status()` for `active_job` and `vector_health`
- if needed, call `list_ingest_jobs()` and then `get_ingest_job(job_id)` using the latest active job id
- if the job is terminal and you want to continue, use `resume_ingest_job(job_id)`

Progress snapshot location:

- `<workspace-data-root>/ingestion_progress.json`

## Cancelled Job Still Consumes Resources

Symptom:

- you cancel an ingest but CPU remains high for a while

Current behavior:

- background jobs run in subprocesses and are terminated on cancel
- a short shutdown grace period may still be visible while process cleanup completes

What to do:

- poll `get_ingest_job(job_id)` until `state` is `cancelled`
- confirm no active job via `list_ingest_jobs()`
- then start the next job

## Managed Skills Dashboard Sync Errors

Symptom:

- IDE reports something like `failed to sync managed skills from dashboard`

Why:

- this is typically an IDE/cloud service issue, not an `sfgraph` server issue

What to do:

- verify the local MCP config separately
- restart the IDE
- reauthenticate if needed
- distinguish cloud “skills” sync from local MCP server startup

## Recommended Debug Bundle

When reporting a problem, include:

- MCP client / IDE name
- install method: source or `npx`
- OS and Python version
- exact config used
- first 20 to 50 log lines around the failure
- whether the issue is first-run only or reproducible every run
