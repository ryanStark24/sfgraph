# sfgraph Architecture Upgrade Plan (2026)

## Purpose

This document defines the next architecture upgrades for `sfgraph` to improve:

- answer quality versus plain LLM/native code search
- latency and round trips per question
- ingestion throughput and reliability at large-repo scale
- OmniStudio/Vlocity coverage depth
- predictable tool behavior for MCP clients

This plan incorporates:

- current `docs/ARCHITECTURE.md`
- `docs/ARCHITECTURE_V2_IMPLEMENTATION.md`
- independent review findings from `codebase_review.md.resolved`
- independent implementation plan from `improvement_guide.md.resolved`

## What Is Already Completed

These items are implemented and validated in the current branch:

- per-directory daemon/workspace isolation
- persisted ingest job registry and recovery markers (`daemon_restarted` state)
- node lookup acceleration using `_sfgraph_node_index`
- per-edge-table source/destination indexes
- batch node/edge merge paths in ingestion
- parse-cache correctness hardening for path-derived identities
- stricter file-scope/project-scope hygiene across ingestion/query

## Independent Review Mapping

The independent review findings are tracked in three buckets:

- completed now:
  - node index acceleration
  - edge indexes
  - batch writes for nodes/edges
- in next release scope:
  - table-name sanitization
  - utility deduplication
  - phase enum contract
  - vector status truthfulness
  - daemon status/cancel robustness
- scheduled after next release:
  - variable-origin tracer
  - formula parser/tokenizer upgrade
  - advanced test-gap intelligence

## Core Product Direction

`sfgraph` should be a **hybrid evidence engine**, not “graph for every query.”

### Decision policy

- exact token/source lookup questions: lexical/symbol search first
- lineage/impact/transitive questions: graph traversal first
- semantic vector retrieval: only as fallback, and never without evidence qualification

### Output contract

Every answer should include:

- claim
- evidence (file + line and/or explicit graph path)
- confidence tier (`definite`, `probable`, `review_manually`)
- unresolved/missing evidence notes when applicable

## Major Gaps To Close Next

### 1) Query Quality and Routing

### Current problem

Questions like “where is X populated” can route into broad semantic fallback and return noisy candidates.

### Architecture change

Add a unified entrypoint:

- `analyze(question, export_dir?, mode=auto, strict=true, max_results=...)`

Internally, route through:

1. `intent_router`
2. `exact_retrieval`
3. `graph_retrieval` (only when needed)
4. `semantic_fallback` (gated)
5. `evidence_aggregator`
6. `confidence_resolver`

### Acceptance criteria

- token-level population queries return exact assignments first
- graph-only claims are downgraded unless corroborated by lexical/symbol evidence
- fewer tool calls for common asks (single `analyze` in most cases)

### 2) Tool Surface and Round-Trip Reduction

### Current problem

Client orchestration is too manual (`search_node` + `trace` + `explain_field` + ad hoc follow-up calls).

### Architecture change

Keep job tools as-is, but simplify query tools:

- Primary: `analyze`
- Optional expert/debug: `trace_upstream`, `trace_downstream`, `query`, `get_node`

`analyze` should return a structured bundle:

- `summary`
- `evidence[]`
- `confidence_tier`
- `next_best_query` suggestions (optional)
- `tool_trace` (for observability/debug)

### Acceptance criteria

- average query completes in <= 1–2 tool calls
- explicit confidence + evidence sections in response payloads

### 3) Vlocity/OmniStudio Coverage Depth

### Current problem

Large portions of Vlocity files are skipped or only shallowly parsed; some skipped families are operationally critical.

### Required parser work

Deep parsers must include (at minimum):

- `*_PromotionItems.json`
- `*_PriceListEntries.json`
- `*_InterfaceImplementationDetails.json`
- `*_ProductChildItems.json`

For each, emit typed nodes/edges (not generic stubs only), with relationship semantics used by lineage queries.

### Policy for unsupported artifacts

- no silent skip
- emit explicit stub node with reason code (`unsupported_type`, `malformed_payload`, etc.)
- include skip reason in ingestion progress and final report

### Acceptance criteria

- skipped_vlocity ratio materially reduced on benchmark datasets
- newly parsed families appear in query results with concrete evidence

### 4) Ingestion Reliability and Responsiveness

### Current problem

Background work can still create confusion around cancellation semantics and readiness/health behavior.

### Architecture change

- make cancellation cooperative and explicit in worker-thread model
- preserve API responsiveness under active ingest
- keep per-directory daemon isolation strict
- add deterministic health/readiness/status endpoints independent of active export context

### Acceptance criteria

- `cancel_ingest_job` cannot leave “ghost running” background work
- status/health calls succeed before and during ingest
- concurrent projects do not contend on storage/runtime state

### 5) Metadata Discovery and Root Scope

### Current problem

Discovery and “exact evidence” search can be too layout-specific.

### Architecture change

- read package roots from `sfdx-project.json` when present
- support monorepo/multi-package directory layouts
- apply discovered roots to both ingest discovery and exact query scan paths

### Acceptance criteria

- no hard dependency on `force-app/main/default/...`
- consistent behavior across package-directory layouts

### 6) Vector and Semantic Reliability

### Current problem

Vectorization may fail under offline/no-model conditions while upper layers appear successful.

### Architecture change

- make vector mode explicit: `enabled`, `disabled`, `degraded`, `failed`
- do not report vector success when vector index is unavailable
- expose vector health in job status and ingest summary

### Acceptance criteria

- status accurately reflects vector availability
- no silent semantic degradation

### 7) Store and Security Hardening

### Required changes

- sanitize/validate dynamic table identifiers for labels/edge types
- centralize duplicated utility functions (`_parse_props`, sha256, scope helpers)
- replace silent exception swallowing with structured debug/warn logs
- phase values backed by typed enum contract

### Acceptance criteria

- no dynamic SQL table interpolation without allowlist validation
- duplicated utility logic removed from core modules
- invalid phase values impossible at runtime

## LLM Usage Contract (Critical)

To improve quality and reduce tool spend, client/system prompts should enforce this policy:

1. Use `analyze` first for most questions.
2. Use strict exact mode for token-level asks:
   - “where is X populated/assigned/updated?”
3. Use lineage mode for impact/transitive asks:
   - “what happens when QuoteLineItem is inserted?”
4. Require evidence in every answer:
   - file + line and/or graph path
5. If only semantic evidence exists, mark `review_manually`.

## Recommended question envelope

```json
{
  "question": "Where is Service_Id__c populated?",
  "mode": "exact",
  "strict": true,
  "max_results": 20
}
```

## Example routing matrix

- “where is accessId populated” -> `exact`
- “what happens when QuoteLineItem is inserted” -> `lineage`
- “what breaks if we change X” -> `impact`
- “find related serviceability logic” -> `exploratory` with bounded semantic fallback

## Performance and Quality Targets

### Query targets

- P50 answer latency (non-ingest): <= 1.5s
- P95 answer latency (non-ingest): <= 5s
- median tool calls per answer: <= 2

### Ingest targets

- improved files/sec versus previous baseline on same dataset
- reduced Vlocity skipped ratio for critical artifact families
- cancellation and status correctness under concurrent workloads

### Quality targets

- higher precision for “where populated” queries
- lower semantic-only false positives
- explicit confidence tier and evidence for every result

## Implementation Workstreams

### WS1: Query Orchestration

- introduce `analyze` API/tool
- intent router with deterministic rules
- unified evidence/confidence payload

### WS2: Retrieval Engine

- exact lexical + symbol retrieval first-class
- graph traversal bounded by budgets
- semantic fallback gating + lexical corroboration

### WS3: Vlocity Deep Parsing

- implement critical skipped families
- add reasoned stubs for unsupported payloads
- surface parse coverage metrics by family

### WS4: Runtime and Job Robustness

- cancellation guarantees in worker-thread execution
- health/status behavior decoupled from active export selection
- durable/recoverable job semantics

### WS5: Storage and Safety

- dynamic identifier validation
- utility deduplication
- phase enum + structured error logging

### WS6: Validation and Benchmarking

- online dataset regression suite (Apex + Vlocity)
- query acceptance suite comparing:
  - sfgraph strict exact
  - sfgraph lineage
  - plain lexical baseline
- CI thresholds for latency and quality regressions

## Release Plan

### Release N+1 (stabilization + routing)

- `analyze` with exact/lineage modes
- confidence/evidence output contract
- vector status truthfulness
- health/cancel robustness fixes

### Release N+2 (coverage + traversal quality)

- Vlocity critical-family deep parsing
- improved path traversal ranking
- lower skip ratio and better lineage completeness

### Release N+3 (advanced intelligence)

- variable-origin tracer
- stronger formula dependency parser
- test-gap and impact-analysis depth improvements

## Risks and Mitigations

- risk: `analyze` abstraction hides useful low-level controls
  - mitigation: keep expert tools and expose `tool_trace`
- risk: deeper Vlocity parsing increases ingest time
  - mitigation: feature flags, parser budgets, targeted profiling
- risk: strict exact mode misses fuzzy intent
  - mitigation: controlled fallback path with explicit downgrade labels

## Definition of Done for This Architecture Upgrade

- `analyze` becomes default query path in MCP usage guidance
- token-level “where populated” queries prefer exact evidence and reduce false positives
- ingestion reports clear skip reasons and better Vlocity coverage for critical families
- status/health/cancel behavior remains responsive under active background ingest
- benchmark suite demonstrates measurable improvements in latency, precision, and tool-call count
