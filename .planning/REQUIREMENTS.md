# Requirements: Salesforce Org Graph Analyzer

**Defined:** 2026-04-04
**Core Value:** A developer can ask "what breaks if I change this field?" and get a confident, sourced answer in under 5 seconds — across Apex, Flows, LWC, and Vlocity simultaneously.

## v1 Requirements

### Foundations

- [x] **FOUND-01**: Project runs on Python 3.12+ with `requires-python = ">=3.12"` enforced in pyproject.toml (FalkorDBLite hard requirement)
- [ ] **FOUND-02**: FalkorDBLite 0.9.0 initializes and accepts Cypher read/write via GraphStore abstraction layer
- [ ] **FOUND-03**: GraphStore Protocol (ABC) decouples all ingestion and query logic from FalkorDB-specific API
- [ ] **FOUND-04**: FalkorDB writes are serialized through a single asyncio queue (prevents graph corruption on concurrent writes)
- [ ] **FOUND-05**: Qdrant local vector index initializes and supports upsert + query operations via VectorStore abstraction
- [ ] **FOUND-06**: SQLite manifest store tracks per-file SHA-256, ingestion phase (PENDING/NODES_WRITTEN/EDGES_WRITTEN/FAILED), and run status
- [ ] **FOUND-07**: All logging routes to stderr only — stdout is reserved exclusively for MCP transport (CI-enforced)
- [x] **FOUND-08**: `uv` is the package manager; `pyproject.toml` defines all dependencies with pinned versions

### Node.js Parser Pool

- [ ] **POOL-01**: Persistent Node.js subprocess pool loads tree-sitter-sfapex and tree-sitter-javascript grammars once at startup
- [ ] **POOL-02**: Python↔Node.js IPC uses newline-delimited JSON over stdin/stdout (request: `{requestId, grammar, filePath, fileContent}`, response: `{requestId, ok, payload, error}`)
- [ ] **POOL-03**: Pool scales to min(cpu_count, 8) workers; each worker stays alive across files (no per-file spawn)
- [ ] **POOL-04**: Worker health check: Python sends `{type:"ping"}` every 30s; no `{type:"pong"}` within 5s → replace worker
- [ ] **POOL-05**: Workers restart after processing 200 files (prevents Node.js heap accumulation on large orgs)
- [ ] **POOL-06**: Per-file timeout of 10s; timeout returns `{ok:false, error:"timeout"}` without killing the worker
- [ ] **POOL-07**: ParseDispatcher routes `.cls`/`.trigger`/`.js` files to Node.js pool; all other file types to Python parsers

### Ingestion Pipeline

- [ ] **INGEST-01**: IngestionService orchestrates two-phase ingestion: Phase 1 (all nodes) completes fully before Phase 2 (all edges) begins
- [ ] **INGEST-02**: Phase 1 node write order: SFObject/SFField → CustomLabel → CustomSetting → CustomMetadata → ApexClass/Method → LWCComponent → Flow/FlowElement → Vlocity nodes → ValidationRule/Workflow → SFPicklistValue/GlobalValueSet → PlatformEvent → PlatformEventSubscriberConfig
- [ ] **INGEST-03**: All nodes written via `MERGE` (idempotent) — not `CREATE` — so crashed ingestion can resume safely
- [ ] **INGEST-04**: Every node carries source attribution: `sourceFile`, `lineNumber`, `parserType`, `lastIngestedAt` (ISO 8601 UTC)
- [ ] **INGEST-05**: Relationship Discovery pass runs all matcher rules across all node pairs after Phase 1 completes
- [ ] **INGEST-06**: All edges carry: `confidence FLOAT`, `resolutionMethod STRING`, `edgeCategory STRING`, `contextSnippet STRING`
- [ ] **INGEST-07**: Post-ingestion: orphaned edges logged as warnings; unresolvable dynamic refs create stub nodes with `unresolvable=true`
- [ ] **INGEST-08**: Ingestion summary emitted on completion: total nodes, total edges, warnings, parse failures, duration
- [ ] **INGEST-09**: Schema index JSON materialized after each full ingest (node type names + property names + connected edge types)

### Parsers — Apex & Triggers

- [ ] **APEX-01**: Apex parser extracts class name, superclass, interfaces, annotations, isTest flag
- [ ] **APEX-02**: Apex parser extracts all method signatures: name, visibility, isStatic, returnType, parameters, annotations
- [ ] **APEX-03**: Apex parser extracts SOQL: target SObject, SELECT fields, WHERE fields, subquery SObjects
- [ ] **APEX-04**: Apex parser extracts DML operations: type (insert/update/delete/upsert/merge/undelete) and target SObject
- [ ] **APEX-05**: Apex parser extracts cross-class method calls (`ClassName.method()`) and same-class calls (`this.method()`)
- [ ] **APEX-06**: Apex parser extracts Custom Label refs (`System.Label.XXX`), Custom Setting refs (`Setting__c.getInstance()`), and Custom Metadata refs
- [ ] **APEX-07**: Apex parser detects `EventBus.publish(new EventName__e(...))` → PUBLISHES_EVENT edge
- [ ] **APEX-08**: Apex parser detects external namespace calls (class name contains `__` or known namespace prefix) → CALLS_EXTERNAL edge to ExternalNamespace stub node
- [ ] **APEX-09**: Apex parser detects picklist value comparisons (`acc.Status == 'Active'`) with field-context guard (left-hand side must resolve to known Picklist-type SFField before READS_VALUE edge is issued)
- [ ] **APEX-10**: Parser wraps all CST traversal with `has_error` guard; files with parse errors are logged and skipped rather than silently producing incomplete edges
- [ ] **APEX-11**: Dynamic Accessor Registry (YAML config) maps org-specific utility methods (e.g. `SObjectUtils.getFieldValue`) to READS_FIELD/WRITES_FIELD edges when field argument is a string literal or traceable variable

### Parsers — LWC

- [ ] **LWC-01**: LWC JS parser extracts `@salesforce/apex/ClassName.methodName` wire imports → IMPORTS_APEX edge (callType=wire)
- [ ] **LWC-02**: LWC JS parser detects imperative calls to imported Apex methods inside function bodies → IMPORTS_APEX edge (callType=imperative)
- [ ] **LWC-03**: LWC JS parser extracts `@salesforce/label/c.LabelName` imports → LWC_RESOLVES_LABEL edge
- [ ] **LWC-04**: LWC JS parser extracts `@wire(getRecord)` adapters: target SObject and fields array → WIRES_ADAPTER edges
- [ ] **LWC-05**: LWC HTML parser extracts `<c-child-component>` tag usage → CONTAINS_CHILD edge
- [ ] **LWC-06**: LWC HTML parser extracts `lightning-record-form` field references → WIRES_ADAPTER edges

### Parsers — Flow

- [ ] **FLOW-01**: Flow parser extracts API name, label, type, triggerType, triggerObject, and isActive status
- [ ] **FLOW-02**: Flow parser extracts all record operations (recordCreate/Update/Delete/Lookup): SObject type, field assignments
- [ ] **FLOW-03**: Flow parser extracts Decision element conditions: field references and hardcoded picklist value comparisons → FLOW_READS_VALUE edges
- [ ] **FLOW-04**: Flow parser extracts Apex action elements → FLOW_CALLS_APEX edge
- [ ] **FLOW-05**: Flow parser extracts subflow references → FLOW_CALLS_SUBFLOW edge
- [ ] **FLOW-06**: Flow parser extracts `$Label.XXX` references → FLOW_RESOLVES_LABEL edge
- [ ] **FLOW-07**: Flow parser detects `triggerType = "PlatformEvent"` → SUBSCRIBES_TO_EVENT edge (annotated with isActive/batchSize from PlatformEventSubscriberConfig if present)
- [ ] **FLOW-08**: Flow parser detects Publish Message elements → PUBLISHES_EVENT edge

### Parsers — Vlocity

- [ ] **VLO-01**: IntegrationProcedure parser extracts name, version, isActive, all step elements (name, type, connector graph)
- [ ] **VLO-02**: IntegrationProcedure parser extracts merge field references (`%StepName:FieldName%`) → REFERENCES_STEP_OUTPUT edges
- [ ] **VLO-03**: DataRaptor Extract parser extracts SourceObject and all SourceFields → DR_READS edges (DataRaptor → SFField)
- [ ] **VLO-04**: DataRaptor Load parser extracts DestinationObject and all DestinationFields → DR_WRITES edges (DataRaptor → SFField)
- [ ] **VLO-05**: DataRaptor Transform parser extracts input DataRaptor reference → DR_TRANSFORMS edge, plus field mappings for DR_READS and DR_WRITES
- [ ] **VLO-06**: Vlocity namespace normalizer resolves `%vlocity_namespace%` placeholder to the org's actual namespace prefix before relationship extraction
- [ ] **VLO-07**: OmniScript parser extracts name, type, subType, isActive, and Apex/IP action references

### Parsers — Object Model & Configuration

- [ ] **OBJ-01**: Object/Field XML parser creates SFObject nodes (name, label, isCustom, isManaged, namespace)
- [ ] **OBJ-02**: Object/Field XML parser creates SFField nodes (qualifiedName, dataType, isFormula, formulaText, isRequired)
- [ ] **OBJ-03**: SFPicklistValue nodes created from field XML picklist valueSet elements; GlobalValueSet nodes from globalValueSet metadata
- [ ] **OBJ-04**: FIELD_HAS_VALUE, GLOBAL_VALUE_SET_HAS_VALUE, and FIELD_USES_GLOBAL_SET edges created during object parsing
- [ ] **OBJ-05**: PlatformEvent nodes created from `objects/**/__e/*.object-meta.xml` files
- [ ] **OBJ-06**: Formula field parser creates FORMULA_DEPENDS_ON edges (SFField → SFField) for formula fields, validation rules, workflow field updates, and approval criteria
- [ ] **OBJ-07**: Custom Label, Custom Setting, and Custom Metadata Type/Record/Field nodes created from their respective XML sources

### Graph Schema

- [ ] **GRAPH-01**: All node tables from design doc §7.1 exist in FalkorDB: SFObject, SFField, ApexClass, ApexMethod, ApexTrigger, LWCComponent, LWCProperty, Flow, FlowElement, IntegrationProcedure, IPElement, IPVariable, OmniScript, DataRaptor, CustomLabel, CustomSetting, CustomMetadataType, CustomMetadataRecord, CustomMetadataField, SFPicklistValue, GlobalValueSet, PlatformEvent, ExternalNamespace
- [ ] **GRAPH-02**: All relationship tables from design doc §7.2 exist with correct FROM/TO node types
- [ ] **GRAPH-03**: Edge category taxonomy enforced: DATA_FLOW / CONTROL_FLOW / CONFIG / STRUCTURAL on every edge
- [ ] **GRAPH-04**: GraphStore abstraction has a working DuckPGQStore stub (even if unimplemented) to validate the Protocol boundary

### Dynamic Reference Resolution

- [ ] **DYN-01**: Variable Origin Tracer resolves dynamic field references: string literal, Custom Label, Custom Setting, Custom Metadata, static constant — each producing an edge with the appropriate resolutionMethod
- [ ] **DYN-02**: Variable Origin Tracer enforces safety bounds: MAX_TRACE_DEPTH=5, visited set for cycle detection, cost_budget=50 AST nodes per trace
- [ ] **DYN-03**: TRACE_LIMIT_HIT edges (confidence=0.3) are recorded and surfaced in query output with explicit "code complexity, not tool weakness" UX language

### Incremental Refresh

- [ ] **REFRESH-01**: File manifest diff (SHA-256) identifies added, changed, and deleted files since last ingest
- [ ] **REFRESH-02**: Deleted files: nodes and edges from that file removed from graph and vector index; manifest entry deleted
- [ ] **REFRESH-03**: Changed files: old nodes/edges deleted, re-parsed, new nodes/edges written
- [ ] **REFRESH-04**: Affected-node re-discovery: matchers re-run for nodes sourced from dirty files AND nodes that had edges pointing to dirty nodes
- [ ] **REFRESH-05**: Incremental refresh completes in < 5 seconds for 1-5 changed files
- [ ] **REFRESH-06**: File watcher (watchdog) triggers incremental refresh with 2-second debounce in real-time mode

### Query Pipeline

- [ ] **QUERY-01**: Schema Filter Agent (Claude Haiku 4.5) receives question + schema_index.json and returns 5-10 relevant node/edge type names
- [ ] **QUERY-02**: Query Generator Agent (Claude Sonnet 4.6) receives question + FalkorDB introspection of filtered types and generates a Cypher query
- [ ] **QUERY-03**: Cypher label validation pre-filters generated queries against `CALL db.labels()` before execution; FalkorDB dialect warnings (no `=~`, no label expressions) injected into agent system prompt
- [ ] **QUERY-04**: Iterative Cypher correction loop: max 4 attempts; zero-result queries generate hint-enriched error feedback (not just "no results")
- [ ] **QUERY-05**: Result Formatter Agent (Claude Sonnet 4.6) uses structured output contract (`{action: ANSWER|TRAVERSE, cypher?, answer?, findings}`) to separate hop decisions from prose formatting
- [ ] **QUERY-06**: Multi-hop traversal: hop budget starts at 3, decrements per TRAVERSE decision; at 0 the agent is forced to ANSWER
- [ ] **QUERY-07**: Query results structured into three confidence tiers: Definite (≥0.9), Probable (0.5–0.9), Review manually (<0.5)
- [ ] **QUERY-08**: TRACE_LIMIT_HIT results use exact prescribed UX language: "exceeded the static analysis depth limit (5 hops)" — not "low confidence"
- [ ] **QUERY-09**: Qdrant retrieves source code chunks for result node IDs and passes them to Result Formatter for contextual answers
- [ ] **QUERY-10**: Hard result size limits enforced: max 50 nodes / 100 edges per tool response (prevents context overflow)

### MCP Server & Tools

- [ ] **MCP-01**: FastMCP server initializes with lifespan context manager owning all storage engines (FalkorDB, Qdrant, SQLite, Node.js pool)
- [ ] **MCP-02**: `ingest_org(export_dir)` tool: runs full ingestion pipeline, returns summary (node count, edge count, warnings, duration)
- [ ] **MCP-03**: `refresh(export_dir?)` tool: runs incremental refresh, returns changed files count, affected nodes, duration
- [ ] **MCP-04**: `query(question)` tool: runs three-agent NL→Cypher pipeline, returns confidence-tiered structured answer with source snippets
- [ ] **MCP-05**: `get_node(node_id)` tool: returns node properties + all connected edges + source code for a specific qualified name
- [ ] **MCP-06**: `explain_field(field_qualified_name)` tool: returns complete field biography — all readers, writers, formula dependents, flow references, Vlocity references, LWC bindings — tiered by confidence
- [ ] **MCP-07**: `get_ingestion_status()` tool: returns node counts by type, edge counts by type, last ingestion timestamp, pending warnings
- [ ] **MCP-08**: Full ingestion pipeline completes in < 3 minutes for a large org (2k classes, 800 LWC, 300 Flows, 200 Vlocity IPs)
- [ ] **MCP-09**: Complete NL query pipeline (question → answer) completes in < 5 seconds

### OSS Readiness

- [ ] **OSS-01**: PyPI-publishable package via `pyproject.toml` with `uv build`; CLI entrypoint `sfgraph` (with subcommands: `serve`, `ingest`, `query`, `refresh`)
- [ ] **OSS-02**: README covers: what it is, installation (including `brew install libomp` for macOS), quickstart, all 6 MCP tools with examples
- [ ] **OSS-03**: `config/dynamic_accessors.yaml` ships with common Salesforce utility patterns (fflib selector pattern, generic DML helpers) pre-configured
- [ ] **OSS-04**: Schema reference document covers all node types, edge types, confidence scoring taxonomy, and resolutionMethod values

## v2 Requirements

### Graph Versioning

- **VER-01**: Timestamped ingestion snapshots enable diff between two graph states
- **VER-02**: Precomputed traversal cache materialises field → writers and field → readers for instant results

### Risk Scoring

- **RISK-01**: Risk scoring layer combines edge confidence + edge category + fan-out + critical object detection to prioritize dependencies by impact risk
- **RISK-02**: Answers surface "3 things that will break in production" vs "37 that probably won't"

### Permission Graph

- **PERM-01**: Permission Set / Profile CRUD/FLS layer adds which profiles can write which fields
- **PERM-02**: Field impact answers include permission-aware "who can trigger this write" analysis

### Extended Parsers

- **EXT-01**: Visualforce page parser (legacy orgs)
- **EXT-02**: Aura Component parser (legacy orgs)
- **EXT-03**: Test coverage overlay — ingest Apex test classes, map assertion coverage onto graph nodes

## Out of Scope

| Feature | Reason |
|---------|--------|
| Live org connectivity / runtime analysis | Defeats the local/air-gapped value proposition; requires credential storage |
| Deployment tooling (push changes to org) | Separate product category (Gearset territory); turns this into a DevOps platform |
| Web UI / dashboard | MCP is the UI; Claude/Cursor/Copilot are the frontend — a web UI duplicates the interface layer |
| AppExchange distribution | Incompatible with local/embedded architecture; requires Salesforce ISV certification |
| Multi-org federation | v2+ complexity; single-org analysis is the core use case |
| Managed package internals | Source not in org export; stub ExternalNamespace nodes only |
| Graph versioning / snapshots | v1.5; requires precomputed traversal cache as prerequisite |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01 – FOUND-08 | Phase 1 | Pending |
| POOL-01 – POOL-07 | Phase 2 | Pending |
| MCP-01 (skeleton) | Phase 2 | Pending |
| INGEST-01 – INGEST-09 | Phase 3 | Pending |
| APEX-01 – APEX-11 | Phase 3 | Pending |
| OBJ-01 – OBJ-07 | Phase 3 | Pending |
| FLOW-01 – FLOW-08 | Phase 3 | Pending |
| GRAPH-01 – GRAPH-04 | Phase 3 | Pending |
| LWC-01 – LWC-06 | Phase 4 | Pending |
| VLO-01 – VLO-07 | Phase 4 | Pending |
| QUERY-01 – QUERY-10 | Phase 5 | Pending |
| MCP-02 – MCP-09 | Phase 5 | Pending |
| DYN-01 – DYN-03 | Phase 6 | Pending |
| REFRESH-01 – REFRESH-06 | Phase 6 | Pending |
| OSS-01 – OSS-04 | Phase 6 | Pending |

**Coverage:**
- v1 requirements: 99 total
- Mapped to phases: 99
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-04*
*Last updated: 2026-04-04 after roadmap creation (coverage count corrected to 99)*
