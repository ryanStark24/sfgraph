---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 6 — Hardening + OSS Readiness (IN PROGRESS)
current_plan: 03 (completed) — Orphan reduction + synthetic perf validation + release ops
status: in_progress
last_updated: "2026-04-06T23:30:00.000Z"
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 15
  completed_plans: 15
  percent: 67
---

# Project State: Salesforce Org Graph Analyzer

**Last updated:** 2026-04-06
**Session:** Priority hardening completed end-to-end (orphan reduction, agent trace pipeline, synthetic perf checks, release workflows, runbooks)

---

## Project Reference

**Core value:** A developer can ask "what breaks if I change this field?" and get a confident, sourced answer in under 5 seconds — across Apex, Flows, LWC, and Vlocity simultaneously.

**Current focus:** Phase 6 — Hardening + OSS Readiness

**Milestone:** v1 (all phases)

---

## Current Position

**Current phase:** 6 — Hardening + OSS Readiness (IN PROGRESS)
**Status:** Phase 5 advanced with map/dynamic/rules tooling; Phase 6 started with refresh/watch/snapshot hardening.

**Phase 3/4 plan status:**
- [x] 03-01 — Schema constants + Pydantic models + fixture tree (COMPLETE 2026-04-06)
- [x] 03-02 — Object/Field XML parser: OBJ-01 through OBJ-07 (COMPLETE 2026-04-06)
- [x] 03-03 — Apex CST full traversal + apex_extractor.py + DynamicAccessorRegistry (COMPLETE 2026-04-06, 15 tests pass)
- [x] 03-04 — Flow XML parser: FLOW-01 through FLOW-08 (COMPLETE 2026-04-06)
- [x] 03-05 — IngestionService two-phase orchestrator + ingest_org MCP tool (COMPLETE 2026-04-06)
- [x] 04-01 — LWC parser: LWC-01 through LWC-06 (COMPLETE 2026-04-06)
- [x] 04-02 — Vlocity parser: VLO-01 through VLO-07 (COMPLETE 2026-04-06)

**Progress:**
```
Phase 1 [██████████] 100% (5/5 plans — COMPLETE)
Phase 2 [██████████] 100% (3/3 plans — COMPLETE)
Phase 3 [██████████] 100% (5/5 plans — COMPLETE)
Phase 4 [██████████] 100% (2/2 plans — COMPLETE)
Phase 5 [███████   ] ~75% (agent trace + test intelligence complete)
Phase 6 [██████    ] ~60% (migration/vector/orphan/perf/release ops complete)

Overall [█████████░] ~88%
```

---

## Performance Metrics

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01-foundations | P01 | 4 min | 2 | 8 |
| 01-foundations | P02 | 2 min | 2 | 5 |
| 01-foundations | P03 | 2 min | 1 | 4 |
| 01-foundations | P04 | 18 min | 2 | 5 |
| 01-foundations | P05 | 8 min | 3 | 4 |
| 02-nodejs-parser-pool | P01 | 12 min | 2 | 9 |
| 02-nodejs-parser-pool | P02 | 15 min | 2 | 2 |
| 02-nodejs-parser-pool | P03 | 2 min | 2 | 3 |
| 03-ingestion-pipeline-core | P01 | 2 min | 2 | 11 |
| 03-ingestion-pipeline-core | P02 | 2 min | 1 | 2 |

---

## Accumulated Context

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| DuckPGQ (duckdb>=1.0.0) replaces falkordb as graph store | falkordb required a running Redis server + Docker; DuckPGQ is fully embedded in-process — no server, no Docker, works on restricted company machines |
| DuckPGQStore stores nodes in per-label tables, edges in per-rel-type tables | Each label/rel_type gets its own DuckDB table; schema tracked in _sfgraph_schema metadata table; props stored as JSON column |
| query() method accepts DuckDB SQL / PGQ SQL, not Cypher | GraphStore ABC still names param 'cypher' but DuckPGQStore documents it accepts SQL; Phase 5 query generator must produce DuckDB SQL or PGQ MATCH syntax |
| FalkorDB tests use mock injection pattern | No embedded FalkorDB mode; asyncio queue and ABC contract tested via unittest.mock |
| query_points() replaces search() in qdrant-client 1.17.1 | search() was removed in this version; use query_points() and extract results from response.points |
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
| ObjectParser: _tag() helper required for all find/findtext calls | SF metadata XML is namespaced; bare tag names silently return None — always use _tag() |
| ObjectParser: object type detected from directory name first | __e, __mdt suffix detection avoids an XML parse for the common case; customSettingsType check is a fallback |

### Critical Pitfalls to Remember

1. Python 3.12 still required — mcp + pydantic + fastembed dependencies
2. Stdout pollution corrupts MCP stdio transport — `logging.basicConfig(stream=sys.stderr)` must be first import; add CI assertion
3. DuckDB is fully embedded — no libomp, no Redis, no Docker needed
4. tree-sitter-sfapex has documented parse failures on enterprise Apex (5-20% error rate) — wrap all CST traversal with `has_error` guard
5. Qdrant local mode caps at ~20k vectors — design VectorStore abstraction to support both local + subprocess mode from the start
6. LLM Cypher hallucination is silent (FalkorDB returns empty, not error) — validate against `CALL db.labels()` before execution
7. Two-phase ingestion atomicity — track phase_1_complete / phase_2_complete in SQLite manifest; use MERGE for idempotency
8. Xcode license agreement blocks `git commit` on this machine — use `/opt/homebrew/bin/git` to bypass
9. **worker.js WASM API pitfalls (APEX-10):**
   - `root.hasError` is a **PROPERTY** (boolean), NOT `root.hasError()` — calling it as a method throws TypeError
   - DML type: `dml.namedChildren[0]?.text` — NOT `dml.childForFieldName('dml_type')` which returns undefined
   - SOQL bracket: `query_expression → soql_query_body` (NOT `soql_query`)
   - Custom Label detection: `field_access` where object is `field_access` with inner field `Label`, OR identifier `Label`
   - EventBus.publish: method_invocation where obj.text == 'EventBus' AND name == 'publish'
10. SF metadata XML namespace: ALL element names must use `_tag()` helper — `root.find('label')` silently returns None

### Architecture Reminders

- FastMCP Tool Layer is stateless — never touches storage directly; dispatches to service layer
- IngestionService owns two-phase discipline as asyncio Task; returns run_id immediately
- QueryService owns all Cypher execution and three-agent pipeline
- ParseDispatcher routes by file extension: `.cls`/`.trigger` → Node.js pool; `.xml`/`.labels` → Python parsers
- ManifestStore is crash-recovery backbone — use `from sfgraph.storage import ManifestStore`
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

None. Rate limit expired — continue with Wave 2 (plans 03-03 and 03-04 in parallel, then 03-05).

---

## Session Continuity

### Last Session (2026-04-06)

**Wave 1 — Complete (both ran in parallel):**

Plan 03-01 — Schema constants + Pydantic models + fixture files:
- Created `src/sfgraph/ingestion/constants.py`: 23 NODE_TYPES, 4 EDGE_CATEGORIES (frozenset), 34 EDGE_TYPES, NODE_WRITE_ORDER (SFObject first), NODE_TYPE_DESCRIPTIONS
- Created `src/sfgraph/ingestion/models.py`: NodeFact (with empty sourceFile validator), EdgeFact (edgeCategory + confidence validators), IngestionSummary
- Created `tests/ingestion/test_constants.py`: 13/13 tests pass
- Created `tests/fixtures/metadata/` tree: Account object XML, Status__c (picklist, 2 values), DaysOnMarket__c (formula), Simple_Account_Update.flow-meta.xml (full featured), AccountService.cls + meta XML
- Auto-fixed: added `@field_validator("sourceFile")` to NodeFact (Pydantic doesn't reject "" by default)
- Commits: 0f3ff51, 2a542f7, 7f5f693

Plan 03-02 — Object/Field XML parser:
- Created `src/sfgraph/parser/object_parser.py`: parse_object_dir(), parse_field_xml(), parse_labels_xml(), ObjectParser class
- Covers: OBJ-01 through OBJ-07 (SFObject, SFField, SFPicklistValue, FIELD_HAS_VALUE, FIELD_USES_GLOBAL_SET, PlatformEvent, CustomSetting, CustomMetadataType, formula FORMULA_DEPENDS_ON, CustomLabel)
- Created `tests/parser/test_object_parser.py`: 15/15 tests pass
- Commits: a35f7ba, 5d2f4ce

**Wave 2 — Partial:**

Plan 03-03 — Apex CST full traversal (COMPLETE):
- Expanded `src/sfgraph/parser/worker/worker.js` extractRawFacts(): class/method nodes, SOQL, DML, cross-class calls, label refs, EventBus.publish, picklist comparisons, external namespace
- Created `src/sfgraph/parser/apex_extractor.py`: ApexExtractor.extract() → (NodeFact list, EdgeFact list)
- Created `src/sfgraph/parser/dynamic_accessor.py`: DynamicAccessorRegistry (APEX-11, YAML-driven)
- Created `config/dynamic_accessors.yaml`: fflib patterns (selectById, registerNew, registerDirty, Database.query, Schema.getGlobalDescribe)
- Created `tests/parser/test_apex_extractor.py`: 15/15 tests pass
- Full suite: 115 passed, 6 integration skipped

Plan 03-04 — Flow XML parser: **NOT DONE** (rate-limited mid-session)

### Next Session — Plan 03-04 (then 03-05)

**Plan 03-04 — Flow XML parser (DO FIRST):**
- Create `src/sfgraph/parser/flow_parser.py`: parse_flow_xml(), FlowParser class
- Covers FLOW-01 through FLOW-08
- Create `tests/parser/test_flow_parser.py`
- Fixture already exists: `tests/fixtures/metadata/flows/Simple_Account_Update.flow-meta.xml`
- See `.planning/phases/03-ingestion-pipeline-core/03-04-PLAN.md` for full implementation

**Plan 03-05 — IngestionService (AFTER 03-04):**
- Create `src/sfgraph/ingestion/service.py`, `src/sfgraph/ingestion/schema_index.py`
- Update `src/sfgraph/server.py` (ingest_org tool)
- Create `tests/ingestion/test_ingestion_service.py`
- See `.planning/phases/03-ingestion-pipeline-core/03-05-PLAN.md`

**Commands:**
```bash
export PATH="/Users/anshulmehta/.local/bin:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd /Users/anshulmehta/Documents/salesforceMCP
uv run pytest -m "not integration" --tb=short 2>&1 | tail -5  # baseline: 115 passed
```

---

*State initialized: 2026-04-04*
*Last updated: 2026-04-06 — Wave 1 complete, Wave 2 pending*
