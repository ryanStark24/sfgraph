---
phase: 02-nodejs-parser-pool-mcp-skeleton
verified: 2026-04-04T11:00:00Z
status: passed
score: 5/5 must-haves verified
re_verification: false
---

# Phase 2: Node.js Parser Pool + MCP Skeleton Verification Report

**Phase Goal:** The Python-to-Node.js IPC boundary is proven to work end-to-end with a real Apex file, and the FastMCP server skeleton enforces stdout discipline from the first line of code.
**Verified:** 2026-04-04T11:00:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | A pool of min(cpu_count, 8) Node.js workers starts, each loading tree-sitter-sfapex once, and parses an Apex .cls file returning structured JSON without spawning a new process per file | VERIFIED | `NodeParserPool(size=1).parse()` round-trips to worker.js; `init()` loads grammar once before readline loop; 4 integration tests pass including `test_pool_starts_and_parses_apex_file` |
| 2 | A worker that receives a ping and fails to reply within 5 seconds is detected and automatically replaced by a healthy worker | VERIFIED | `_ping_worker()` uses `asyncio.wait_for(timeout=5.0)`; returns False on timeout/exception; `_health_loop()` calls `_replace_worker()` on False; `test_pool_ping_health_check` confirms live pong from real worker |
| 3 | ParseDispatcher routes a .cls file to the Node.js pool and a Flow XML file to the Python parser path; incorrect routing raises ValueError at dispatch time | VERIFIED | `route_file()` in dispatcher.py uses frozenset membership; 11 unit tests pass at 100% coverage including pdf and empty-extension ValueError cases |
| 4 | The FastMCP server starts with a lifespan context manager that owns all storage handles; zero stdout pollution from the server process | VERIFIED | server.py has `@asynccontextmanager async def lifespan()` owning FalkorDBStore, VectorStore, ManifestStore, NodeParserPool; `logging.basicConfig(stream=sys.stderr)` precedes all other imports; `test_stdout_discipline.py` 2/2 pass |
| 5 | An Apex file with tree-sitter parse errors is detected via the has_error guard, logged to stderr, and returns {ok:false} without silently producing incomplete edges | VERIFIED | worker.js line 80: `if (root.hasError)` (property, not method); returns `{ok:false,error:"parse_error",payload:null}`; `test_parse_broken_apex_returns_parse_error` and `test_pool_parse_error_returns_ok_false` both pass |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `package.json` | Node.js project with web-tree-sitter-sfapex dependency | VERIFIED | Contains `"web-tree-sitter-sfapex": "^2.4.1"` and `"type": "commonjs"` |
| `node_modules/web-tree-sitter-sfapex/` | WASM grammar installed | VERIFIED | Directory exists; npm install completed |
| `src/sfgraph/parser/worker/worker.js` | WASM readline IPC worker | VERIFIED | 133 lines; init() loads grammar once; handleLine dispatches ping/parse/exit; hasError as property; stderr-only logging; memory_ceiling after 200 files |
| `src/sfgraph/parser/pool.py` | NodeParserPool async class | VERIFIED | Exports NodeParserPool; 303 lines; all methods present: start, parse, _dispatch, _health_loop, _ping_worker, _replace_worker, shutdown |
| `src/sfgraph/parser/dispatcher.py` | route_file() stateless routing function | VERIFIED | Exports route_file, NODEJS_EXTENSIONS, VALID_EXTENSIONS, ParserTarget; 44 lines; 100% test coverage |
| `src/sfgraph/server.py` | FastMCP server with lifespan + ping tool | VERIFIED | AppContext dataclass with graph/vectors/manifest/pool; lifespan asynccontextmanager; mcp = FastMCP(..., lifespan=lifespan); ping tool accesses lifespan_context; logging configured before imports |
| `tests/parser/fixtures/simple.cls` | Valid Apex fixture | VERIFIED | Exists; AccountService with SOQL query |
| `tests/parser/fixtures/broken.cls` | Apex with intentional parse errors | VERIFIED | Exists; missing closing paren triggers tree-sitter hasError |
| `tests/parser/test_pool.py` | Pool integration tests | VERIFIED | 4 tests, all pass with @pytest.mark.integration |
| `tests/parser/test_dispatcher.py` | Dispatcher unit tests | VERIFIED | 11 tests, all pass with 100% coverage on dispatcher.py |
| `tests/parser/test_worker_ipc.py` | Worker IPC protocol tests | VERIFIED | 5 tests, all pass; covers ping/pong, valid parse, broken parse, multi-request correlation |

---

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `worker.js stdin readline` | `stdout JSON response` | requestId correlation | VERIFIED | handleLine writes `{requestId, type:"pong"}` and `{requestId, ok, payload}` to stdout; smoke tests confirm matching requestId |
| `NodeParserPool.parse()` | `worker.js via asyncio subprocess stdin/stdout` | `asyncio.create_subprocess_exec` + readline | VERIFIED | pool.py line 107: `asyncio.create_subprocess_exec(node_bin, WORKER_JS, stdin=PIPE, stdout=PIPE, ...)`; _dispatch writes request and reads readline |
| `NodeParserPool._health_loop()` | `_replace_worker()` | `asyncio.wait_for(timeout=5.0)` on ping response | VERIFIED | pool.py line 217: `await self._replace_worker(worker)` triggered when `_ping_worker` returns False; `wait_for(..., timeout=5.0)` in `_ping_worker` (line 236) |
| `server.py lifespan()` | `NodeParserPool` | `pool.start()` in lifespan context | VERIFIED | server.py lines 40-42: `pool = NodeParserPool(); await pool.start()` inside lifespan; `await pool.shutdown()` in cleanup |
| `server.py lifespan()` | `FalkorDBStore, VectorStore, ManifestStore` | direct instantiation and yield AppContext | VERIFIED | server.py lines 37-45: all four engines instantiated, yielded via AppContext dataclass |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| POOL-01 | 02-01 | Persistent Node.js subprocess pool loads tree-sitter-sfapex once at startup | VERIFIED | `init()` calls `getApexParser()` once before readline loop; `test_pool_starts_and_parses_apex_file` confirms pool reuse across requests |
| POOL-02 | 02-01 | Python-to-Node.js IPC uses newline-delimited JSON over stdin/stdout | VERIFIED | worker.js readline on stdin, JSON.stringify+'\n' to stdout; pool.py writes `json.dumps(request) + "\n"` and reads `readline()`; 5 IPC tests confirm protocol |
| POOL-03 | 02-02 | Pool scales to min(cpu_count, 8) workers; each stays alive across files | VERIFIED | pool.py line 79: `self._size = size or min(os.cpu_count() or 4, 8)`; workers persist via `self._workers` list; no per-file spawn |
| POOL-04 | 02-02 | Worker health check: Python sends {type:"ping"} every 30s; no pong within 5s -> replace worker | VERIFIED | `_health_loop()` sleeps 30s then calls `_ping_worker()`; `_ping_worker` uses `wait_for(timeout=5.0)`; returns False on timeout -> `_replace_worker()` |
| POOL-05 | 02-01 | Workers restart after processing 200 files (prevents Node.js heap accumulation) | VERIFIED | worker.js: `if (fileCount > MAX_FILES)` returns `{ok:false,error:"memory_ceiling"}` and calls `process.exit(0)`; pool.py handles memory_ceiling by scheduling `_replace_worker` |
| POOL-06 | 02-02 | Per-file timeout of 10s; timeout returns {ok:false,error:"timeout"} without killing the worker | VERIFIED | pool.py line 179: `asyncio.wait_for(..., timeout=10.0)` in `_dispatch`; TimeoutError returns `{ok:False,error:"timeout",payload:None}`; worker replacement scheduled to avoid stale response contamination |
| POOL-07 | 02-03 | ParseDispatcher routes .cls/.trigger/.js to Node.js pool; other types to Python parsers | VERIFIED | dispatcher.py NODEJS_EXTENSIONS = {".cls", ".trigger", ".js"}; route_file() returns "nodejs_pool" or "python_parser"; raises ValueError for unrecognized extensions; 11 unit tests at 100% coverage |
| MCP-01 | 02-03 | FastMCP server initializes with lifespan context manager owning all storage engines | VERIFIED | server.py: `@asynccontextmanager async def lifespan(server: FastMCP)` instantiates FalkorDBStore, VectorStore, ManifestStore, NodeParserPool; yields AppContext; stdout discipline maintained |

**All 8 requirements fully satisfied.** No orphaned requirements.

---

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
| ---- | ------- | -------- | ------ |
| `src/sfgraph/parser/worker/worker.js` | `extractRawFacts` is a Phase 2 stub returning only class_declaration count; `nodes: []` and `potential_refs: []` are always empty | Info | Expected — documented in plan and summary; Phase 3 expands CST traversal. Does not block Phase 2 goal. |

No blockers. No TODOs, FIXMEs, or placeholder comments found in key files.

---

### Human Verification Required

None. All Phase 2 success criteria are programmatically verifiable (subprocess IPC, file existence, test results, stdout discipline). No visual UI, real-time behavior, or external service dependencies to validate.

---

### Test Results Summary

| Test Suite | Tests | Result |
| ---------- | ----- | ------ |
| `tests/parser/test_worker_ipc.py` | 5 | All pass |
| `tests/parser/test_pool.py` (integration) | 4 | All pass |
| `tests/parser/test_dispatcher.py` | 11 | All pass |
| `tests/test_stdout_discipline.py` | 2 | All pass |
| All non-integration tests (Phase 1 + Phase 2) | 56 | All pass, 6 integration deselected |

**Total: 22 Phase 2 tests pass. 56 total non-integration tests pass (zero Phase 1 regressions).**

---

### Gaps Summary

None. All 5 success criteria, all 8 requirements, and all 11 artifacts verified. The phase goal is achieved: the Python-to-Node.js IPC boundary is proven end-to-end with a real Apex file (simple.cls parsed, broken.cls correctly rejected), and the FastMCP server skeleton enforces stdout discipline from the first line of code (logging.basicConfig to stderr before all other imports, verified by test_stdout_discipline.py).

---

_Verified: 2026-04-04T11:00:00Z_
_Verifier: Claude (gsd-verifier)_
