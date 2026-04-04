---
phase: 02-nodejs-parser-pool-mcp-skeleton
plan: "01"
subsystem: parser
tags: [nodejs, tree-sitter, wasm, ipc, apex, readline]

# Dependency graph
requires:
  - phase: 01-foundations
    provides: Python package structure, pyproject.toml, test infrastructure
provides:
  - package.json with web-tree-sitter-sfapex 2.4.1 WASM dependency
  - worker.js WASM readline IPC worker at src/sfgraph/parser/worker/worker.js
  - Python package markers for src/sfgraph/parser and tests/parser
  - Test fixtures simple.cls (valid Apex) and broken.cls (parse errors)
  - IPC protocol: newline-delimited JSON over stdin/stdout with requestId correlation
affects:
  - 02-nodejs-parser-pool-mcp-skeleton/02-02 (NodeParserPool uses worker.js)
  - 02-nodejs-parser-pool-mcp-skeleton/02-03 (ParseDispatcher routes to pool)
  - 02-nodejs-parser-pool-mcp-skeleton/02-04 (FastMCP server owns pool lifecycle)

# Tech tracking
tech-stack:
  added:
    - web-tree-sitter-sfapex@2.4.1 (npm, WASM-based Apex/SOQL/SOSL parser)
    - web-tree-sitter@0.24.x (npm, pulled transitively as WASM runtime)
  patterns:
    - WASM grammar loaded once at startup in init() async function, not per-file
    - Newline-delimited JSON (NDJSON) over stdin/stdout for Python-to-Node IPC
    - requestId correlation for matching responses to requests
    - hasError as boolean PROPERTY (not method call) in web-tree-sitter WASM API
    - All worker logging to stderr; stdout reserved exclusively for JSON responses
    - Voluntary process.exit(0) after MAX_FILES (200) for heap management (POOL-05)

key-files:
  created:
    - package.json (Node.js project with web-tree-sitter-sfapex dependency)
    - package-lock.json (lockfile for reproducible installs)
    - src/sfgraph/parser/__init__.py (Python package marker)
    - src/sfgraph/parser/worker/__init__.py (Python package marker)
    - src/sfgraph/parser/worker/worker.js (WASM IPC worker — core deliverable)
    - tests/parser/__init__.py (Python package marker)
    - tests/parser/fixtures/simple.cls (valid Apex fixture)
    - tests/parser/fixtures/broken.cls (Apex with intentional parse errors)
    - tests/parser/test_worker_ipc.py (5 IPC protocol integration tests)
  modified: []

key-decisions:
  - "web-tree-sitter-sfapex (WASM) chosen over tree-sitter-sfapex (native) — no Xcode/node-gyp required; works on Node.js 22 LTS"
  - "Node.js 22 LTS (/opt/homebrew/opt/node@22/bin/node) pinned as worker runtime — WASM compatibility guaranteed on LTS"
  - "hasError is a PROPERTY not a method in WASM API — calling root.hasError() throws TypeError (APEX-10 guard)"
  - "extractRawFacts is a Phase 2 stub returning class_declaration count — Phase 3 expands CST traversal"
  - "fileCount incremented before MAX_FILES check — first parse at count 201 returns memory_ceiling and exits"

patterns-established:
  - "IPC Pattern: NDJSON over stdin/stdout with requestId for response correlation"
  - "Worker lifecycle: init() loads grammar once, readline loop handles all requests"
  - "Error isolation: try/catch in handleLine ensures one bad file never crashes worker"
  - "Stderr discipline: process.stderr.write() for all worker logs, never process.stdout.write() for non-JSON"

requirements-completed:
  - POOL-01
  - POOL-02
  - POOL-05

# Metrics
duration: 12min
completed: 2026-04-04
---

# Phase 2 Plan 01: Node.js WASM IPC Worker Foundation Summary

**web-tree-sitter-sfapex WASM worker with readline NDJSON protocol, ping/pong health check, parse-error guard, and memory-ceiling self-exit after 200 files**

## Performance

- **Duration:** 12 min
- **Started:** 2026-04-04T09:30:00Z
- **Completed:** 2026-04-04T09:42:00Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- npm project initialized with web-tree-sitter-sfapex@2.4.1 (WASM, no native compilation required)
- worker.js implements full IPC protocol: ping/pong health check, Apex parse, error handling, exit
- APEX-10 guard: `root.hasError` property access (not method) prevents TypeError in WASM API
- POOL-05: voluntary process.exit(0) after 200 files prevents Node.js heap accumulation
- TDD methodology: 5 failing tests written first, all 5 passing after implementation
- Zero regressions: 45/45 non-integration tests pass after adding parser package

## Task Commits

Each task was committed atomically:

1. **Task 1: npm project setup + web-tree-sitter-sfapex install** - `4bc531d` (chore)
2. **Task 2 RED: failing tests for worker.js IPC protocol** - `447c31e` (test)
3. **Task 2 GREEN: worker.js WASM IPC implementation** - `a8b3da6` (feat)

_Note: TDD task has two commits (test RED phase, then feat GREEN phase)_

## Files Created/Modified
- `package.json` - Node.js project with web-tree-sitter-sfapex@2.4.1 and "type": "commonjs"
- `package-lock.json` - Lockfile for reproducible installs
- `src/sfgraph/parser/__init__.py` - Python package marker for parser module
- `src/sfgraph/parser/worker/__init__.py` - Python package marker for worker submodule
- `src/sfgraph/parser/worker/worker.js` - WASM readline IPC worker (core deliverable)
- `tests/parser/__init__.py` - Python package marker for test module
- `tests/parser/fixtures/simple.cls` - Valid Apex class for parse success tests
- `tests/parser/fixtures/broken.cls` - Apex with missing closing brace for parse error tests
- `tests/parser/test_worker_ipc.py` - 5 integration tests for IPC protocol verification

## Decisions Made
- Used web-tree-sitter-sfapex (WASM) instead of tree-sitter-sfapex (native): no Xcode license agreement or node-gyp compilation required on this machine
- Node.js 22 LTS binary at /opt/homebrew/opt/node@22/bin/node pinned as worker runtime
- `root.hasError` accessed as PROPERTY (WASM API differs from native API where it was a method)
- extractRawFacts is a stub in Phase 2: returns class_declaration count only; full CST traversal deferred to Phase 3

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- `timeout` command not available in zsh PATH by default on macOS; verification adapted to use subprocess.run() with timeout parameter in Python instead. Worker functionality unaffected.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- worker.js is ready for NodeParserPool integration (Plan 02-02)
- IPC protocol verified end-to-end: ping/pong, parse valid Apex (ok:true), parse broken Apex (ok:false, error:parse_error)
- Test fixtures available for pool-level integration tests
- No blockers.

---
*Phase: 02-nodejs-parser-pool-mcp-skeleton*
*Completed: 2026-04-04*
