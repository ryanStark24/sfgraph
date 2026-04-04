# Project Research Summary

**Project:** Salesforce Org Graph Analyzer (MCP Tool)
**Domain:** Local embedded static analysis + property graph store + multi-agent LLM query pipeline
**Researched:** 2026-04-03
**Confidence:** HIGH

## Executive Summary

The Salesforce Org Graph Analyzer is a locally embedded, air-gapped metadata dependency analysis tool that exposes an MCP tool surface for AI clients (Claude Desktop, Cursor, VS Code Copilot). It occupies a category gap that every existing tool misses: fully local operation spanning Apex + LWC + Flows + Vlocity together, with confidence-scored natural language answers and no external service dependency. Every commercial tool (Elements.cloud, Sweep, Gearset) requires cloud connectivity and org credential storage. Every OSS tool (dependencies-cli, HappySoup, DependencyGraphForSF) inherits the Tooling API's 2,000-record hard cap and provides no natural language interface. This tool bypasses both constraints by building a local property graph from a static metadata export.

The recommended architecture is a single Python 3.12 process running a FastMCP server that owns three embedded storage engines: FalkorDBLite (property graph via Cypher), Qdrant local mode (vector index), and SQLite (file manifest). Apex and LWC JS parsing is delegated to a persistent Node.js subprocess pool using tree-sitter-sfapex — the only production-grade Apex parser in any ecosystem — because no Python-compatible compiled grammar exists. All other parsing (Flow XML, Object XML, LWC HTML, Vlocity DataPacks) is handled in-process with lxml and stdlib. A three-agent LLM pipeline (Haiku schema filter → Sonnet query generator → Sonnet result formatter) translates natural language questions into validated Cypher queries with confidence-tiered answers.

The primary risks are: FalkorDBLite's hard Python 3.12 requirement (must be enforced from day one), the MCP stdio transport's extreme sensitivity to stdout pollution (any stray print() corrupts the session), tree-sitter-sfapex's known parse failures on legitimate enterprise Apex patterns (requires ERROR-node guards throughout), and Qdrant local mode's 20,000-vector scale ceiling for large orgs. All four risks are mitigatable with specific design decisions described in PITFALLS.md — none require a technology change, but all require awareness before the first line of code is written.

---

## Key Findings

### Recommended Stack

The stack is fully locked with verified package versions as of April 2026. Python 3.12 is non-negotiable (FalkorDBLite hard requirement). The two-runtime architecture (Python orchestrator + Node.js parser pool) is the correct approach — not a workaround. The Node.js pool is a first-class architectural component with health checks, memory ceilings, and replay-on-crash mode. All dependencies are embedded with no Docker or external server required.

**Core technologies:**
- **Python 3.12 / uv** — orchestration runtime and package management; uv is recommended by official MCP docs and 10-100x faster than pip
- **FalkorDBLite 0.9.0** — embedded property graph with Cypher queries; Kùzu was abandoned Oct 2025, making FalkorDB the clear embedded Cypher choice
- **Qdrant (qdrant-client 1.17.1) + FastEmbed 0.8.0** — local vector index with CPU-only ONNX embeddings; no GPU, no PyTorch
- **aiosqlite 0.22.1** — async SQLite for file manifest (SHA-256 hashes, ingestion state tracking)
- **mcp 1.27.0 (FastMCP)** — official Anthropic MCP SDK; stdio transport for Claude Desktop; Streamable HTTP for programmatic clients
- **anthropic 0.89.0** — Claude API client; Haiku 4.5 for schema filter (20-40x cheaper), Sonnet 4.6 for query generation and result formatting
- **tree-sitter 0.25.0 + tree-sitter-sfapex 2.4.1** — Node.js native Apex/SOQL/SOSL parser; only production-grade option in any ecosystem
- **lxml 5.x** — Flow XML, Object XML, LWC HTML parsing; XPath support required for Salesforce namespaced XML
- **watchdog 6.0.0** — OS-native file watching for real-time incremental refresh
- **pydantic v2** — input validation and structured output contracts (already pulled in by mcp SDK)
- **typer 0.12.x** — CLI entrypoint (`sfgraph ingest`, `sfgraph query`, `sfgraph serve`)

### Expected Features

**Must have (table stakes):**
- Field-level impact query ("what uses Account.Status__c?") spanning Apex, Flows, LWC, Formulas, Validation Rules
- Apex class dependency graph including trigger → handler chains and interface implementations
- Flow dependency tracing across all Flow types (Record-Triggered, Scheduled, Screen, Autolaunched)
- LWC dependency mapping (wire adapters, imperative @AuraEnabled calls, child component composition)
- Reverse traversal — "who calls this Apex method?" — bi-directional lookups
- SObject and Field metadata as first-class graph nodes (dependency anchors for everything else)
- Cross-type dependency query ("show everything that touches Opportunity.StageName")
- Source attribution with file path, line number, and 1-3 line context snippet per edge
- Incremental refresh via SHA-256 file manifest (cold ingest is too slow for developer workflow)
- CLI entrypoint and MCP server (headless-first, no web UI)
- Custom Label, Custom Setting, and Custom Metadata Type usage tracking

**Should have (differentiators):**
- Unified Vlocity/OmniStudio dependency graph (IntegrationProcedure, OmniScript, DataRaptor, FlexCard) — no existing tool does this
- Natural language query via MCP with confidence-tiered answers (Definite / Probable / Review manually)
- Fully local / air-gapped operation with zero org credential exposure
- Variable Origin Tracer with cycle detection (field value flow through method chains)
- Formula field and validation rule dependency parsing
- Platform Event + PlatformEventSubscriberConfig pub/sub topology
- Edge-level context snippets from actual source code
- Dynamic Accessor Registry (YAML-configurable for org-specific utility method patterns like fflib selectors)
- Iterative Cypher self-correction loop (max 4 iterations) with hallucination guard
- Three-tier query pipeline with Schema Filter reducing token cost 20-40x
- File watcher real-time mode (2s debounce, sub-5s graph updates)
- `explain_field` MCP tool (complete field biography in one call)
- PyPI-publishable OSS package

**Defer to v1.5:**
- Graph versioning and org snapshots
- Precomputed traversal cache (prerequisite for risk scoring)

**Defer to v2+:**
- Permission Set / Profile FLS graph layer (10x edge volume)
- Risk scoring layer (needs precomputed cache first)
- Test coverage overlay (needs runtime data or complex control-flow analysis)
- Multi-org federation

**Explicit anti-features (never build):**
- Deployment tooling (Gearset territory, turns this into a DevOps platform)
- Live org runtime analysis (defeats local/embedded value proposition)
- Web UI / dashboard (MCP is the UI; Claude/Cursor/Copilot are the frontend)
- Visualforce and Aura parsing internals (legacy; stub nodes only)
- AppExchange distribution (incompatible with local/embedded architecture)

### Architecture Approach

The system is a single Python process owning three embedded storage engines, with one external concern (Apex/JS parsing) delegated to a persistent Node.js subprocess pool via newline-delimited JSON IPC. The MCP tool layer is stateless and delegates all work through a service layer; nothing in the tool layer touches storage directly. Two critical architectural disciplines must be enforced from day one: the GraphStore abstraction protocol (ABC before any FalkorDB-specific code) and the two-phase ingestion pattern (all nodes before any edges, enforced at the IngestionService level).

**Major components:**
1. **FastMCP Tool Layer** — stateless handlers for 6 tools; validates inputs; dispatches to service layer; never touches storage directly
2. **IngestionService** — orchestrates full and incremental ingest as background asyncio Tasks; returns run_id immediately; enforces two-phase write discipline
3. **QueryService** — three-agent LLM pipeline (SchemaFilter → QueryGenerator + CypherCorrector → ResultFormatter); owns all Cypher execution
4. **GraphStore Protocol (ABC) + FalkorDBStore** — abstraction isolating all Cypher operations; enables FalkorDB → DuckPGQ swap without touching ingestion or query logic
5. **Node.js Parser Pool** — persistent subprocess pool loading tree-sitter grammars once; health checks every 10s; 200-file memory ceiling per worker; JSON-L IPC
6. **ParseDispatcher** — routes files to Node.js pool (.cls, .trigger, .js) or Python parsers (XML, HTML, JSON) by file extension/type
7. **ManifestStore (SQLite)** — tracks per-file SHA-256, ingestion phase (PENDING / NODES_WRITTEN / EDGES_WRITTEN / FAILED), run status; enables both incremental refresh and crash recovery
8. **VectorStore (Qdrant local)** — source code chunk embeddings via FastEmbed ONNX; semantic search supplement to Cypher traversal
9. **SchemaIndex** — post-ingest materialization of node/relationship catalogue for Schema Filter Agent context injection

### Critical Pitfalls

1. **FalkorDBLite requires Python 3.12 (hard)** — set `requires-python = ">=3.12"` in pyproject.toml before any other work; FalkorDBLite will not install on 3.11
2. **Stdout pollution corrupts MCP stdio transport** — enforce `logging.basicConfig(stream=sys.stderr)` at the top of the entry point before any imports; add a CI check asserting stdout is empty after every tool call; the FalkorDB Redis subprocess may itself emit to stdout on first launch
3. **FalkorDBLite spawns a Redis child process (not truly embedded)** — requires `brew install libomp` on macOS; serialize all writes through a single asyncio queue (concurrent writes corrupt the graph); register atexit handler to kill the Redis subprocess on interpreter exit
4. **tree-sitter-sfapex has documented parse failures on enterprise Apex patterns** — inherited constructors (fflib pattern), for-loops, SOSL, standalone semicolons all have open issues; wrap all CST traversal with `has_error` guard; build a parse-failure corpus; expect 5-20% error rate on enterprise codebases
5. **Qdrant local mode caps at ~20,000 vectors with brute-force search** — large orgs (2k+ classes) easily produce 150k-300k vectors; design VectorStore abstraction to support both local mode (testing) and Qdrant subprocess mode (production) from the start
6. **LLM Cypher hallucination is silent** — FalkorDB returns empty results (not errors) for non-existent node labels; validate generated Cypher against `CALL db.labels()` before execution; include FalkorDB dialect warnings ("no `=~` regex, no OR-label expressions") in agent system prompts
7. **Two-phase ingestion atomicity** — track `phase_1_complete / phase_2_complete` in SQLite manifest; use `MERGE` (not `CREATE`) for idempotency; detect crashed ingestion state on startup and offer `--reset`

---

## Implications for Roadmap

Based on the combined research, the architecture's build-order constraints (storage → IPC → ingestion → parsers → MCP → query pipeline → hardening) map directly to phases. The Node.js IPC boundary is the highest integration risk and must be proven early. The query pipeline cannot be tested without a populated graph.

### Phase 1: Foundations and Environment
**Rationale:** Every subsequent component reads from or writes to the three storage engines. Python 3.12 constraint must be enforced before any code is written. GraphStore abstraction must exist before FalkorDB-specific code. This phase unblocks everything else.
**Delivers:** Working ManifestStore (SQLite CRUD), GraphStore Protocol (ABC), FalkorDBStore (concrete), VectorStore (Qdrant local init); environment lock with Python 3.12, libomp documented, CI setup steps defined.
**Addresses:** Table-stakes foundation — without these, no other feature is buildable.
**Avoids:** Pitfall 1 (Python 3.12), Pitfall 3 (FalkorDB Redis model + write serialization), Pitfall 10 (two-phase atomicity boundary in manifest schema).

### Phase 2: Node.js Parser Pool and MCP Server Skeleton
**Rationale:** The Python↔Node.js IPC boundary is the highest integration risk in the system. Prove it works with Apex files before building any Python parsers. Establish MCP stdio stdout discipline before writing any tool handlers — a stdout leak discovered later requires auditing every file written since.
**Delivers:** Functional Node.js worker script (tree-sitter-sfapex grammar + JSON-L IPC), NodeParserPool (asyncio subprocess management, health checks, 200-file ceiling), ParseDispatcher routing, FastMCP server skeleton with lifespan context and stderr-only logging enforced.
**Uses:** tree-sitter 0.25.0 + tree-sitter-sfapex 2.4.1, mcp 1.27.0 (FastMCP), Python asyncio subprocess.
**Avoids:** Pitfall 2 (stdout pollution), Pitfall 4 (tree-sitter ERROR-node guards built from day one), Pitfall 9 (200-file memory ceiling implemented before first use, not retrofitted).

### Phase 3: Ingestion Pipeline Core (Apex + Objects + Flows)
**Rationale:** Apex is the highest-value single parser — it unlocks cross-class dependency analysis, the #1 use case. Objects and Fields are the dependency anchors for everything else. Flow XML is the second-most-referenced automation type. Together these three parsers deliver a functional graph for MVP testing.
**Delivers:** NodeWriter (MERGE nodes into FalkorDB with source attribution), EdgeWriter (relationship matchers, confidence scoring, context snippets), IngestionService (two-phase orchestration as asyncio Task), FileScanner (SHA-256 delta detection), incremental refresh. Working graph queryable via Cypher.
**Addresses:** Field-level impact query, Apex class dependency graph, Flow dependency tracing, SObject/Field node representation, incremental refresh (all table stakes).
**Avoids:** Pitfall 10 (two-phase atomicity enforced in IngestionService), Pitfall 16 (picklist false-positive guard in GraphStore abstraction, not per-parser).

### Phase 4: Remaining Parsers (LWC, Vlocity, Labels, Platform Events)
**Rationale:** All parsers are independent once ParseDispatcher exists. They can be built in parallel. LWC enables UI-layer dependencies. Vlocity is the primary differentiator against all competitors. Labels/CMT/Platform Events complete the enterprise metadata coverage needed for a credible v1.
**Delivers:** LWC JS parser (tree-sitter-javascript via Node.js pool), LWC HTML parser (lxml), Vlocity DataPack parsers (IP, OmniScript, DataRaptor JSON), Custom Label/Custom Setting/CMT parsers, Platform Event parser.
**Uses:** tree-sitter-javascript 0.25.0, lxml 5.x, stdlib json.
**Avoids:** Pitfall 8 (Vlocity namespace normalizer built before relationship extraction), Pitfall 12 (Flow type-specific XML structure handled via processType inspection and XPath // queries).

### Phase 5: MCP Tools and Query Pipeline
**Rationale:** MCP transport should be wired as soon as the ingest pipeline works end-to-end for Apex files — this gives a testable tool surface. Query pipeline requires a populated graph. Build SchemaIndex first (Agent 1's context source), then the three-agent chain.
**Delivers:** All 6 MCP tools (ingest_org, refresh, query, get_node, explain_field, get_ingestion_status), SchemaIndex post-ingest materialization, three-agent query pipeline (SchemaFilter Haiku → QueryGenerator Sonnet + CypherCorrector → ResultFormatter Sonnet with structured output contract), confidence-tiered results.
**Addresses:** Natural language query, confidence tiers, explain_field, get_ingestion_status (differentiators); MCP server tool surface (table stakes).
**Avoids:** Pitfall 6 (Cypher label hallucination guard via db.labels() validation before execution), Pitfall 7 (FalkorDB dialect filter — no =~ regex, no OR-label expressions), Pitfall 11 (hard result limits: 50 nodes / 100 edges max per tool response).

### Phase 6: Hardening, OSS Readiness, and Real-Time Mode
**Rationale:** Features that make the tool production-ready and community-adoptable. Variable Origin Tracer, formula field parser, and Dynamic Accessor Registry complete the static analysis depth. File watcher enables real-time developer workflow. PyPI packaging enables zero-friction adoption.
**Delivers:** Variable Origin Tracer (depth=5, cost=50, cycle detection), Dynamic Accessor Registry (YAML-configurable, fflib selector support), formula field and validation rule parser, file watcher (watchdog, 2s debounce, incremental refresh trigger), Node.js pool hardening (replay mode, production health metrics), PyPI packaging (pyproject.toml, uv build, CLI entrypoint), OSS documentation (README, contributor guide, schema reference).
**Avoids:** Pitfall 13 (accessor registry validated against graph via validate-registry CLI), Pitfall 14 (debounce handler checks file existence before ingestion, handles net-delete), Pitfall 15 (README documents chunked export for large orgs, ingestion warns on low file counts).

### Phase Ordering Rationale

- Storage foundations must precede all other work — ManifestStore schema drives two-phase atomicity; GraphStore abstraction prevents FalkorDB lock-in.
- Node.js IPC is the highest integration risk — prove it works in isolation before building parsers that depend on it.
- The two-phase ingestion pattern (nodes before edges) is an IngestionService-level discipline, not an optimization. It must be in place before any parser output flows into the graph.
- MCP tools can be wired as soon as one end-to-end ingest works (Phase 3). This gives early manual testability without waiting for all parsers.
- Query pipeline (Phase 5) is blocked on a populated graph. Building it before Phase 3 is complete wastes effort.
- Hardening (Phase 6) features are independent of each other and can be parallelized within the phase.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 5 (Query Pipeline):** The CypherCorrector loop, label validation strategy, and FalkorDB dialect filter are well-architected but implementation details (correction prompt engineering, iteration budget tuning) will need experimentation. Plan for iteration.
- **Phase 4 (Vlocity Parsers):** DataPack JSON schema varies significantly between orgs and OmniStudio versions. Build against multiple sample fixtures from the vlocity_build GitHub test suite before writing production extraction logic.
- **Phase 6 (Variable Origin Tracer):** Tracking field value flow through Apex method chains at depth=5 with cycle detection is the most complex analysis in the system. No established open-source reference implementation exists for Salesforce-specific patterns.

Phases with standard patterns (no research-phase needed):
- **Phase 1 (Foundations):** SQLite, Qdrant local init, and GraphStore ABC are well-documented. Standard Python patterns apply.
- **Phase 2 (Node.js Pool):** Python asyncio subprocess + JSON-L IPC is a battle-tested pattern. Official Python and Node.js docs cover it fully.
- **Phase 3 (Apex/Flow/Object Parsers):** tree-sitter traversal patterns and ElementTree XPath are well-documented. The main risk (ERROR nodes) is known and the guard pattern is simple.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All package versions verified against PyPI/npm as of April 2026. FalkorDBLite 0.9.0, qdrant-client 1.17.1, mcp 1.27.0, anthropic 0.89.0 all confirmed. One MEDIUM: tree-sitter npm stuck at 0.25.0 while upstream is 0.26.5 (known issue #5334 — use 0.25.0). |
| Features | HIGH | Competitive landscape verified against official docs, vendor docs, and OSS repos. Feature categorization reflects verified tool capabilities, not marketing claims. |
| Architecture | HIGH | Design patterns are validated against MCP SDK docs, FalkorDB docs, asyncio documentation, and a peer-reviewed GraphRAG paper (arxiv 2511.08274). No speculative components. |
| Pitfalls | HIGH | All critical pitfalls verified against primary sources: FalkorDB official docs (Python 3.12 requirement, Redis subprocess model), MCP SDK GitHub issues, tree-sitter-sfapex GitHub issues (specific issue numbers confirmed), Qdrant local mode documentation, Node.js worker memory issues (nodejs/node #40878). |

**Overall confidence:** HIGH

### Gaps to Address

- **Qdrant scale boundary for production**: Local mode is confirmed limited to ~20k vectors with brute-force search. The mitigation (Qdrant as subprocess for HNSW) is architecturally sound but not yet prototyped. Validate the subprocess mode API compatibility in Phase 3 before committing to it as the production path.
- **tree-sitter-sfapex parse failure rate**: Research documents specific known failures (Issues #60, #44, #45, #55, #66) but exact failure rate on enterprise Apex corpora is not available. Plan to measure error rate during Phase 3 against a representative fixture set and document findings.
- **FalkorDB write concurrency**: The docs describe FalkorDBLite as single-writer. The exact thread-safety semantics of the Python API under asyncio are undocumented. The asyncio write-serialization queue (recommended in PITFALLS.md) is the correct mitigation but should be validated under concurrent load in Phase 1 integration tests.
- **Vlocity DataPack schema variance**: The exact set of structural variants across OmniStudio versions is not fully enumerated. Phase 4 should begin with a survey of available fixture formats in the vlocity_build GitHub test suite before writing extraction logic.

---

## Sources

### Primary (HIGH confidence)
- [FalkorDBLite Python docs](https://docs.falkordb.com/operations/falkordblite/falkordblite-py.html) — Python 3.12 requirement, embedded Redis model, API reference
- [FalkorDB Cypher support](https://docs.falkordb.com/cypher/cypher-support.html) — Unsupported features: regex operator, label expressions, user-defined functions, temporal arithmetic
- [qdrant-client PyPI 1.17.1](https://pypi.org/project/qdrant-client/) — local mode capabilities and 20k vector limit
- [mcp PyPI 1.27.0](https://pypi.org/project/mcp/) — official Anthropic SDK, MCP spec 2025-11-25
- [anthropic PyPI 0.89.0](https://pypi.org/project/anthropic/) — Claude Haiku 4.5 and Sonnet 4.6 model names confirmed
- [tree-sitter-sfapex GitHub](https://github.com/aheber/tree-sitter-sfapex) — version 2.4.1, known parse failure issues
- [Salesforce Tooling API: MetadataComponentDependency](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_metadatacomponentdependency.htm) — 2,000-record cap confirmed
- [Multi-Agent GraphRAG Text-to-Cypher](https://arxiv.org/pdf/2511.08274) — three-agent pipeline validation
- [MCP Python SDK Lifespan Management](https://deepwiki.com/modelcontextprotocol/python-sdk/2.5-context-injection-and-lifespan) — FastMCP lifespan pattern
- [Python asyncio subprocess docs](https://docs.python.org/3/library/asyncio-subprocess.html) — IPC patterns, PIPE, deadlock avoidance
- [vlocity_build README](https://github.com/vlocityinc/vlocity_build/blob/master/README.md) — DataPack structure, namespace placeholders
- [Salesforce Code Analyzer Overview](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/overview) — official tool capabilities
- [Qdrant local mode docs](https://deepwiki.com/qdrant/qdrant-client/2.2-local-mode) — 20k vector limit, brute-force search, portalocker single-process enforcement

### Secondary (MEDIUM confidence)
- [Salesforce Ben: 4 Free Impact Analysis Tools](https://www.salesforceben.com/salesforce-impact-analysis-tools/) — competitive landscape overview
- [Elements.cloud: Mastering Org Dependencies](https://elements.cloud/blog/how-to-master-org-dependencies-in-salesforce/) — competitor capability verification
- [Sweep: Downstream Impact Analysis](https://www.sweep.io/blog/understanding-downstream-impact-before-you-ship-in-salesforce/) — competitor capability verification
- [NearForm MCP pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/) — stdout pollution, async patterns
- [Text2Cypher Guide — Neo4j/Medium](https://medium.com/neo4j/text2cypher-guide-cc161518a509) — hallucination patterns, correction loop limitations
- [KuzuDB abandoned — The Register](https://www.theregister.com/2025/10/14/kuzudb_abandoned/) — October 2025 abandonment confirmation
- [Node.js worker memory leak issues #40878](https://github.com/nodejs/node/issues/40878) — compiled code GC behavior

### Tertiary (LOW confidence)
- [Graph-Based Code Analysis Engine Architecture](https://rustic-ai.github.io/codeprism/blog/graph-based-code-analysis-engine/) — layered parser→AST→graph→index→query pattern (MEDIUM — referenced for architectural validation, not primary design source)

---

*Research completed: 2026-04-03*
*Ready for roadmap: yes*
