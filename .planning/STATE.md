---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
current_phase: 1 — Foundations
current_plan: None (not yet planned)
status: Not started
last_updated: "2026-04-04T08:46:31.492Z"
progress:
  total_phases: 1
  completed_phases: 0
  total_plans: 4
  completed_plans: 1
  percent: 25
---

# Project State: Salesforce Org Graph Analyzer

**Last updated:** 2026-04-04
**Session:** Initial roadmap creation

---

## Project Reference

**Core value:** A developer can ask "what breaks if I change this field?" and get a confident, sourced answer in under 5 seconds — across Apex, Flows, LWC, and Vlocity simultaneously.

**Current focus:** Phase 1 — Foundations

**Milestone:** v1 (all phases)

---

## Current Position

**Current phase:** 1 — Foundations
**Current plan:** 01 (completed) — next: 02
**Status:** In progress

**Progress:**
```
Phase 1 [███░░░░░░░] 25% (1/4 plans)
Phase 2 [          ] 0%
Phase 3 [          ] 0%
Phase 4 [          ] 0%
Phase 5 [          ] 0%
Phase 6 [          ] 0%

Overall [█░░░░░░░░░] ~4%
```

---

## Performance Metrics

| Metric | Value |
|--------|-------|
| Phases defined | 6 |
| Requirements mapped | 99/99 |
| Plans created | 4 |
| Plans completed | 1 |
| Phases completed | 0 |

| Phase | Plan | Duration | Tasks | Files |
|-------|------|----------|-------|-------|
| 01-foundations | P01 | 4 min | 2 | 8 |

## Accumulated Context

### Key Decisions

| Decision | Rationale |
|----------|-----------|
| falkordblite excluded from initial pyproject.toml | Package name unverified on PyPI; will add correct identifier in plan that implements FalkorDB |
| uv binary at /Users/anshulmehta/.local/bin/uv | Must prepend to PATH in all subsequent plans on this machine (not in /opt/homebrew or /usr/local/bin) |
| FalkorDB over Kùzu | Kùzu abandoned Oct 2025; FalkorDB is production-ready GraphRAG-native replacement |
| GraphStore ABC before any FalkorDB code | Decouples all logic from FalkorDB API; enables DuckPGQ fallback; enforced at project start |
| Two-phase ingestion (nodes first, then edges) | Eliminates forward-reference ordering; every node exists before any edge is attempted |
| Node.js subprocess pool for tree-sitter | tree-sitter-sfapex runs in Node.js only; pool amortizes grammar load across 2k+ files |
| Three-agent query pipeline | Schema Filter reduces token cost 20-40x vs full schema injection |
| Python 3.12 hard requirement | FalkorDBLite 0.9.0 hard dependency; enforced in pyproject.toml |
| All logging to stderr only | MCP stdio transport is fatally corrupted by any stdout output |
| MERGE not CREATE for ingestion | Idempotent writes allow safe resume after crash |
| contextSnippet on all edges | 1-3 line source excerpt at near-zero cost; makes answers actionable |
| uv for package management | Recommended by official MCP docs; 10-100x faster than pip |

### Critical Pitfalls to Remember

1. FalkorDBLite requires Python 3.12 — enforce in pyproject.toml before any other work
2. Stdout pollution corrupts MCP stdio transport — `logging.basicConfig(stream=sys.stderr)` must be first import; add CI assertion
3. FalkorDBLite spawns a Redis child process — requires `brew install libomp` on macOS; serialize all writes through asyncio queue
4. tree-sitter-sfapex has documented parse failures on enterprise Apex (5-20% error rate) — wrap all CST traversal with `has_error` guard
5. Qdrant local mode caps at ~20k vectors — design VectorStore abstraction to support both local + subprocess mode from the start
6. LLM Cypher hallucination is silent (FalkorDB returns empty, not error) — validate against `CALL db.labels()` before execution
7. Two-phase ingestion atomicity — track phase_1_complete / phase_2_complete in SQLite manifest; use MERGE for idempotency

### Architecture Reminders

- FastMCP Tool Layer is stateless — never touches storage directly; dispatches to service layer
- IngestionService owns two-phase discipline as asyncio Task; returns run_id immediately
- QueryService owns all Cypher execution and three-agent pipeline
- ParseDispatcher routes by file extension: `.cls`/`.trigger`/`.js` → Node.js pool; everything else → Python parsers
- DuckPGQStore stub must exist in Phase 1 to validate the Protocol boundary (GRAPH-04)

### TODOs for Planning

- [ ] Plan Phase 1 (`/gsd:plan-phase 1`)
- [ ] Validate FalkorDB write-concurrency under asyncio load during Phase 1 integration tests
- [ ] Build parse-failure fixture corpus during Phase 3 (measure actual tree-sitter-sfapex error rate)
- [ ] Survey Vlocity DataPack fixture formats before writing Phase 4 extraction logic
- [ ] Experiment with CypherCorrector prompt engineering during Phase 5 (correction loop is well-architected but prompt tuning will need iteration)

### Blockers

None currently.

---

## Session Continuity

### Last Session (2026-04-04)

- Executed Plan 01-01: sfgraph Python 3.12 project scaffold with uv
- Created pyproject.toml, .python-version, src/sfgraph package, tests/conftest.py
- uv.lock committed; pytest fixtures ready
- Stopped at: Completed 01-foundations-01-PLAN.md

### Next Session

- Execute Plan 01-02 (GraphStore ABC and DuckPGQ stub)
- Note: export PATH="/Users/anshulmehta/.local/bin:$PATH" for uv access
- FalkorDB package name must be verified before 01-02 or 01-03

---

*State initialized: 2026-04-04*
