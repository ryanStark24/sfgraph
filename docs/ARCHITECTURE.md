# Architecture

`sfgraph` is a local-first Salesforce metadata analysis system with three core responsibilities:

- ingest Salesforce metadata into a scoped graph
- persist graph, manifest, and vector state locally
- answer lineage, impact, and troubleshooting questions over CLI and MCP

This document describes both:

- the current architecture
- the target architecture for the next generation of faster, more robust, more transparent ingest

## Goals

The architecture is optimized for:

- evidence over prose
- local execution over hosted processing
- explicit handling of unknown and dynamic edges
- project isolation
- predictable ingest behavior on large production exports
- release-safe defaults where client code and metadata stay on the client machine

## Hard Runtime Rules

The intended runtime policy is:

- metadata parsing happens locally
- graph persistence happens locally
- vector persistence happens locally
- client code and metadata do not leave the machine during normal analysis

Current enforced default:

- remote LLM query-agent calls are disabled unless `SFGRAPH_ALLOW_NETWORK=1`
- embedding model downloads are disabled unless `SFGRAPH_ALLOW_NETWORK=1`

Allowed network access outside of core metadata analysis still exists during installation/bootstrap, for example:

- npm package download
- Python package installation
- optional model prefetch during explicit bootstrap

## High-Level Flow

Current high-level flow:

```text
metadata export
  -> discovery
  -> parsers
  -> node/edge facts
  -> graph store + manifest + vectors
  -> query service
  -> MCP tools / CLI
```

Target high-level flow:

```text
metadata export
  -> ingest job creation
  -> discovery phase
  -> parse queue
  -> node write queue
  -> edge write queue
  -> optional vector queue
  -> query service / MCP polling
```

## Current Components

### Ingestion

Ingestion lives under `src/sfgraph/ingestion/`.

Responsibilities:

- discover supported files in an export
- parse Apex, Aura, Flows, objects, workflow metadata, permission metadata, reports, dashboards, named credentials, LWC, and Vlocity assets
- normalize parser output into `NodeFact` and `EdgeFact`
- write scoped graph rows
- track run/file status in the manifest
- persist ingest progress snapshots
- update vector search chunks

Important files:

- [`src/sfgraph/ingestion/service.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/ingestion/service.py)
- [`src/sfgraph/ingestion/models.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/ingestion/models.py)
- [`src/sfgraph/ingestion/scope_migration.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/ingestion/scope_migration.py)
- [`src/sfgraph/ingestion/snapshot.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/ingestion/snapshot.py)

### Parsers

Parsers live under `src/sfgraph/parser/`.

Current parser coverage:

- Apex CST extraction
- Aura bundle markup (`.cmp`, `.app`, `.evt`, `.intf`)
- Flow XML
- Object, field, formula, and validation-rule XML
- Legacy workflow XML (`.workflow-meta.xml`)
- Permission set and profile XML
- Report XML
- Dashboard XML
- Named credential XML
- LWC JS/HTML metadata references
- OmniStudio / Vlocity JSON

Important notes:

- the Apex path uses a Node worker with `web-tree-sitter-sfapex`
- the Aura path is intentionally lightweight today and extracts bundle identity, Apex controller usage, and local child-component references
- rich Vlocity parsing currently exists for:
  - `IntegrationProcedure`
  - `DataRaptor`
  - `OmniScript`
- other supported Vlocity types currently fall back to generic `VlocityDataPack` parsing

Important files:

- [`src/sfgraph/parser/pool.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/parser/pool.py)
- [`src/sfgraph/parser/worker/worker.js`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/parser/worker/worker.js)
- [`src/sfgraph/parser/vlocity_parser.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/parser/vlocity_parser.py)
- [`src/sfgraph/parser/vlocity_registry.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/parser/vlocity_registry.py)

### Storage

Storage lives under `src/sfgraph/storage/`.

Current runtime model:

- graph store: DuckDB-backed property graph tables
- manifest store: SQLite file state and run tracking
- vector store: local Qdrant path storage for semantic fallback

Important note:

- FalkorDB exists as an optional backend path, but the default product flow is DuckDB-based

### Query Layer

Query logic lives under `src/sfgraph/query/`.

Responsibilities:

- node lookup and scoped/unscoped resolution
- upstream and downstream lineage tracing
- evidence-first edge/path formatting
- git-diff impact analysis
- cross-layer flow map generation
- unknown dynamic edge reporting
- heuristic or optional LLM-assisted query shaping

Important files:

- [`src/sfgraph/query/graph_query_service.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/query/graph_query_service.py)
- [`src/sfgraph/query/rules_registry.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/query/rules_registry.py)
- [`src/sfgraph/query/agents.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/query/agents.py)

### MCP Server

The MCP server lives in [`src/sfgraph/server.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/server.py).

Responsibilities:

- initialize runtime storage handles
- expose MCP tools over `stdio`
- enforce workspace-local export path validation
- return structured JSON for each tool

## Project Isolation Model

`sfgraph` is designed to avoid cross-project contamination.

Isolation mechanisms:

- graph node keys are stored as `projectScope::qualifiedName`
- vector search is filtered by `project_scope`
- ingestion freshness metadata records `project_scope` and export path
- MCP ingest paths are restricted to the current workspace root
- nested repositories inside the export tree are skipped during discovery

Recommended practice:

- use a separate data directory for each project
- run one MCP server instance per workspace

## Runtime Layout

Source install default:

- `./data/sfgraph.duckdb`
- `./data/manifest.sqlite`
- `./data/vectors/`

npx bootstrap default:

- cached Python runtime under the user cache directory
- workspace-specific data under:
  - `~/Library/Caches/sfgraph-mcp/workspaces/<hash>/data` on macOS

## Current Strengths

The current system already does a few important things well:

- local parsing rather than hosted parsing
- scoped graph identity to prevent cross-project contamination
- explicit progress snapshot persistence
- evidence-first query output instead of opaque prose summaries
- baseline Vlocity coverage across a broader type inventory than before

## Current Weaknesses

The current ingest architecture has moved to durable background jobs with per-workspace isolation, but still has practical limits.

### 1. Internal cleanup still trails the public tool model

The blocking MCP wrappers have been removed, and the public ingest surface is now job-native.

Consequences:

- new integrations have one clear model: `start_*_job` plus polling APIs
- internal cleanup can now focus on simplifying transition-era code paths instead of supporting two public models

### 2. Job model is first-class, with persisted state and resume support

Ingest/refresh/vectorize are job-native with durable metadata in SQLite (`ingest_jobs.sqlite`) and persisted progress snapshots.

Consequences:

- stable `job_id` for polling and cancellation
- `list_ingest_jobs` and `get_ingest_job` survive daemon restart
- queued/running jobs are marked failed as `daemon_restarted` on recovery
- `resume_ingest_job(job_id)` can create a checkpoint-aware resumed job (`resume_checkpoint=true`)

### 3. Vector work can still influence critical-path behavior

Vector updates currently still happen in the ingest flow (except explicit `graph_only` mode), but status now reports vector health explicitly.

Consequences:

- graph ingest latency can be coupled to embedding availability
- first-use model readiness can delay ingest unless pre-cached
- status endpoints now expose `vector_health` so failures are visible instead of silent

### 4. Discovery is still heavier than it should be

Even after pruning improvements, production trees can still contain:

- huge JSON volumes
- generated files
- exports with low-value or repetitive metadata classes

Consequences:

- file hashing and traversal can dominate ingest time
- users perceive “slow ingest” before parser throughput is even the bottleneck

### 5. Vlocity coverage is broader, but semantic depth still varies

We recognize the upstream-supported type inventory and now parse additional non-object array families used in real OmniStudio exports, including wrapped-array forms:

- `*_PromotionItems.json`
- `*_PriceListEntries.json`
- `*_InterfaceImplementationDetails.json`
- `*_ProductChildItems.json`

Consequences:

- baseline coverage exists
- full semantic richness does not yet exist across all Vlocity types

### 6. Job execution model

Background jobs run in isolated subprocesses (not worker threads) so cancellation can terminate active work deterministically.

Consequences:

- API status/health endpoints stay responsive during long ingests
- cancellation now performs hard-stop process termination for active background jobs
- no same-process thread linger after `cancel_ingest_job`

## Target Ingest Architecture

The target ingest architecture should be job-based, phase-aware, resumable, and local-only by default.

### Job Model

Introduce explicit ingest jobs:

- `start_ingest(export_dir, mode?) -> job_id`
- `get_ingest_job(job_id)`
- `cancel_ingest(job_id)`
- `list_ingest_jobs()`
- optional `resume_ingest(job_id)`

CLI remains the convenience wrapper for synchronous human workflows.

### Phase Model

Each job should move through explicit phases:

1. `bootstrap`
2. `discovering`
3. `parsing`
4. `writing_nodes`
5. `writing_edges`
6. `vectorizing`
7. `completed`
8. `failed`
9. `cancelled`

### Progress Contract

Progress should expose:

- `job_id`
- `state`
- `phase`
- `total_files_discovered`
- `files_hashed`
- `files_parsed`
- `files_failed`
- `nodes_written`
- `edges_written`
- `vectors_written`
- `current_file`
- `current_parser`
- `parser_breakdown`
- `elapsed_seconds`
- `estimated_remaining_seconds`
- `top_failure_reasons`

### Queue Model

Use explicit bounded queues:

- discovery queue
- parse queue
- node write queue
- edge write queue
- vector queue
- retry queue

Benefits:

- backpressure becomes visible
- parser workers are isolated from DB write latency
- vector work can be deferred or disabled without affecting graph ingest

### Recommended Modes

Support explicit ingest modes:

- `graph_only`
- `graph_plus_vectors`
- `vectors_only`

Recommended default for large orgs:

- start with `graph_only`
- run vectorization as a second job

## Efficiency Plan

### 1. Reduce discovery cost

Recommended improvements:

- keep nested repo pruning
- continue aggressive directory skipping
- skip low-value/generated trees by policy
- allow configurable include/exclude patterns
- hash only candidate files rather than broad trees

Potential future additions:

- manifest-assisted fast stat comparison before hashing
- shallow discovery caches per export root

### 2. Keep large Apex files off the pipe

This is now already improved:

- the worker reads from disk during normal ingest instead of receiving full file bodies inline

Additional future improvements:

- length-prefixed IPC as a fallback transport
- explicit large-file handling metrics

### 3. Batch graph writes harder

Recommended improvements:

- larger node merge batches
- larger edge merge batches
- write ordering by type plus batch size tuning
- optional commit checkpoints per phase

### 4. Make vectors secondary

Recommended improvements:

- default to graph-first ingest
- defer vector creation to a second phase or a second job
- support vector disabling for privacy-sensitive or speed-sensitive use cases

### 5. Add warm bootstrap

There should be an explicit bootstrap step that prepares everything before ingest:

- create venv
- install Python dependencies
- install Node dependencies
- verify parser worker startup
- optionally prefetch embedding model locally
- record runtime readiness

Recommended bootstrap modes:

- `bootstrap-minimal`
- `bootstrap-full`

### 6. Improve skip accounting

Recommended improvements:

- distinguish `ignored`, `unsupported`, `empty`, and `failed`
- report unsupported Vlocity types explicitly
- make “skipped” actionable rather than opaque

## Vlocity Target Design

The current target should be:

- baseline support for all upstream-listed DataPack types
- rich parsers for the highest-value types first

Recommended rollout:

1. keep generic `VlocityDataPack` fallback for all types
2. add unsupported-type reporting by frequency
3. add rich parsers incrementally for the highest-volume / highest-value types

Useful source of truth:

- upstream `vlocity_build` supported type inventory

## Privacy and Security Design

The product promise should be:

- client code and metadata do not leave the machine during normal analysis

To preserve that, the architecture should enforce:

- no implicit remote query shaping
- no implicit model downloads during ingest
- no hidden hosted parsing
- explicit opt-in for all outbound runtime calls

The only acceptable network-by-default surface should be installation/bootstrap, not metadata analysis.

## Recommended Next Implementation Steps

Highest ROI sequence:

1. introduce background ingest jobs with `job_id`
2. expose true job polling APIs over MCP and CLI
3. split vectorization into a separate phase or job
4. add richer skip / unsupported-type accounting
5. add configurable discovery include/exclude rules
6. add warm bootstrap with dependency and model prefetch
7. add resumable ingest checkpoints

## Release Readiness Gates

Before release, the tool should satisfy:

### Correctness

- no nested repos indexed
- no cross-project graph contamination
- large Apex files ingest without IPC chunk failures
- Vlocity fallback covers all known upstream type names

### UX

- users can see meaningful progress during ingest
- users can tell whether the run is parsing, writing, or vectorizing
- failures surface with reasons, not silent skips

### Privacy

- no client metadata leaves the machine by default
- remote features require explicit opt-in

### Performance

- large exports remain responsive
- critical-path ingest does not block on optional vector work
- discovery cost is bounded and explainable

## V3 Hybrid Retrieval Architecture (Next)

This section defines the next architecture needed to consistently outperform native LLM-only repo search on both:

- token-level exact lookups
- multi-hop lineage/impact reasoning

### Design Principles

- exact-first for deterministic questions
- graph-first for lifecycle/impact questions
- semantic retrieval only as gated fallback
- one-call UX (`analyze`) with internal orchestration
- evidence and confidence in every answer payload

### Retrieval Pipeline

`analyze(...)` should execute a three-lane pipeline internally:

1. lexical lane
2. graph lane
3. semantic lane

Routing policy:

- token lookup / field assignment intent:
  - lexical lane first
  - graph lane only if lexical confidence is low
- object lifecycle / change impact intent:
  - graph lane first
  - lexical corroboration when available
- broad discovery intent:
  - lexical lane first
  - semantic lane only when lexical+graph are insufficient

### Lane Responsibilities

#### 1) Lexical lane (fast certainty)

Responsibilities:

- symbol/token resolution
- file+line extraction for direct assignment/use evidence
- low-latency “where is X set/used” answers

Target behavior:

- return exact locations before any semantic ranking
- avoid vector calls for deterministic matches

#### 2) Graph lane (structured reasoning)

Responsibilities:

- event lifecycle analysis (`insert/update/delete`)
- impact analysis (`what breaks if I change X`)
- transitive upstream/downstream traversal

Target behavior:

- produce path evidence with relation semantics
- separate definite/probable evidence in response

#### 3) Semantic lane (fallback only)

Responsibilities:

- recover from sparse lexical/graph matches
- suggest candidate components for manual review

Target behavior:

- only run when exact lanes fail confidence gate
- always mark semantic-only conclusions as lower confidence

### Confidence Gate Contract

Before escalating to the semantic lane, evaluate:

- evidence count
- evidence quality (file+line, explicit edge path, or both)
- intent-specific minimums

If confidence threshold is met:

- return immediately
- include `routing.stages` and `confidence_tiers`

If threshold is not met:

- run semantic fallback
- return explicit review guidance

### Tool Surface Contract

Primary query tool:

- `analyze(...)`

Expert/debug tools remain available but non-default:

- `query(...)`
- `trace_upstream(...)`
- `trace_downstream(...)`
- `get_node(...)`

The default client policy should be:

- call `analyze` first
- only call expert tools when `analyze` returns insufficient evidence

### LLM Integration Contract

Recommended LLM request policy:

- token-level asks:
  - `mode=exact`, `strict=true`
- impact/lifecycle asks:
  - `mode=lineage`, `strict=true`
- broad discovery:
  - `mode=auto`, `strict=true`

Response policy:

- include claim + evidence + confidence
- include unresolved gaps when evidence is weak
- avoid presenting semantic candidates as definitive facts

### KPI Targets

Track quality and cost by question class:

- exactness@1 for token-level questions
- lineage correctness for lifecycle/impact questions
- tool calls per user question
- prompt/input tokens per user question
- p50/p95 latency per route
- follow-up clarification rate

Target outcomes for next release:

- 30–60% fewer tool calls
- 40–70% lower input tokens
- higher exactness than native search on lineage/impact questions
- parity or better exactness on token-level lookups

### Implementation Waves

Wave 1 (now):

- finalize route policy and confidence gating in `analyze`
- normalize quality-gate scoring for routed responses
- publish architecture + evaluation suites

Wave 2:

- strengthen lexical extraction for assignment/use questions
- improve Vlocity semantic depth for high-value skipped families
- expand acceptance suites by query class

Wave 3:

- add explicit reranking/fusion strategy for semantic fallback
- unify observability across routing, evidence, and latency
- harden planner with regression gates in CI

## Summary

The current architecture is now substantially safer and more scalable than the original shape, but the next major win is not another parser tweak.

The next major win is a job-based ingest architecture:

- faster in practice
- easier to monitor
- easier to resume
- easier to keep local-only
- much more trustworthy for large production orgs

And for query quality, the next major win is hybrid retrieval orchestration:

- lexical certainty first
- graph reasoning second
- semantic fallback only when required

## Modular Standards and Diagnostics

Recent implementation work adds small swappable modules rather than expanding
monolithic services:

- `src/sfgraph/contracts.py`
  - interface seams for standards providers, parser adapters, retrieval
    engines, and diagnostics reporters
- `src/sfgraph/vlocity_standards.py`
  - standards-driven Vlocity rule bundle resolution
- `src/sfgraph/ingestion/diagnostics.py`
  - markdown diagnostics export
- `src/sfgraph/query/graph_visualizer.py`
  - Mermaid/json graph neighborhood rendering

This keeps standards sources, visualization output, and diagnostics rendering
replaceable without forcing storage or parser rewrites.
