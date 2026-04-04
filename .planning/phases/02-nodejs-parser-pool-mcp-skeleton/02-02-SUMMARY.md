---
phase: 02-nodejs-parser-pool-mcp-skeleton
plan: "02"
subsystem: parser
tags: [python, asyncio, subprocess, nodejs, ipc, pool, health-check, timeout]

# Dependency graph
requires:
  - phase: 02-nodejs-parser-pool-mcp-skeleton/02-01
    provides: worker.js WASM readline IPC worker, test fixtures simple.cls/broken.cls, IPC protocol

provides:
  - NodeParserPool async class at src/sfgraph/parser/pool.py
  - asyncio subprocess pool managing persistent Node.js workers
  - parse() round-trip IPC with 10s timeout enforcement
  - _ping_worker() health check with 5s asyncio.wait_for
  - _replace_worker() dead worker replacement at original list index
  - Background _health_loop() checking every 30s
  - 4 integration tests verifying full Python → Node.js IPC round-trip

affects:
  - 02-nodejs-parser-pool-mcp-skeleton/02-03 (ParseDispatcher routes to pool)
  - 02-nodejs-parser-pool-mcp-skeleton/02-04 (FastMCP server owns pool lifecycle)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - asyncio.create_subprocess_exec for persistent subprocesses (not subprocess.Popen)
    - Per-worker asyncio.Semaphore(1) serializes concurrent access to each worker
    - asyncio.wait_for(timeout=10.0) for per-file timeout isolation (POOL-06)
    - asyncio.wait_for(timeout=5.0) for health check pong response (POOL-04)
    - Worker replacement uses list index lookup to maintain stable _workers list
    - After timeout, worker replaced to avoid stale response contamination
    - Background health task created AFTER all workers spawned via create_task

key-files:
  created:
    - src/sfgraph/parser/pool.py (NodeParserPool — core deliverable)
    - tests/parser/test_pool.py (4 integration tests for pool lifecycle)
  modified: []

key-decisions:
  - "Timeout triggers worker replacement (not just error return) — avoids stale IPC response contamination on next request"
  - "Per-worker asyncio.Semaphore(1) used instead of global queue — simplest correct serialization per worker"
  - "Health loop starts AFTER all workers are spawned — avoids race where loop fires before workers ready"
  - "_replace_worker captures index before marking unhealthy — prevents race if called twice for same worker"

patterns-established:
  - "IPC dispatch pattern: write JSON line to stdin, readline stdout with wait_for timeout"
  - "Worker replacement: kill → wait → spawn → replace at original index (stable list)"
  - "Shutdown sequence: set flag → cancel health task → kill+wait all workers"

requirements-completed:
  - POOL-03
  - POOL-04
  - POOL-06

# Metrics
duration: 15min
completed: 2026-04-04
---

# Phase 2 Plan 02: NodeParserPool Summary

**asyncio subprocess pool managing persistent Node.js WASM workers with 10s parse timeout, 5s ping health checks, and automatic worker replacement**

## Performance

- **Duration:** 15 min
- **Started:** 2026-04-04T10:18:57Z
- **Completed:** 2026-04-04T10:33:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- NodeParserPool implements full asyncio subprocess pool: spawn, dispatch, health check, replace, shutdown
- parse() enforces 10s per-file timeout; on timeout, worker is replaced to prevent stale response contamination
- _ping_worker() health check uses asyncio.wait_for(5s) on pong response — POOL-04 satisfied
- Default size = min(cpu_count, 8) — POOL-03 satisfied
- TDD methodology: 4 failing tests RED committed first, then pool.py GREEN implementation
- 4 integration tests pass; 40 existing Phase 1 tests still pass (no regressions)

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: failing tests for NodeParserPool** - `e37a6f9` (test)
2. **Task 1 GREEN: NodeParserPool asyncio pool implementation** - `c6467a0` (feat)

_Note: Task 2 (integration tests) delivered as part of TDD RED phase in Task 1_

## Files Created/Modified
- `src/sfgraph/parser/pool.py` - NodeParserPool class: spawn, parse, health loop, shutdown (303 lines)
- `tests/parser/test_pool.py` - 4 integration tests: start+parse, parse error, ping health, shutdown cleanup

## Decisions Made
- Timeout triggers worker replacement (not just error return): avoids stale IPC response contamination — stale response from timed-out parse would corrupt next request's JSON parsing
- Per-worker asyncio.Semaphore(1) instead of a global asyncio.Queue — simpler, correct serialization per worker with fallback to first worker if all busy
- Health loop starts AFTER all workers are spawned to avoid a race where the first ping fires before workers are ready

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Xcode license agreement blocks system `/usr/bin/git`. Using `/opt/homebrew/bin/git` for all commits (same workaround documented in STATE.md critical pitfalls #8).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- NodeParserPool is ready for ParseDispatcher integration (Plan 02-03)
- pool.parse("file.cls", "apex", content) returns {ok, payload, error} with real worker.js subprocess
- pool.shutdown() terminates all workers cleanly — verified by test_pool_shutdown_cleans_up
- No blockers.

## Self-Check: PASSED

- src/sfgraph/parser/pool.py: FOUND
- tests/parser/test_pool.py: FOUND
- Commit e37a6f9 (RED: failing tests): FOUND
- Commit c6467a0 (GREEN: pool implementation): FOUND
- All 4 integration tests: PASSED
- 40 existing non-integration tests: PASSED (no regressions)

---
*Phase: 02-nodejs-parser-pool-mcp-skeleton*
*Completed: 2026-04-04*
