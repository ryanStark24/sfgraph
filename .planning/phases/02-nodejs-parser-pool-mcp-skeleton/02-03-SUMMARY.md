---
phase: 02-nodejs-parser-pool-mcp-skeleton
plan: "03"
subsystem: parser
tags: [python, fastmcp, dispatcher, routing, lifespan, mcp, asynccontextmanager]

# Dependency graph
requires:
  - phase: 02-nodejs-parser-pool-mcp-skeleton/02-02
    provides: NodeParserPool async pool with start/shutdown API
  - phase: 01-foundations
    provides: FalkorDBStore, VectorStore, ManifestStore storage implementations

provides:
  - route_file() stateless routing function at src/sfgraph/parser/dispatcher.py
  - NODEJS_EXTENSIONS, VALID_EXTENSIONS frozensets, ParserTarget Literal type
  - FastMCP server with lifespan at src/sfgraph/server.py
  - AppContext dataclass owning all 4 engines (graph, vectors, manifest, pool)
  - ping tool returning ok -- pool_size=N
  - 11 dispatcher unit tests at tests/parser/test_dispatcher.py

affects:
  - Phase 3 ingestion (ParseDispatcher is ingestion entry point)
  - All subsequent phases (FastMCP server lifespan is top-level resource owner)

# Tech tracking
tech-stack:
  added:
    - FastMCP lifespan context manager pattern (asynccontextmanager)
    - dataclasses.dataclass for AppContext
  patterns:
    - Stateless routing via Path().suffix.lower() against frozenset membership
    - lifespan() as asynccontextmanager — owns all resource lifecycle (start → yield → shutdown)
    - logging.basicConfig(stream=sys.stderr) BEFORE all other imports in server.py (MCP stdio discipline)
    - FalkorDBStore constructor uses host/port/graph_name (not path=) — adapted from plan stub
    - ManifestStore constructor uses db_path (not path=) — adapted from plan stub

key-files:
  created:
    - src/sfgraph/parser/dispatcher.py (route_file, NODEJS_EXTENSIONS, VALID_EXTENSIONS, ParserTarget)
    - tests/parser/test_dispatcher.py (11 unit tests — 100% dispatcher coverage)
  modified:
    - src/sfgraph/server.py (Phase 1 stub replaced with full FastMCP lifespan + ping tool)

key-decisions:
  - "FalkorDBStore(host='localhost', port=6379, graph_name='org_graph') used — plan stub had path= kwarg which does not match actual constructor"
  - "ManifestStore(db_path='./data/manifest.sqlite') used — plan stub had path= kwarg; actual constructor uses db_path"
  - "11 tests written (plan specified 9) — added 2 additional constant-export verification tests for completeness"

# Metrics
duration: 2min
completed: 2026-04-04
---

# Phase 2 Plan 03: ParseDispatcher + FastMCP Lifespan Summary

**Stateless extension-based routing (route_file) and FastMCP lifespan owning FalkorDBStore, VectorStore, ManifestStore, and NodeParserPool**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-04T10:25:06Z
- **Completed:** 2026-04-04T10:27:00Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- dispatcher.py: route_file() routes .cls/.trigger/.js to nodejs_pool, .xml/.html/.json to python_parser, raises ValueError for unrecognized extensions
- 11 unit tests written (TDD RED then GREEN); 100% coverage on dispatcher.py
- server.py: Phase 1 stub replaced with full FastMCP lifespan skeleton
- AppContext dataclass wires graph, vectors, manifest, pool as lifespan context
- ping tool reads pool._workers from lifespan context and returns pool_size
- stdout discipline maintained: test_stdout_discipline.py 2/2 pass
- Phase 1 regression check: 56/56 non-integration tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1 RED+GREEN: ParseDispatcher + unit tests** - `37303ee` (feat)
2. **Task 2: FastMCP server lifespan + ping tool** - `1a34bce` (feat)

## Files Created/Modified
- `src/sfgraph/parser/dispatcher.py` - route_file(), NODEJS_EXTENSIONS, VALID_EXTENSIONS, ParserTarget (44 lines)
- `tests/parser/test_dispatcher.py` - 11 unit tests covering all routing cases and constant exports
- `src/sfgraph/server.py` - Full FastMCP skeleton with AppContext, lifespan, mcp, ping tool (replaced Phase 1 stub)

## Decisions Made
- `FalkorDBStore(host='localhost', port=6379, graph_name='org_graph')`: plan stub used `path=` kwarg which does not match the actual Phase 1 constructor signature — adapted to real API
- `ManifestStore(db_path='./data/manifest.sqlite')`: plan stub used `path=` kwarg; actual constructor parameter is `db_path` — adapted to real API
- 11 tests instead of plan's 9: added `test_nodejs_extensions_contains_expected_set` and `test_valid_extensions_is_superset_of_nodejs_extensions` to verify exported constants are correct

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] FalkorDBStore constructor signature mismatch**
- **Found during:** Task 2 (server.py implementation)
- **Issue:** Plan stub used `FalkorDBStore(path="./data/org.db")` but actual constructor takes `host`, `port`, `graph_name` parameters (no `path=` kwarg exists)
- **Fix:** Used `FalkorDBStore(host="localhost", port=6379, graph_name="org_graph")` to match Phase 1 implementation
- **Files modified:** src/sfgraph/server.py
- **Commit:** 1a34bce

**2. [Rule 1 - Bug] ManifestStore constructor signature mismatch**
- **Found during:** Task 2 (server.py implementation)
- **Issue:** Plan stub used `ManifestStore(path="./data/manifest.sqlite")` but actual constructor uses `db_path` parameter
- **Fix:** Used `ManifestStore(db_path="./data/manifest.sqlite")` to match Phase 1 implementation
- **Files modified:** src/sfgraph/server.py
- **Commit:** 1a34bce

## User Setup Required
None - no external service configuration required for unit tests. Integration tests (pool tests) require Node.js 22 at /opt/homebrew/opt/node@22/bin/node.

## Next Phase Readiness
- ParseDispatcher is ready for Phase 3 ingestion integration
- FastMCP server lifespan pattern is established — Phase 3+ tools inherit correct resource ownership
- All POOL-01 through POOL-07 and MCP-01 requirements addressed across Phase 2 plans 01-03
- No blockers.

## Self-Check: PASSED

- src/sfgraph/parser/dispatcher.py: FOUND
- tests/parser/test_dispatcher.py: FOUND
- src/sfgraph/server.py: FOUND (updated)
- Commit 37303ee (feat: dispatcher + tests): FOUND
- Commit 1a34bce (feat: server lifespan): FOUND
- 11 dispatcher unit tests: PASSED
- 2 stdout discipline tests: PASSED
- 56 non-integration tests (Phase 1 regression): PASSED

---
*Phase: 02-nodejs-parser-pool-mcp-skeleton*
*Completed: 2026-04-04*
