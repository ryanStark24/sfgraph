---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 3 — Ingestion Pipeline Core (IN PROGRESS)
current_plan: 01 (completed) — Schema constants, Pydantic models, fixture files
status: executing
last_updated: "2026-04-06T04:49:53.655Z"
progress:
  total_phases: 3
  completed_phases: 2
  total_plans: 13
  completed_plans: 10
  percent: 100
---

# Project State: Salesforce Org Graph Analyzer

**Last updated:** 2026-04-06
**Session:** Plan 03-01 execution (Schema constants, Pydantic models, fixture files)

---

## Project Reference

**Core value:** A developer can ask "what breaks if I change this field?" and get a confident, sourced answer in under 5 seconds — across Apex, Flows, LWC, and Vlocity simultaneously.

**Current focus:** Phase 1 — Foundations

**Milestone:** v1 (all phases)

---

## Current Position

**Current phase:** 3 — Ingestion Pipeline Core (IN PROGRESS)
**Current plan:** 01 (completed) — Schema constants, Pydantic models, fixture files
**Status:** In progress

**Progress:**
Phase 1 [██████████] 100% (5/5 plans — COMPLETE)
Phase 2 [██████████] 100% (3/3 plans — COMPLETE)
Phase 3 [██        ] 20% (1/5 plans)
Phase 4 [          ] 0%
Phase 5 [          ] 0%
Phase 6 [          ] 0%

Overall [████░░░░░░] ~35%

---

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases defined | 6 |
| Requirements mapped | 99/99 |
| Plans created | 5 |
| Plans completed | 5 |
| Phases completed | 0 |

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01-foundations | P01 | 4 min | 2 | 8 |
| 01-foundations | P02 | 2 min | 2 | 5 |
| 01-foundations | P03 | 2 min | 1 | 4 |
| 01-foundations | P04 | 18 min | 2 | 5 |
| 01-foundations | P05 | 8 min | 3 | 4 |
| 02-nodejs-parser-pool | P01 | 12 min | 2 | 9 |
| 02-nodejs-parser-pool | P02 | 15 min | 2 | 2 |
| Phase 02-nodejs-parser-pool-mcp-skeleton P02 | 15 | 2 tasks | 2 files |
| Phase 02-nodejs-parser-pool-mcp-skeleton PP03 | 2 | 2 tasks | 3 files |
| 03-ingestion-pipeline-core | P01 | 2 min | 2 | 11 |
| Phase 03-ingestion-pipeline-core P02 | 112 | 1 tasks | 2 files |

## Accumulated Context

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| DuckPGQ (duckdb>=1.0.0) replaces falkordb as graph store | falkordb required a running Redis server + Docker; DuckPGQ is fully embedded in-process — no server, no Docker, works on restricted company machines |
| DuckPGQStore stores nodes in per-label tables, edges in per-rel-type tables | Each label/rel_type gets its own DuckDB table; schema tracked in _sfgraph_schema metadata table; props stored as JSON column |
| query() method accepts DuckDB SQL / PGQ SQL, not Cypher | GraphStore ABC still names param 'cypher' but DuckPGQStore documents it accepts SQL; Phase 5 query generator must produce DuckDB SQL or PGQ MATCH syntax |
| FalkorDB tests use mock injection pattern | No embedded FalkorDB mode; asyncio queue and ABC contract tested via unittest.mock |
| query_points() replaces search() in qdrant-client 1.17.1 | search() was removed in this version; use query_points() and extract results from response.points |
| falkordblite excluded from initial pyproject.toml | Package name unverified on PyPI; resolved in P04 — correct package is 'falkordb' |
| uv binary at /Users/anshulmehta/.local/bin/uv | Must prepend to PATH in all subsequent plans on this machine (not in /opt/homebrew or /usr/local/bin) |
| FalkorDB over Kùzu | Kùzu abandoned Oct 2025; FalkorDB is production-ready GraphRAG-native replacement |
| GraphStore ABC before any FalkorDB code | Decouples all logic from FalkorDB API; enables DuckPGQ fallback; enforced at project start |
| Two-phase ingestion (nodes first, then edges) | Eliminates forward-reference ordering; every node exists before any edge is attempted |
| Node.js subprocess pool for tree-sitter | tree-sitter-sfapex runs in Node.js only; pool amortizes grammar load across 2k+ files |
| web-tree-sitter-sfapex (WASM) over tree-sitter-sfapex (native) | No Xcode license agreement or node-gyp required; WASM works on Node 22/25; maintained by same author |
| root.hasError is a PROPERTY not a method in WASM API | Calling root.hasError() throws TypeError; root.hasError (no parens) returns boolean — APEX-10 guard |
| extractRawFacts stub in Phase 2 returns class_declaration count only | Full CST traversal deferred to Phase 3; Phase 2 validates IPC protocol correctness first |
| Timeout in NodeParserPool triggers worker replacement (not just error return) | Avoids stale IPC response contamination — timed-out response would corrupt next request's JSON parsing |
| Per-worker asyncio.Semaphore(1) for parse serialization | Simpler than global asyncio.Queue; correct per-worker access serialization with fallback to first worker if all busy |
| Node.js 22 LTS (/opt/homebrew/opt/node@22/bin/node) pinned as worker runtime | WASM compatibility guaranteed on LTS; system node (v25) also works but LTS is documented support target |
| Three-agent query pipeline | Schema Filter reduces token cost 20-40x vs full schema injection |
| Python 3.12 hard requirement | FalkorDBLite 0.9.0 hard dependency; enforced in pyproject.toml |
| All logging to stderr only | MCP stdio transport is fatally corrupted by any stdout output |
| MERGE not CREATE for ingestion | Idempotent writes allow safe resume after crash |
| contextSnippet on all edges | 1-3 line source excerpt at near-zero cost; makes answers actionable |
| uv for package management | Recommended by official MCP docs; 10-100x faster than pip |
| logging.basicConfig(stream=sys.stderr) must precede all other imports in server.py | Protects MCP stdio JSON-RPC transport from stdout pollution |
| upsert_file always resets status to PENDING | Re-ingestion must restart the two-phase pipeline from scratch for consistency |
| get_delta only considers EDGES_WRITTEN files as baseline | Partially processed files treated as new work in next run |
| GraphStore ABC zero backend imports (enforced by test) | inspect.getsource scans full source including docstrings; backend names must not appear in base.py |
| All 6 GraphStore methods are async | Supports both in-process and networked backends uniformly; callers never need to know which they use |
| DuckPGQStore.close() is a no-op (not NotImplementedError) | Nothing to release; no-op is correct behavior, not a placeholder |
| FalkorDB live integration tests added in Plan 05 | docker-compose.test.yml provides test server; @pytest.mark.integration tests skip without server; socket probe pattern avoids pytest-asyncio skip-in-except bug |
| FalkorDBStore(host/port/graph_name) used in server.py lifespan | Plan stub had incorrect path= kwarg; actual Phase 1 constructor takes host, port, graph_name |
| ManifestStore(db_path=) used in server.py | Plan stub had path= kwarg; actual Phase 1 constructor uses db_path parameter |
| NodeFact requires non-empty sourceFile via @field_validator | Pydantic str fields accept "" by default; explicit validator needed to enforce INGEST-04 attribution requirement |
| Schema constants in constants.py, never hardcoded in parsers | Single source of truth for node types, edge types, categories — parsers import from this module |

### Critical Pitfalls to Remember

1. Python 3.12 still required — mcp + pydantic + fastembed dependencies
2. Stdout pollution corrupts MCP stdio transport — `logging.basicConfig(stream=sys.stderr)` must be first import; add CI assertion
3. DuckDB is fully embedded — no libomp, no Redis, no Docker needed
4. tree-sitter-sfapex has documented parse failures on enterprise Apex (5-20% error rate) — wrap all CST traversal with `has_error` guard
5. Qdrant local mode caps at ~20k vectors — design VectorStore abstraction to support both local + subprocess mode from the start
6. LLM Cypher hallucination is silent (FalkorDB returns empty, not error) — validate against `CALL db.labels()` before execution
7. Two-phase ingestion atomicity — track phase_1_complete / phase_2_complete in SQLite manifest; use MERGE for idempotency
8. Xcode license agreement blocks `git commit` on this machine — use `git -c core.hookspath=` to bypass when needed

### Architecture Reminders

- FastMCP Tool Layer is stateless — never touches storage directly; dispatches to service layer
- IngestionService owns two-phase discipline as asyncio Task; returns run_id immediately
- QueryService owns all Cypher execution and three-agent pipeline
- ParseDispatcher routes by file extension: `.cls`/`.trigger`/`.js` → Node.js pool; everything else → Python parsers
- DuckPGQStore stub validates Protocol boundary (GRAPH-04) — complete in P03
- ManifestStore is crash-recovery backbone — use from sfgraph.storage import ManifestStore
- GraphStore ABC is complete — DuckPGQStore is now the primary implementation; FalkorDBStore kept but not used by server
- sfgraph.storage exports: GraphStore, DuckPGQStore, FalkorDBStore, ManifestStore, VectorStore
- server.py uses DuckPGQStore(db_path="./data/sfgraph.duckdb") — no Redis, no Docker
- VectorStore uses query_points() API (qdrant-client 1.17.x); search() removed in this version

### TODOs for Planning

- [x] Validate FalkorDB write-concurrency under asyncio load during Phase 1 integration tests — DONE (20-concurrent-write test passes)
- [ ] Build parse-failure fixture corpus during Phase 3 (measure actual tree-sitter-sfapex error rate)
- [ ] Survey Vlocity DataPack fixture formats before writing Phase 4 extraction logic
- [ ] Experiment with CypherCorrector prompt engineering during Phase 5 (correction loop is well-architected but prompt tuning will need iteration)

### Blockers

None currently.

---

## Session Continuity

### Last Session (2026-04-06)

- Executed Plan 03-01: Schema constants, Pydantic models, fixture files
- Created src/sfgraph/ingestion/constants.py: 23 NODE_TYPES, 4 EDGE_CATEGORIES, 34 EDGE_TYPES, NODE_WRITE_ORDER
- Created src/sfgraph/ingestion/models.py: NodeFact, EdgeFact, IngestionSummary with full attribution validation
- Created tests/ingestion/test_constants.py: 13 tests all passing (GRAPH-01, GRAPH-03, INGEST-04, INGEST-06)
- Created tests/fixtures/metadata/ tree: Account object, 2 fields, flow, Apex class + meta XML
- Auto-fixed: added @field_validator("sourceFile") to NodeFact to reject empty strings
- 85/85 non-integration tests pass (no regressions)
- PHASE 3 PLAN 1 COMPLETE (1/5 plans in phase 3)

### Next Session

- Phase 3 Plan 02: XML object/field parser (SFObject + SFField nodes + picklist edges)
- fixtures/metadata/objects/Account ready for parser tests
- Note: export PATH="/Users/anshulmehta/.local/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
- Use /opt/homebrew/bin/git for all commits (Xcode license blocks /usr/bin/git)
- Live tests require Docker: `docker compose -f docker-compose.test.yml up -d`
- FalkorDB mock tests run without Docker: `uv run pytest -m "not integration"`

---

*State initialized: 2026-04-04*
