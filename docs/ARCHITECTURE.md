# sfgraph Architecture

## Purpose and Audience

This is the single master architecture document for `sfgraph`.

It is written for:

- architects reviewing system direction
- engineers implementing or refactoring core subsystems
- maintainers validating whether new work fits the platform contract

It replaces the previous split across implementation plans, upgrade plans, and roadmap notes.

## Executive Summary

`sfgraph` is a local-first Salesforce code-intelligence system. It ingests Salesforce metadata and OmniStudio/Vlocity assets into a scoped graph, persists that graph locally, and answers code-structured questions through CLI and MCP.

The system is designed to win against plain LLM/native search in one specific way:

- less context
- better context
- more structured context
- stronger evidence contracts

The architecture is explicitly optimized for:

- CLI-first ingest
- `analyze`-first query orchestration
- standards-driven Vlocity parsing
- low tool-call / low round-trip answers
- human-readable, modular, swappable code
- local execution and project isolation

## Product Goals

`sfgraph` should provide:

- exact answers for token-local questions such as "where is `Service_Id__c` populated?"
- graph-backed answers for lineage and impact questions such as "what happens when `QuoteLineItem` is inserted?"
- compact evidence payloads that reduce upstream LLM tokens
- durable ingest jobs that stay observable during long runs
- predictable behavior on large Salesforce and OmniStudio repositories

## Non-Goals

`sfgraph` is not currently trying to be:

- a universal all-language code graph engine
- an autonomous reasoning agent that replaces source-backed evidence
- a hosted code processing service
- a dynamic runtime tracer for Salesforce execution inside the org

The product is Salesforce-first. Future broader language support must fit the same evidence-first contracts and modular boundaries.

## Design Principles

### Evidence over prose

Every important claim should map to one or both of:

- file + line evidence
- explicit graph path evidence

### Local-first by default

Metadata parsing, graph persistence, and vector persistence happen locally unless the user explicitly opts into network-enabled behavior.

### Deterministic before heuristic

Routing, parsing, graph writes, and confidence promotion should be explainable. Heuristics and semantic retrieval are allowed only after exact and graph evidence are exhausted or insufficient.

### Project isolation is mandatory

Cross-project contamination is treated as a correctness bug.

### Modularity is a product requirement

The architecture must remain readable, swappable, and testable. Large modules are treated as technical debt, not a style preference.

## Runtime Policy

The intended runtime policy is:

- metadata parsing happens locally
- graph persistence happens locally
- vector persistence happens locally
- client code and metadata do not leave the machine during normal analysis

Current enforced default:

- remote LLM query-agent calls are disabled unless `SFGRAPH_ALLOW_NETWORK=1`
- embedding model downloads are disabled unless `SFGRAPH_ALLOW_NETWORK=1`

Allowed network access outside of core analysis may still occur during:

- package installation
- optional bootstrap steps
- optional org enrichment when the user provides a Salesforce CLI alias

## System Context

High-level flow:

```text
metadata export / repo
  -> discovery
  -> standards resolution
  -> parser orchestration
  -> node/edge facts
  -> graph + manifest + vector persistence
  -> query orchestration
  -> MCP / CLI responses
```

Target operational flow:

```text
repo / export
  -> ingest job creation
  -> discovery phase
  -> parse planning
  -> node batch writes
  -> edge batch writes
  -> optional vector stage
  -> persisted progress + diagnostics
  -> query service / MCP polling
```

## Current Implemented Components

### Ingestion Layer

The ingestion layer lives under `src/sfgraph/ingestion/`.

Responsibilities:

- discover supported files under one project scope
- resolve standards and parser rules
- parse Salesforce metadata families and Vlocity assets
- normalize parser output into `NodeFact` and `EdgeFact`
- batch-write graph state
- maintain manifest freshness and run state
- persist ingest progress snapshots and diagnostics

Current key modules:

- `service.py`
- `parser_dispatch.py`
- `diagnostics.py`
- `org_metadata.py`
- `models.py`
- `snapshot.py`

### Parser Layer

The parser layer lives under `src/sfgraph/parser/`.

Current parser coverage includes:

- Apex CST extraction
- Aura bundle markup
- Flow XML
- Object XML, fields, formulas, validation rules
- Workflow metadata
- Permission set and profile metadata
- Named credentials
- Reports
- Dashboards
- LWC references
- OmniStudio / Vlocity datapacks

The parser layer is intentionally mixed:

- exact structural parsers where practical
- standards-driven Vlocity parsing where rule data exists
- generic fallback parsing where type coverage exists but deep semantics are incomplete

### Standards Layer

The standards layer is the new foundation for Vlocity correctness.

Current direction:

- local datapack metadata first
- optional org metadata via Salesforce CLI alias
- bundled baseline snapshots derived from upstream reference behavior

The standards layer normalizes:

- datapack type
- primary object type
- matching key fields
- return key field
- required settings
- provenance and confidence

### Storage Layer

The storage layer lives under `src/sfgraph/storage/`.

Current default runtime:

- DuckDB-backed graph tables
- SQLite-backed manifest and job state
- local Qdrant path storage for vectors

Important note:

- FalkorDB still exists as an optional backend path, but DuckDB is the primary product backend

### Query Layer

The query layer lives under `src/sfgraph/query/`.

Responsibilities:

- exact node and symbol lookup
- scoped graph traversal
- impact and lineage analysis
- evidence formatting
- hybrid lexical / graph / semantic retrieval
- markdown and Mermaid presentation support

Current key modules:

- `graph_query_service.py`
- `graph_visualizer.py`
- `rules_registry.py`
- `agents.py`

### Daemon and MCP Layer

`sfgraph` exposes a job-native runtime and an MCP server.

Responsibilities:

- isolate runtime state per workspace/export root
- manage ingest/refresh/vectorize jobs durably
- keep health/status/progress available during long jobs
- expose structured MCP tools over `stdio`

The intended client model is now:

- ingest via CLI or job-native MCP tools
- query via `analyze`
- debug via specialized tools only when necessary

## Project and Workspace Isolation

Isolation is a correctness requirement.

Mechanisms in place:

- graph node keys are stored as `projectScope::qualifiedName`
- vector search is filtered by project scope
- progress and ingest metadata record the export path and project scope
- workspaces are separated per export directory
- nested repositories inside the export tree are skipped during discovery

Recommended deployment model:

- one workspace data root per project/export directory
- one MCP server instance per workspace when possible

## Data and Artifact Layout

Typical local artifacts include:

- DuckDB graph database
- SQLite manifest store
- SQLite ingest job registry
- vector store directory
- `ingestion_progress.json`
- `ingestion_meta.json`
- `ingestion_diagnostics.md`

These artifacts form the local system of record for ingest status and graph freshness.

## Current Strengths

The current system already delivers several important architectural wins:

- local parsing rather than hosted parsing
- scoped identity and per-workspace isolation
- durable ingest job tracking
- responsive status/progress endpoints during ingest
- explicit diagnostics export
- evidence-first query payloads
- markdown and Mermaid presentation support
- broader Salesforce metadata coverage than the original implementation
- materially improved Vlocity handling compared with suffix-only parsing

## Current Weaknesses

Despite recent progress, several architectural concerns remain.

### 1. Large core modules still exist

`IngestionService` and `GraphQueryService` still carry too many responsibilities.

Consequences:

- higher refactor risk
- slower onboarding for maintainers
- harder contract testing

### 2. Vlocity semantic depth still varies by datapack family

Coverage is broader, but deep relationship extraction is not yet complete across all high-value datapack shapes.

Consequences:

- some answers still require generic fallback evidence
- some impact results are shallower than they should be

### 3. Vector work can still affect perceived ingest quality

Vector state is now reported more truthfully, but vector health remains an operational concern.

Consequences:

- semantic fallback quality can vary based on local embedding readiness
- graph ingest should remain useful even in degraded vector mode

### 4. Query orchestration is improved but not fully decomposed

`analyze` is the correct top-level pattern, but the internal query stack still needs cleaner module boundaries.

### 5. Tool and token cost can still be reduced further

The architecture has moved in the right direction, but dynamic tool disclosure, stronger caching, and local helper-model routing are still future work.

## Reference Architecture

The target reference architecture is:

```text
User Question
  -> Analyze API
    -> Intent Router
      -> Exact Retrieval
      -> Graph Retrieval
      -> Semantic Fallback
    -> Evidence Aggregator
    -> Confidence Resolver
    -> Renderers (JSON / Markdown / Mermaid)
```

The target ingest architecture is:

```text
Repo / Export
  -> Discovery
  -> Standards Resolution
  -> Parse Planning
  -> Parser Adapters
  -> Node Batch Writer
  -> Edge Batch Writer
  -> Optional Vectorizer
  -> Diagnostics Reporter
  -> Durable Job / Progress Store
```

## Ingestion Architecture

### Job Model

Ingest, refresh, and vectorize are job-native operations.

Required behavior:

- stable `job_id`
- persisted job state in SQLite
- cancellation support
- restart-aware failure markers
- progress snapshots independent of active polling

### Phase Model

The target phase contract is:

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

All external status APIs should rely on typed, validated phase values.

### Discovery

Discovery should:

- honor `sfdx-project.json` package directories when present
- fall back to default Salesforce roots only when needed
- avoid hard dependency on `force-app/main/default/...`
- skip nested repositories and low-value generated trees where appropriate

### Parser Dispatch

Parser dispatch should be centralized and data-driven.

Required properties:

- file-family routing separated from parse execution
- no storage coupling in parser adapters
- clear parser-name mapping per supported suffix or asset family

### Standards Resolution

The standards layer must resolve Vlocity behavior in this precedence order:

1. local datapack/export metadata
2. optional org metadata via alias
3. bundled baseline derived from `vlocity_build` and `vlocode` reference behavior

### Parse Outcomes

Every parsed or skipped asset should produce an explicit typed outcome.

Required categories:

- `parsed_structured`
- `parsed_generic`
- `skipped_missing_rule`
- `skipped_unsupported_shape`
- `parse_error`

Silent skips are not acceptable.

### Write Strategy

Graph writes should use batched node and edge persistence.

Required properties:

- configurable batch sizes
- stable merge semantics
- backend-safe abstraction boundaries
- truth-preserving scope handling

### Progress and Diagnostics

Progress reporting should remain low-latency and independent of heavy query work.

Required artifacts:

- `ingestion_progress.json`
- `ingestion_meta.json`
- `ingestion_diagnostics.md`

Diagnostics should summarize:

- parse failures
- skip reasons
- unresolved symbols
- vector health
- worker/runtime warnings
- standards provenance and coverage

## Parser Architecture

## Apex

Apex parsing uses a Node worker and Tree-sitter-based CST extraction.

Goals:

- stable method/class/trigger symbol extraction
- strong call and DML relationships
- low hallucination for exact lookup questions

## Aura

Aura parsing is intentionally lightweight but first-class.

Current support:

- bundle identity
- Apex controller usage
- local child component references

## Object Metadata

Object parsing should continue to own:

- object nodes
- field nodes
- formula relationships
- validation rule nodes and field references

## Permission and Security Metadata

Current support includes:

- profiles
- permission sets
- named credentials
- high-signal permission edges

Future work should deepen:

- permission aggregation semantics
- setup and integration metadata relationships

## Workflow, Reports, and Dashboards

Current support includes:

- workflow rules
- workflow field updates
- report nodes
- dashboard nodes
- dashboard-to-report relationships

## LWC

LWC coverage is still intentionally bounded and should be treated as structural/reference extraction rather than a full JavaScript reasoning engine.

## Vlocity / OmniStudio

Vlocity is the most important standards-driven parser domain in the system.

### Gold-standard references

The architecture treats these upstream sources as behavioral references:

- `vlocity_build`
- `vlocode`

### Expected standards contract

The normalized Vlocity rule bundle should include:

- datapack type
- primary object type
- matching key fields
- return key field
- query signature
- required settings
- provenance and confidence

### Coverage direction

Deep extraction must continue to improve for at least:

- `*_PromotionItems.json`
- `*_PriceListEntries.json`
- `*_InterfaceImplementationDetails.json`
- `*_ProductChildItems.json`

The system should emit typed nodes and meaningful edges instead of falling back to raw nested JSON excerpts whenever possible.

## Query Architecture

## Primary Entry Point

The default query entry point is:

- `analyze(question, export_dir?, mode=auto, strict=true, ...)`

This should remain the dominant LLM-facing surface.

## Query Modes

The routing policy is hybrid, not graph-for-everything.

### Exact mode

Use for token-local questions such as:

- where is a field populated
- where is a method called
- where is a value assigned

### Lineage mode

Use for transitive or impact questions such as:

- what happens when an object is inserted
- what breaks if this class changes
- which flows or datapacks depend on this component

### Exploratory mode

Use only when the question is broad and exact scope is unclear.

## Retrieval Pipeline

The intended retrieval stages are:

1. exact lexical retrieval
2. symbol retrieval
3. graph traversal when the question requires it
4. semantic fallback only if the earlier stages are insufficient

### Lane responsibilities

#### Lexical lane

Best for fast certainty and direct file evidence.

#### Graph lane

Best for structured lineage and impact.

#### Semantic lane

Fallback only. It should never independently produce a `definite` claim.

## Evidence Aggregation and Confidence

Every finding should carry:

- source kind
- file and line if available
- relation semantics
- confidence tier
- unresolved evidence notes where relevant

### Confidence tiers

- `definite`
  - direct assignment, direct writer edge, or exact corroborated source evidence
- `probable`
  - strong graph path or corroborated inference without direct writer proof
- `review_manually`
  - semantic-only or unresolved dynamic evidence

### Confidence rules

- vector-only evidence cannot become `definite`
- graph-only answers without lexical/source corroboration must be downgraded where correctness risk is material
- exact file evidence wins over semantic similarity

## Presentation Contract

The query layer should support multiple renderers without mixing rendering logic into core retrieval logic.

Current presentation shapes:

- structured JSON
- inline Markdown
- optional Mermaid via `include_mermaid=true`
- diagnostics markdown file export via `export_diagnostics_md(...)`

## Tool Surface Contract

### Primary tools

The preferred client path should emphasize:

- `start_ingest_job`
- `start_refresh_job`
- `get_ingest_job`
- `get_ingestion_progress`
- `analyze`
- `graph_subgraph`
- `export_diagnostics_md`

### Specialized tools

Specialized lineage/debug tools can remain available, but should not define the default user journey.

## LLM Integration Contract

When `sfgraph` is available, LLM clients should follow this policy:

1. use `analyze` first
2. use `mode=exact` for token-local questions
3. use `mode=lineage` for impact or transitive questions
4. require evidence in the answer
5. if only semantic evidence exists, present it as `review_manually`

Recommended question envelope:

```json
{
  "question": "Where is Service_Id__c populated?",
  "mode": "exact",
  "strict": true,
  "render": "markdown"
}
```

## Modularity and Swappability Standards

This is a first-class architecture constraint.

### Required subsystem contracts

Major subsystems should be structured around explicit interfaces or narrow seams such as:

- `StandardsProvider`
- `ParserAdapter`
- `GraphStore`
- `VectorStore`
- `RetrievalEngine`
- `DiagnosticsReporter`

### Required engineering rules

- parsing logic must remain separate from discovery logic
- retrieval logic must remain separate from ranking and rendering logic
- renderers must stay separate from business logic
- no parser may depend directly on storage internals
- no query engine may depend on filesystem heuristics when a retrieval abstraction exists
- policy/config thresholds should live outside core orchestration where practical

### Code health guardrails

- avoid new god files
- prefer small orchestrators with focused helpers
- require contract tests for public subsystem seams
- provide at least one fake or test double for each major replaceable subsystem

## Security and Reliability Requirements

Required hardening direction:

- sanitize dynamic table identifiers and storage-layer interpolations
- centralize duplicated utilities and scope helpers
- reduce silent exception swallowing in favor of structured warnings
- make cancellation cooperative and observable
- preserve health/status calls before and during ingest
- keep vector mode explicitly reported as `enabled`, `disabled`, `degraded`, or `failed`

## Performance and Quality Targets

### Query targets

- common developer questions answered in one tool call whenever possible
- exact questions should avoid unnecessary semantic fallback
- graph traversals should respect hop/result/time budgets

### Ingest targets

- large production exports remain phase-transparent during ingest
- status/progress polling stays responsive
- batch write paths reduce row-by-row persistence costs

### Quality targets

- no vector-only `definite` write/population answers
- no silent Vlocity skips
- structured Vlocity coverage should continue improving for critical datapack families
- evidence-first answers should outperform plain lexical/native search for supported Salesforce-structured questions

## Architecture Workstreams

The remaining architecture program should be tracked under these workstreams.

### WS1: Query decomposition

Split `GraphQueryService` into smaller modules such as:

- intent router
- exact retrieval
- lineage engine
- component analysis
- answer assembler
- presentation/renderers

### WS2: Ingestion decomposition

Continue splitting `IngestionService` into:

- discovery
- standards resolution
- parse orchestrator
- node writer
- edge writer
- progress tracker
- vectorizer

### WS3: Vlocity semantic depth

Expand standards-driven extraction and typed relationships across more datapack families and custom org-defined types.

### WS4: Tool and token efficiency

Reduce tool-schema overhead and reduce upstream payloads.

### WS5: Evaluation and benchmarking

Formalize head-to-head testing against native lexical/LLM search for common Salesforce engineering questions.

## Cost and Token Efficiency Roadmap

This roadmap is intentionally included in the master architecture because token efficiency is now a product-level architecture concern.

### Phase 1: Tool and payload minimization

Goals:

- keep `analyze` as the dominant entry point
- return structured payloads that reduce follow-up prompts
- reduce avoidable tool orchestration and formatting cost

Acceptance criteria:

- most common question types resolve with a single `analyze(...)` call
- markdown and Mermaid output reduce extra formatting turns

### Phase 2: Dynamic tool disclosure

Goals:

- avoid exposing the full MCP tool surface to the model up front
- progressively reveal specialized tools only when needed

Acceptance criteria:

- lower tool-schema prompt footprint
- no increase in user-visible round trips

### Phase 3: Local helper-model layer

Use local small models only for:

- intent routing
- lane selection
- reranking
- evidence compaction
- answer formatting

They must not:

- determine truth independently
- promote semantic-only evidence to high confidence
- replace parser or graph evidence

### Phase 4: Exact and semantic cache

Goals:

- cache repeated exact questions safely
- optionally reuse semantic candidate sets without bypassing freshness or confidence rules

Acceptance criteria:

- lower repeated-query latency
- no stale-evidence regressions after refresh

### Phase 5: Deeper evidence compaction

Goals:

- compress retrieved evidence into small, typed payloads
- preserve claim-bearing facts while stripping boilerplate

### Phase 6: Better Vlocity semantic compression

Goals:

- structurally summarize large OmniStudio/Vlocity assets
- reduce the need to pass raw nested JSON to the upstream LLM

### Phase 7: Code-based orchestration for heavy workflows

Goals:

- move benchmark and selftest execution into scripts/workflows instead of chat-heavy tool transcripts
- keep large logs and intermediate artifacts out of conversation context

### Phase 8: Evaluation and proof

Benchmarks should explicitly track:

- tool calls per question
- prompt token estimate
- response token estimate
- cache hit rate
- exact-lane success rate
- semantic fallback rate
- latency by question class
- answer precision and completeness

## Risks and Mitigations

### Risk: Vlocity complexity outpaces standards coverage

Mitigation:

- local-first standards resolution
- optional org enrichment
- explicit skip reasons and diagnostics
- phased family-by-family deep extraction

### Risk: small local models distort evidence quality

Mitigation:

- keep helper models out of the truth path
- retain deterministic confidence gates
- benchmark helper-model usage against exact-only baselines

### Risk: module decomposition slows feature delivery

Mitigation:

- decompose behind stable seams
- keep external tool contracts stable
- add contract tests before major extractions

### Risk: storage abstraction becomes leaky

Mitigation:

- keep GraphStore and VectorStore responsibilities narrow
- require backend-agnostic contract tests for shared operations

## Release Readiness Gates

### Correctness

- no project-scope leakage
- no vector-only `definite` findings
- no silent skip of supported Vlocity families

### UX

- status and progress stay responsive during long jobs
- common structured questions resolve with low round trips
- markdown and Mermaid outputs are stable and usable

### Privacy

- local-first parsing remains the default
- remote/network paths require explicit opt-in

### Performance

- ingest remains phase-transparent on large datasets
- batch writes remain the default for large graph updates
- exact retrieval remains the fastest lane for token-local questions

## Definition of Done for the Architecture Program

This architecture program is complete when:

- `docs/ARCHITECTURE.md` remains the only architecture source of truth
- ingest and query orchestration are decomposed into readable subsystems
- Vlocity standards resolution is first-class and auditable
- `analyze` is the dominant client path for structured questions
- evidence contracts are enforced consistently across answer types
- token efficiency is benchmarked, not assumed
- architects can review the system from this document without needing separate plan files

## Summary

`sfgraph` is no longer just a graphing utility. It is a Salesforce-first evidence engine.

The architecture should continue moving toward:

- deterministic ingest
- standards-driven Vlocity parsing
- low-round-trip hybrid retrieval
- compact evidence handoff to LLMs
- readable and swappable subsystem boundaries

That combination is how the product becomes both cheaper to operate and more trustworthy than raw search-based prompting.
