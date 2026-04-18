# Salesforce Org Graph Analyzer

## What This Is

A local, fully-embedded static analysis MCP tool that ingests a Salesforce org's metadata export and builds a property graph representing every relationship between Apex classes, LWC components, Flows, Vlocity DataPacks, SObjects, fields, Custom Labels, Custom Settings, and Custom Metadata Types. Exposed as an MCP server so any MCP-compatible LLM client (Claude, Cursor, VS Code Copilot) can query the org's dependency graph in natural language. Open source, production-ready, targeting the Salesforce developer and architect community.

## Core Value

A developer can ask "what breaks if I change this field?" and get a confident, sourced answer in under 5 seconds — across Apex, Flows, LWC, and Vlocity simultaneously.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Ingest Salesforce org metadata export (Apex, LWC, Flows, Objects, Labels, Settings, CMT, Vlocity) into a property graph
- [ ] Two-phase ingestion: nodes-only pass first, then relationship discovery (eliminates forward-reference ordering)
- [ ] Parse Apex/.cls/.trigger with tree-sitter-sfapex (Node.js subprocess pool)
- [ ] Parse LWC .js with the current Python LWC parser (regex-based import/wire/template extraction)
- [ ] Parse LWC .html templates with lxml (child components, field bindings)
- [ ] Parse Flow XML with ElementTree (record ops, apex calls, subflows, labels)
- [ ] Parse Vlocity DataPacks: IntegrationProcedure, OmniScript, DataRaptor (full Load/Extract/Transform mapping)
- [ ] Parse Object/Field metadata XML (SFObject, SFField, formula fields, picklist values, global value sets)
- [ ] Parse Custom Label, Custom Setting, Custom Metadata XML
- [ ] Parse Platform Event object metadata and PlatformEventSubscriberConfig
- [ ] Full graph schema: all node + relationship tables per design doc §7 (including SFPicklistValue, GlobalValueSet, PlatformEvent, ExternalNamespace nodes)
- [ ] Edge taxonomy: confidence score, resolutionMethod, edgeCategory, contextSnippet on all edges
- [ ] Source attribution on all nodes: sourceFile, lineNumber, parserType, lastIngestedAt
- [ ] Variable Origin Tracer with safety bounds (depth=5, cost=50, cycle detection)
- [ ] Dynamic Accessor Registry (YAML config, org-specific utility method mapping)
- [ ] Formula field parser (field formulas, validation rules, workflow updates, approval criteria)
- [ ] DuckPGQ embedded graph store (DuckDB-first runtime)
- [ ] GraphStore abstraction protocol (DuckPGQStore primary + FalkorDBStore compatibility)
- [ ] Qdrant local vector index (source code chunks per node)
- [ ] SQLite manifest for incremental refresh (SHA-256 file hashing)
- [ ] Incremental refresh: dirty-file-only re-ingestion + affected-node re-discovery
- [ ] File watcher for real-time mode (watchdog, 2s debounce)
- [ ] Node.js worker pool hardening (health checks, memory ceiling at 200 files, replay mode)
- [ ] Three-agent query pipeline: Schema Filter (Haiku) → Query Generator (Sonnet) → Result Formatter (Sonnet)
- [ ] Iterative Cypher correction loop (max 4 iterations with error feedback)
- [ ] Result Formatter structured output contract (TRAVERSE vs ANSWER, hop budget=3)
- [ ] Confidence tier output: Definite / Probable / Review manually
- [ ] TRACE_LIMIT_HIT UX contract (attribution to code complexity, not tool weakness)
- [ ] MCP server exposing job-native ingestion tools: start_ingest_job/start_refresh_job/start_vectorize_job + polling/status/query tools
- [ ] PyPI-publishable package with README, CLI entrypoint, contributor docs

### Out of Scope

- Visualforce pages — not parsed in v1 (legacy, low priority for new orgs)
- Aura Components — not parsed in v1 (LWC-first policy; Aura is legacy)
- Managed package internals — source not in export, stub nodes only
- Runtime analysis — no live org data, no execution tracing
- Deployment tooling — read-only analysis only
- Permission Set / Profile layer (FLS graph) — v2
- Risk scoring layer — v2 (needs v1.5 precomputed traversal cache)
- Graph versioning / snapshots — v1.5
- Test coverage overlay — v2
- DuckPGQ migration — only if FalkorDBLite shows instability

## Context

- Full design locked at v6.1 (2026-04-03) after two rounds of review (Gemini + ChatGPT)
- Design doc covers architecture, parser specs, graph schema DDL, query layer, confidence scoring, and incremental refresh in full detail
- No Salesforce org export available for testing during initial build — will integrate test fixtures or a real org export later
- Target audience: Salesforce developers and enterprise architects dealing with large orgs (2k+ classes, 800 LWC, 300 Flows, 200 Vlocity IPs)
- Must be production-ready OSS from the start: PyPI package, README, docs, contributor guide

## Constraints

- **Embedded only**: All components (graph DB, vector index, manifest) run locally — no cloud deps, no external services, no data leaves the machine
- **License**: FalkorDBLite (New BSD) for embedded mode; DuckPGQ (MIT) as fallback — no copyleft, enterprise-safe
- **Python**: 3.12+ orchestration runtime; `uv` for package management
- **Node.js**: Required for tree-sitter subprocess pool (Apex + LWC JS parsing)
- **Performance**: Cold ingest < 3 min for large org; incremental refresh < 5s; query pipeline < 5s
- **No test org available initially**: Build with synthetic fixtures; integrate real org in later phases

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| DuckPGQ-first runtime | Current shipped runtime uses DuckPGQ/DuckDB for embedded graph operations with workspace-scoped storage | Implemented |
| Two-phase ingestion (nodes first, then edges) | Eliminates all forward-reference ordering problems; every node exists before any edge is attempted | — Pending |
| GraphStore abstraction protocol | Decouples all ingestion/query logic from FalkorDB API; enables DuckPGQ fallback; ~2 day cost for major future flexibility | — Pending |
| Variable Origin Tracer safety bounds (depth=5, cost=50) | Prevents O(n²) on pathological orgs; TRACE_LIMIT_HIT is a signal not an error | — Pending |
| Node.js subprocess pool for tree-sitter | tree-sitter-sfapex runs in Node.js only; pool amortizes grammar load cost across 2k+ files | — Pending |
| Three-agent query pipeline | Schema Filter reduces token cost 20-40x vs full schema injection; Sonnet only for generation + formatting | — Pending |
| Agent 3 structured output contract | Separates TRAVERSE vs ANSWER decision from prose formatting; orchestrator handles looping, not agent | — Pending |
| contextSnippet on all edges | 1-3 line source excerpt at near-zero cost (tree-sitter gives line numbers free); makes answers actionable | — Pending |
| Picklist false-positive guard | Field context REQUIRED before READS_VALUE edge; under-report rather than over-report high-confidence false edges | — Pending |
| v1 + incremental refresh | Incremental refresh fully spec'd in §11; worth including in v1 for real developer workflow | — Pending |
| Open source, production-ready from day 1 | PyPI package, README, contributor docs included in scope | — Pending |

---
*Last updated: 2026-04-03 after initialization*
