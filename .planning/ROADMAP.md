# Roadmap: Salesforce Org Graph Analyzer

**Created:** 2026-04-04
**Depth:** Standard (6 phases)
**Coverage:** 111/111 v1 requirements mapped

## Phases

- [x] **Phase 1: Foundations** — Storage engines, GraphStore ABC, environment lock. Everything else is blocked on this. (completed 2026-04-04)
- [x] **Phase 2: Node.js Parser Pool + MCP Skeleton** — Prove the Python↔Node.js IPC boundary; establish stdout discipline before any tool handler is written. (completed 2026-04-04)
- [x] **Phase 3: Ingestion Pipeline Core** — Apex, Objects, Flows parsers + two-phase ingest orchestration. First queryable graph. (completed 2026-04-06)
- [x] **Phase 4: Remaining Parsers** — LWC and Vlocity parsers. Completes metadata coverage for a credible v1. (completed 2026-04-06)
- [ ] **Phase 5: MCP Tools + Query Pipeline** — All 6 tools wired; three-agent NL→Cypher pipeline with confidence tiers.
- [ ] **Phase 6: Hardening + OSS Readiness** — Variable Origin Tracer, file watcher, formula parser, Dynamic Accessor Registry, PyPI packaging, docs.

## Phase Details

### Phase 1: Foundations
**Goal**: The three storage engines initialize, pass smoke tests, and are accessible only through abstraction layers — no downstream code ever touches a storage API directly. (FalkorDB operates in server mode via the Redis protocol; ManifestStore and VectorStore are embedded/local.)
**Depends on**: Nothing
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05, FOUND-06, FOUND-07, FOUND-08
**Success Criteria** (what must be TRUE):
  1. `python -c "from sfgraph.storage import GraphStore, FalkorDBStore, VectorStore, ManifestStore"` succeeds on Python 3.12; fails to install on 3.11.
  2. A Cypher MERGE + read round-trip through FalkorDBStore completes without error, and concurrent writes serialized through the asyncio queue do not corrupt node data.
  3. Qdrant VectorStore upserts a source code chunk and retrieves it by vector similarity.
  4. ManifestStore records a file path with SHA-256, ingestion phase (PENDING/NODES_WRITTEN/EDGES_WRITTEN/FAILED), and run status; CRUD operations work correctly.
  5. A Python process running the MCP entry point emits zero bytes to stdout when only logging calls are made (verified by CI assertion).
**Plans**: 5 plans

Plans:
- [ ] 01-01-PLAN.md — Project scaffold: pyproject.toml, Python 3.12 lock, src-layout package skeleton
- [ ] 01-02-PLAN.md — Stderr discipline + CI stdout assertion + ManifestStore (SQLite state machine)
- [ ] 01-03-PLAN.md — GraphStore ABC + DuckPGQStore stub (Protocol boundary validation)
- [ ] 01-04-PLAN.md — FalkorDBStore (asyncio write queue) + VectorStore (Qdrant local + fastembed)
- [ ] 01-05-PLAN.md — FalkorDB live integration smoke tests + gap closure (docker-compose.test.yml)

### Phase 2: Node.js Parser Pool + MCP Skeleton
**Goal**: The Python↔Node.js IPC boundary is proven to work end-to-end with a real Apex file, and the FastMCP server skeleton enforces stdout discipline from the first line of code.
**Depends on**: Phase 1
**Requirements**: POOL-01, POOL-02, POOL-03, POOL-04, POOL-05, POOL-06, POOL-07, MCP-01
**Success Criteria** (what must be TRUE):
  1. A pool of min(cpu_count, 8) Node.js workers starts up, each loading tree-sitter-sfapex once, and parses an Apex `.cls` file returning a structured JSON payload — without spawning a new Node.js process per file.
  2. A worker that receives a `{type:"ping"}` request and fails to reply within 5 seconds is detected and automatically replaced by a healthy worker.
  3. ParseDispatcher routes a `.cls` file to the Node.js pool and a Flow XML file to the Python parser path; incorrect routing is rejected at dispatch time.
  4. The FastMCP server starts with a lifespan context manager that owns all storage handles; `curl` to the MCP endpoint returns a valid JSON-RPC response with zero stdout pollution in the server process.
  5. An Apex file with tree-sitter parse errors is detected via the `has_error` guard, logged to stderr, and returns `{ok:false}` — it does not silently produce incomplete edges.
**Plans**: 3 plans

Plans:
- [ ] 02-01-PLAN.md — npm setup + worker.js (WASM grammar, readline IPC, ping/pong, has_error guard, 200-file restart)
- [ ] 02-02-PLAN.md — NodeParserPool (asyncio subprocess management, health checks, per-file timeout) + integration tests
- [ ] 02-03-PLAN.md — ParseDispatcher (extension routing) + FastMCP server lifespan wiring + stdout discipline validation

### Phase 3: Ingestion Pipeline Core
**Goal**: A developer can point the tool at a Salesforce metadata export containing Apex classes, SObjects, and Flows and get a populated, queryable property graph with correct two-phase write order and source attribution on every node and edge.
**Depends on**: Phase 2
**Requirements**: INGEST-01, INGEST-02, INGEST-03, INGEST-04, INGEST-05, INGEST-06, INGEST-07, INGEST-08, INGEST-09, APEX-01, APEX-02, APEX-03, APEX-04, APEX-05, APEX-06, APEX-07, APEX-08, APEX-09, APEX-10, APEX-11, OBJ-01, OBJ-02, OBJ-03, OBJ-04, OBJ-05, OBJ-06, OBJ-07, FLOW-01, FLOW-02, FLOW-03, FLOW-04, FLOW-05, FLOW-06, FLOW-07, FLOW-08, GRAPH-01, GRAPH-02, GRAPH-03, GRAPH-04
**Success Criteria** (what must be TRUE):
  1. Running ingest on a fixture export completes Phase 1 (all nodes) fully before Phase 2 (all edges) begins — confirmed by manifest phase flags; a crashed mid-ingest run can be safely resumed via MERGE idempotency.
  2. Every node in the graph carries `sourceFile`, `lineNumber`, `parserType`, and `lastIngestedAt`; every edge carries `confidence`, `resolutionMethod`, `edgeCategory`, and `contextSnippet`.
  3. A Cypher query `MATCH (a:ApexClass)-[:CALLS]->(b:ApexClass) RETURN a.name, b.name` returns correct cross-class call edges extracted from Apex fixture files.
  4. A Cypher query for an SFObject returns its SFField children, including a formula field with a FORMULA_DEPENDS_ON edge and a picklist field with SFPicklistValue nodes.
  5. A Flow fixture with a record operation, an Apex action call, and a `$Label` reference produces FLOW_CALLS_APEX, FLOW_READS_FIELD, and FLOW_RESOLVES_LABEL edges in the graph.
  6. The schema_index.json file is materialized after ingest and contains all node type names, property names, and connected edge type names present in the graph.
  7. All 23 node table types from design doc §7.1 exist as labeled nodes in FalkorDB; all edge category values are constrained to DATA_FLOW / CONTROL_FLOW / CONFIG / STRUCTURAL.
**Plans**: 5 plans

Plans:
- [ ] 03-01-PLAN.md — Graph schema constants (23 node types, edge catalog, EDGE_CATEGORIES) + NodeFact/EdgeFact Pydantic models + synthetic fixture tree (Account object, picklist field, formula field, flow, Apex class)
- [ ] 03-02-PLAN.md — Object/Field XML parser: SFObject, SFField, SFPicklistValue, GlobalValueSet, PlatformEvent, CustomLabel, CustomSetting, CustomMetadataType nodes + FIELD_HAS_VALUE/FORMULA_DEPENDS_ON edges
- [ ] 03-03-PLAN.md — Apex CST full traversal: expand worker.js extractRawFacts() + Python apex_extractor.py + DynamicAccessorRegistry (config/dynamic_accessors.yaml with fflib patterns)
- [ ] 03-04-PLAN.md — Flow XML parser: Flow + FlowElement nodes + FLOW_CALLS_APEX/FLOW_READS_FIELD/FLOW_RESOLVES_LABEL/SUBSCRIBES_TO_EVENT/PUBLISHES_EVENT edges
- [ ] 03-05-PLAN.md — IngestionService two-phase orchestrator + schema_index.py + ingest_org MCP tool wired into server.py

### Phase 4: Remaining Parsers
**Goal**: LWC and Vlocity metadata is fully ingested into the graph, making the tool credible for enterprise orgs that depend on OmniStudio and LWC components.
**Depends on**: Phase 3
**Requirements**: LWC-01, LWC-02, LWC-03, LWC-04, LWC-05, LWC-06, VLO-01, VLO-02, VLO-03, VLO-04, VLO-05, VLO-06, VLO-07, SEM-01
**Success Criteria** (what must be TRUE):
  1. An LWC component JS file with a `@salesforce/apex/ClassName.methodName` wire import produces an IMPORTS_APEX edge (callType=wire) in the graph; an imperative call in a function body produces an IMPORTS_APEX edge (callType=imperative).
  2. An LWC HTML template with `<c-child-component>` produces a CONTAINS_CHILD edge; `lightning-record-form` field references produce WIRES_ADAPTER edges.
  3. An IntegrationProcedure DataPack JSON produces an IP node with all step elements; merge field references (`%StepName:FieldName%`) produce REFERENCES_STEP_OUTPUT edges.
  4. A DataRaptor Extract fixture produces DR_READS edges from the DataRaptor node to the correct SFField nodes; a DataRaptor Load produces DR_WRITES edges.
  5. The Vlocity namespace normalizer replaces `%vlocity_namespace%` in all relationship targets with the configured org namespace prefix before any edges are written.
**Plans**: 2 plans

Plans:
- [x] 04-01-SUMMARY.md — LWC parser (JS + HTML) with Apex import, label, adapter, and child-component mapping
- [x] 04-02-SUMMARY.md — Vlocity parser (IntegrationProcedure/DataRaptor/OmniScript) with namespace normalization

### Phase 5: MCP Tools + Query Pipeline
**Goal**: A developer can connect Claude Desktop to the MCP server, ingest an org, and ask "what breaks if I change this field?" and receive a confidence-tiered, source-attributed answer in under 5 seconds.
**Depends on**: Phase 4
**Requirements**: QUERY-01, QUERY-02, QUERY-03, QUERY-04, QUERY-05, QUERY-06, QUERY-07, QUERY-08, QUERY-09, QUERY-10, MCP-02, MCP-03, MCP-04, MCP-05, MCP-06, MCP-07, MCP-08, MCP-09, TRUST-01, TRUST-02, TRACE-01, TRACE-02, MAP-01
**Success Criteria** (what must be TRUE):
  1. `ingest_org(export_dir)` called from Claude Desktop runs the full ingestion pipeline and returns a summary with node count, edge count, warnings, and duration; `get_ingestion_status()` reflects the current state immediately after.
  2. `query("what uses Account.Status__c?")` returns a structured answer with results grouped into Definite (confidence ≥ 0.9), Probable (0.5–0.9), and Review manually (< 0.5) tiers, each with source file and line number citations.
  3. When the query pipeline generates an invalid Cypher query, the CypherCorrector loop retries up to 4 times with error-enriched feedback; zero-result queries receive hint-enriched feedback rather than a bare empty response.
  4. `explain_field(Account.Status__c)` returns a complete field biography — all Apex readers/writers, Flow references, LWC bindings, Vlocity references, formula dependents — tiered by confidence.
  5. `get_node(qualifiedName)` returns node properties, all connected edges, and source code snippet for the named node.
  6. A query whose Variable Origin Tracer hits the depth limit surfaces the exact prescribed language: "exceeded the static analysis depth limit (5 hops)" — not a generic low-confidence message.
  7. Full ingest pipeline on a large-org fixture (2k classes, 800 LWC, 300 Flows) completes in under 3 minutes; NL query pipeline completes in under 5 seconds.
**Plans**: TBD

### Phase 6: Hardening + OSS Readiness
**Goal**: The tool is production-hardened for pathological enterprise orgs and publishable to PyPI with zero-friction installation, complete documentation, and the Dynamic Accessor Registry pre-configured for common Salesforce patterns.
**Depends on**: Phase 5
**Requirements**: DYN-01, DYN-02, DYN-03, REFRESH-01, REFRESH-02, REFRESH-03, REFRESH-04, REFRESH-05, REFRESH-06, OSS-01, OSS-02, OSS-03, OSS-04, IMPACT-01, IMPACT-02, OBS-01, EXT-PLUG-01, TEST-INTEL-01, SNAP-01
**Success Criteria** (what must be TRUE):
  1. The Variable Origin Tracer resolves a dynamic field reference through a 4-hop Apex method chain and produces an edge with resolutionMethod=traced; a 6-hop chain hits MAX_TRACE_DEPTH=5 and produces a TRACE_LIMIT_HIT edge (confidence=0.3).
  2. `sfgraph refresh` on a 3-file change set completes in under 5 seconds: deleted-file nodes are removed from the graph and vector index, changed-file nodes are re-ingested, and affected neighbors are re-discovered.
  3. File watcher triggers incremental refresh automatically within 3 seconds of a file save (2s debounce + sub-1s ingest for a single file).
  4. `pip install sfgraph` on a clean Python 3.12 environment succeeds; `sfgraph serve` starts the MCP server; `sfgraph ingest ./export` runs ingestion — all without additional configuration.
  5. The shipped `config/dynamic_accessors.yaml` correctly maps `fflib_SObjectSelector.selectById` to READS_FIELD edges when a field argument is a string literal, confirmed by a graph query on an fflib fixture.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundations | 5/5 | Complete | 2026-04-04 |
| 2. Node.js Parser Pool + MCP Skeleton | 3/3 | Complete | 2026-04-04 |
| 3. Ingestion Pipeline Core | 5/5 | Complete | 2026-04-06 |
| 4. Remaining Parsers | 2/2 | Complete | 2026-04-06 |
| 5. MCP Tools + Query Pipeline | 4/? | In Progress | 2026-04-06 |
| 6. Hardening + OSS Readiness | 3/? | In Progress | 2026-04-06 |

### Phase 3 Plan Checklist

| Plan | Status | Completed |
|------|--------|-----------|
| 03-01: Schema constants + Pydantic models + fixtures | ✅ DONE | 2026-04-06 |
| 03-02: Object/Field XML parser (OBJ-01–07) | ✅ DONE | 2026-04-06 |
| 03-03: Apex CST full traversal + apex_extractor.py | ✅ DONE | 2026-04-06 |
| 03-04: Flow XML parser (FLOW-01–08) | ✅ DONE | 2026-04-06 |
| 03-05: IngestionService + ingest_org MCP tool | ✅ DONE | 2026-04-06 |

### Phase 4 Plan Checklist

| Plan | Status | Completed |
|------|--------|-----------|
| 04-01: LWC parser (LWC-01–06) | ✅ DONE | 2026-04-06 |
| 04-02: Vlocity parser (VLO-01–07) | ✅ DONE | 2026-04-06 |


### Phase 5 Plan Checklist

| Plan | Status | Completed |
|------|--------|-----------|
| 05-01: Query + lineage + freshness baseline | ✅ DONE | 2026-04-06 |
| 05-02: Cross-layer map + unknown-dynamic visibility + rules hooks | ✅ DONE | 2026-04-06 |
| 05-03: Schema-filtered query pipeline + correction-attempt trace + confidence tiers | ✅ DONE | 2026-04-06 |
| 05-04: Agent trace integration + deeper test-gap intelligence | ✅ DONE | 2026-04-06 |

---
*Roadmap created: 2026-04-04*
*Last updated: 2026-04-06 — Phase 5 baseline started (query/lineage/freshness tools implemented)*
