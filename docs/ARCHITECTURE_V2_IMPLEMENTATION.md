# sfgraph V2 Architecture and Implementation Plan

## Purpose

This document defines the next architecture for `sfgraph` to improve:

- answer quality versus plain LLM/code search
- latency and tool-call cost
- ingestion throughput and operational reliability
- parser depth for Salesforce + OmniStudio/Vlocity

It is implementation-oriented and designed to be executed across staged releases.

## Desired Product Behavior

### Core product promise

Given a Salesforce engineering question, return the best answer with explicit evidence and low round trips.

### Query-mode policy

- Use exact code evidence first when the question is token-local.
- Use graph traversal when the question is lineage/impact/transitive.
- Use semantic fallback only when lexical + symbol retrieval is insufficient.

This is a hybrid policy, not “graph for everything.”

## Design Principles

- Evidence-first: every claim must map to file + line or graph path.
- Local-first: default runtime remains local and privacy-preserving.
- Deterministic over opaque: stable pipeline and explainable ranking.
- Progressive enhancement: fast exact path first, then deeper traversal only if needed.
- Durable operations: job IDs and statuses survive daemon restart.

## Current Gaps to Close

1. Query path still spends too many calls/steps for simple questions.
2. Ingestion and query logic live in very large modules (high change risk).
3. Some metadata/node types were declared but incompletely ingested (now partially addressed).
4. Routing/docs mismatch and stale contracts cause user confusion.
5. Graph writes are row-by-row (limited throughput at scale).

## Target Reference Architecture

```text
User Question
  -> Analyze API (single entrypoint)
    -> Intent Router
      -> Exact Retrieval (lexical + symbol)
      -> Graph Retrieval (lineage/impact)
      -> Semantic Fallback (vector)
    -> Evidence Aggregator
    -> Confidence + Conflict Resolver
    -> Final Structured Answer
```

## Runtime Components

### 1. Analyze API (single orchestration endpoint)

Add a top-level API/tool:

- `analyze(question, export_dir?, mode=auto, max_results?, strict?)`

Responsibilities:

- infer intent class
- choose minimal retrieval plan
- execute retrieval stages with budgets
- merge evidence and rank outputs
- return one unified payload

This replaces multi-tool choreography from clients for most queries.

### 2. Intent Router

Classify each question into one of:

- `exact_lookup`
- `field_lineage`
- `object_event`
- `component_trace`
- `change_impact`
- `exploratory`

Routing rules:

- `exact_lookup`: lexical + symbol only; no graph unless requested.
- `field_lineage`/`change_impact`: graph required.
- `exploratory`: lexical candidates + bounded graph expansion.

### 3. Retrieval Stack

#### Stage A: Exact lexical retrieval

- ripgrep/Zoekt-style index behavior for exact matches.
- file/path heuristics from `sfdx-project.json` package directories.
- hard cap and early-stop when high-confidence evidence exists.

#### Stage B: Symbol retrieval

- maintain symbol map for classes, methods, triggers, fields, flow elements, Vlocity entities.
- optional migration path to SCIP-compatible symbol export.

#### Stage C: Graph retrieval

- run only for lineage/impact intent.
- bounded by `max_hops`, `max_results`, `time_budget_ms`.
- produce explicit path objects and edge semantics.

#### Stage D: Semantic fallback

- vector search only when A/B/C are insufficient.
- include lexical confirmation gate before asserting writes/population.

### 4. Evidence Aggregator and Confidence Resolver

Per finding, store:

- source (`lexical`, `symbol`, `graph`, `vector`)
- file + line (if available)
- relation semantics (read/write/call/update)
- confidence score

Confidence tiers:

- `definite`: exact assignment or direct graph writer edge with file evidence
- `probable`: inferred by graph path or strong semantic relation
- `review_manually`: semantic-only or unresolved dynamic references

Conflict handling:

- exact file evidence wins over vector-only findings
- graph-only assertions downgraded if no source corroboration

## Ingestion Architecture V2

### 1. Pipeline decomposition

Split `IngestionService` into modules:

- `discovery.py`
- `parse_orchestrator.py`
- `node_writer.py`
- `edge_writer.py`
- `progress_tracker.py`
- `vectorizer.py`

### 2. Phase model contract

Introduce a typed enum for phases:

- `bootstrap`
- `discovering`
- `planning_refresh`
- `parsing`
- `writing_nodes`
- `writing_edges`
- `vectorizing`
- `completed`
- `failed`
- `cancelled`

All progress snapshots and APIs must validate against enum values.

### 3. Batch write strategy

DuckDB write optimization:

- buffer nodes/edges and write in configurable batches (e.g., 500–5000 rows)
- single transaction per batch
- preserve idempotent merge semantics

Target outcome:

- reduce DB round trips and improve ingest throughput for large orgs.

### 4. Parser coverage roadmap

Coverage tiers:

- Tier 1 (must): Apex, Flow, Object/Field, Labels, DataRaptor, IntegrationProcedure, OmniScript
- Tier 2 (must): GlobalValueSet, CustomMetadataRecord, CustomMetadataField
- Tier 3 (deepen): crucial companion arrays and relationship-rich Vlocity packs

Rule:

- represent unsupported but recognized assets as explicit stubs with reason codes, never silent skips.

### 5. Workspace and job durability

Already introduced:

- per-directory workspace isolation
- persisted job store (`ingest_jobs.sqlite`)

Next additions:

- optional resume checkpoints for long jobs
- per-job replay diagnostics
- retention policy for historical job records

## Query-Service Decomposition V2

Split `GraphQueryService` into:

- `intent_router.py`
- `exact_retrieval.py`
- `lineage_engine.py`
- `component_analysis.py`
- `change_impact.py`
- `answer_assembler.py`

This reduces blast radius and improves testability.

## Tool Surface Simplification

### Keep job-native ingest tools

- `start_ingest_job`
- `start_refresh_job`
- `start_vectorize_job`
- `get_ingest_job`
- `list_ingest_jobs`
- `cancel_ingest_job`

### Consolidate query tools

Primary:

- `analyze(...)`

Specialized (still exposed, but internally routed through same engine):

- `analyze_field`
- `analyze_object_event`
- `analyze_component`
- `analyze_change`

Deprecate direct multi-hop tools for end users over time, but keep for debugging.

## LLM Integration Contract

### Required system guidance

When `sfgraph` is available:

1. Attempt `analyze(...)` first.
2. For strict token lookup, request `mode=exact`.
3. For impact questions, request `mode=lineage`.
4. Report confidence tier and evidence count.
5. If only semantic evidence exists, mark as `review_manually`.

### Prompt shape for best results

Preferred input structure:

- question
- expected object/component scope
- strictness (`exact` vs `best_effort`)
- max evidence rows

## Security and Reliability

### Immediate hardening items

- Remove hardcoded Node path and use `SFGRAPH_NODE_BINARY`/`which node` resolution.
- Validate DuckDB table identifiers with strict allowlist.
- Centralize shared utility functions (`parse_props`, sha helpers) to reduce drift.
- Replace silent exception swallowing with structured debug logs.

## Performance and SLO Targets

### Query

- p50 exact lookup: <= 1.5s
- p95 exact lookup: <= 4s
- p95 lineage query: <= 8s

### Ingest

- full ingest (mid-size repo): <= 3 minutes
- incremental refresh (small diff): <= 10 seconds

### Quality

- exact lookup precision@1: >= 0.9
- lineage writer precision@1: >= 0.8
- unresolved-dynamic disclosure rate: 100% for unknown dynamic edges

## Evaluation Harness

Create benchmark suites:

- `lookup_suite.json` (token-local questions)
- `lineage_suite.json` (impact and upstream/downstream)
- `cross_layer_suite.json` (Apex/Flow/Vlocity transitions)

Track metrics per run:

- latency, tokens, tool calls, evidence count, confidence tier, correctness label.

## Delivery Plan

### Phase 1: Safety + consolidation (1 sprint)

- Node path fix
- identifier sanitization
- shared utils extraction
- phase enum validation

### Phase 2: Query architecture (1–2 sprints)

- `analyze(...)` endpoint
- intent router
- confidence-tier resolver
- exact-first policy enforcement

### Phase 3: Ingest throughput and decomposition (2 sprints)

- batch write pipeline
- service module split
- parser telemetry unification

### Phase 4: Advanced reasoning (2+ sprints)

- bounded Variable Origin Tracer
- confidence-calibrated graph + lexical fusion
- optional SCIP symbol interoperability

## Independent Review Adjudication

This section records disposition of key findings from `/Users/anshulmehta/Downloads/codebase_review.md.resolved`.

### Still valid

- hardcoded Node binary path
- DuckDB identifier sanitization gap
- duplicated `_parse_props`/sha helpers
- oversized service/query modules
- missing typed phase enum
- missing batch write optimization

### Already addressed in current branch

- durable job records across daemon restart (`ingest_jobs.sqlite`)
- ingestion of `GlobalValueSet`, `CustomMetadataRecord`, and `CustomMetadataField`
- package-directory-aware discovery/search roots
- vector success/failure accounting is now truthful

### Partially valid / reframed

- “three-agent query pipeline missing”: current strategy is to prioritize deterministic routing and evidence assembly first; optional agentic enrichment remains secondary.
- “watchdog missing”: polling is intentional for portability; move to watchdog only if measured benefit is clear.

## Non-Goals for V2

- full runtime execution tracing against live org
- managed package internals beyond available source
- replacing exact search with vector-only retrieval

## Decision Gate for Release

V2 release candidate requires:

- green non-integration test suite
- benchmark deltas showing improvement on latency + correctness
- no regression in evidence fidelity
- job and progress behavior validated across daemon restarts

