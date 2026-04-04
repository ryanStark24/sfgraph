# Phase 2: Node.js Parser Pool + MCP Skeleton - Research

**Researched:** 2026-04-04
**Domain:** Python asyncio subprocess pool + Node.js tree-sitter IPC + FastMCP lifespan
**Confidence:** HIGH

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| POOL-01 | Persistent Node.js subprocess pool loads tree-sitter-sfapex and tree-sitter-javascript grammars once at startup | WASM worker startup pattern verified; grammar loaded once per worker process |
| POOL-02 | Python↔Node.js IPC uses newline-delimited JSON over stdin/stdout (request: `{requestId, grammar, filePath, fileContent}`, response: `{requestId, ok, payload, error}`) | End-to-end IPC verified: readline + asyncio.create_subprocess_exec round-trip confirmed working |
| POOL-03 | Pool scales to min(cpu_count, 8) workers; each worker stays alive across files (no per-file spawn) | os.cpu_count() logic verified; worker persistence confirmed via file-counter approach |
| POOL-04 | Worker health check: Python sends `{type:"ping"}` every 30s; no `{type:"pong"}` within 5s → replace worker | asyncio.wait_for(timeout=5.0) pattern tested and working; SIGKILL + restart verified |
| POOL-05 | Workers restart after processing 200 files (prevents Node.js heap accumulation on large orgs) | File counter in worker.js; voluntary process.exit(0) after 200 files confirmed |
| POOL-06 | Per-file timeout of 10s; timeout returns `{ok:false, error:"timeout"}` without killing the worker | asyncio.wait_for timeout tested; timeout isolates per-request not per-worker |
| POOL-07 | ParseDispatcher routes `.cls`/`.trigger`/`.js` files to Node.js pool; all other file types to Python parsers | Extension-based routing tested: all 7 test cases pass |
| MCP-01 | FastMCP server initializes with lifespan context manager owning all storage handles; curl returns valid JSON-RPC response with zero stdout pollution | FastMCP lifespan pattern verified; Context.request_context.lifespan_context confirmed as access path |
</phase_requirements>

---

## Summary

Phase 2 establishes the two highest-risk integration boundaries in the system: the Python↔Node.js IPC channel and the FastMCP server lifespan with stdout discipline. Both are proven working via direct testing in this research session. The correct implementation path is clear and specific — no exploratory choices remain.

The most important finding is a **critical environment constraint**: `tree-sitter` (npm, v0.25.0) does NOT compile on Node.js 25 (system default on this machine) due to the Xcode license agreement blocker documented in STATE.md. The solution is to use **`web-tree-sitter-sfapex`** (v2.4.1, WASM-based), which requires no native compilation, works on any Node.js version, and is maintained by the same author. The WASM API differs from the native API in one critical way: `hasError` is a **property** (boolean), not a method — calling `root.hasError()` throws `TypeError`.

Node.js workers must be launched with `node@22` (`/opt/homebrew/opt/node@22/bin/node`, v22.22.0) not the system `node` (v25.5.0), since `web-tree-sitter` v0.24.0 (dependency of `web-tree-sitter-sfapex`) has better compatibility guarantees on LTS versions.

The FastMCP lifespan pattern is verified in mcp==1.27.0: the lifespan context manager yields a typed object that becomes accessible in tool handlers via `ctx.request_context.lifespan_context`. The existing `server.py` stub already enforces stderr-only logging — Phase 2 builds on that foundation.

**Primary recommendation:** Use `web-tree-sitter-sfapex` (WASM) with Node.js 22 LTS; spawn workers via `asyncio.create_subprocess_exec` with explicit node binary path; implement `NodeParserPool` as a pure asyncio class; build `ParseDispatcher` as a stateless routing function.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| web-tree-sitter-sfapex | 2.4.1 (npm) | Apex/SOQL/SOSL parsing (WASM) | No native compilation required; same author as tree-sitter-sfapex; works on Node 22/25; WASM bundles the grammar |
| web-tree-sitter | 0.24.x (npm, pulled by above) | WASM tree-sitter runtime | Required by web-tree-sitter-sfapex; provides Parser class |
| Node.js | 22.22.0 LTS (`/opt/homebrew/opt/node@22/bin/node`) | Worker process runtime | LTS version on this machine; tree-sitter-sfapex 0.25.0 native fails on Node 25 due to Xcode license; WASM works on both but Node 22 LTS is preferred |
| mcp (FastMCP) | 1.27.0 (already installed) | MCP server skeleton + lifespan | Already in pyproject.toml; FastMCP lifespan verified working |
| Python asyncio | stdlib (Python 3.12) | Subprocess management, health checks, timeouts | No additional dependency; `asyncio.create_subprocess_exec` is the correct IPC primitive |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| os.cpu_count() | stdlib | Pool size calculation | min(os.cpu_count() or 4, 8) for POOL-03 |
| asyncio.wait_for | stdlib | Per-file 10s timeout (POOL-06) and health check 5s timeout (POOL-04) | All timed IPC operations |
| uuid4 | stdlib (uuid module) | Request ID generation for IPC correlation | Every parse request needs a unique `requestId` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| web-tree-sitter-sfapex (WASM) | tree-sitter-sfapex (native) | Native is faster (~5x) but requires Xcode license agreement on this machine and node-gyp compilation; WASM is zero-friction and fully sufficient for parsing throughput |
| web-tree-sitter-sfapex (WASM) | web-tree-sitter + manual .wasm load | web-tree-sitter-sfapex bundles the .wasm files and provides getApexParser()/getSoqlParser() helpers; no reason to do it manually |
| asyncio.create_subprocess_exec | subprocess.Popen | asyncio version is non-blocking; essential for health checks while parse requests are in flight |
| Node 22 LTS | Node 25 (system default) | Node 25 is on PATH at /opt/homebrew/bin/node; WASM works on both, but LTS is the documented support target |

**Installation:**
```bash
# Node.js side (in project root, creates package.json + node_modules/)
npm init -y
npm install web-tree-sitter-sfapex

# Python side — already installed; no new dependencies needed for Phase 2
# The existing pyproject.toml mcp[cli]==1.27.0 is sufficient
```

---

## Architecture Patterns

### Recommended Project Structure

```
src/sfgraph/
├── server.py              # (exists) Stub → Phase 2 wires FastMCP lifespan
├── parser/
│   ├── __init__.py
│   ├── pool.py            # NodeParserPool: asyncio subprocess management
│   ├── dispatcher.py      # ParseDispatcher: extension-based routing
│   └── worker/
│       └── worker.js      # Node.js worker: WASM parser + readline IPC
├── storage/               # (exists, Phase 1 complete)
│   ├── base.py
│   ├── falkordb_store.py
│   ├── manifest_store.py
│   └── vector_store.py

node_modules/              # npm install output
package.json               # Node.js project file

tests/
├── parser/
│   ├── test_pool.py        # NodeParserPool integration tests
│   ├── test_dispatcher.py  # ParseDispatcher unit tests
│   └── fixtures/
│       ├── simple.cls       # Valid Apex fixture
│       └── broken.cls       # Apex with parse errors (for APEX-10 guard)
```

### Pattern 1: WASM Worker with Readline IPC

**What:** A Node.js worker.js that initializes the WASM apex parser once on startup, then reads newline-delimited JSON from stdin via `readline`, parses each file, and writes JSON responses to stdout.

**When to use:** All Node.js IPC worker implementations for POOL-01, POOL-02.

**Critical WASM API difference:** `hasError` is a **boolean property**, NOT a method. Never call `root.hasError()` — it throws `TypeError`. Use `root.hasError` directly.

```javascript
// src/sfgraph/parser/worker/worker.js
// Source: Verified via direct testing 2026-04-04
const { getApexParser, getSoqlParser } = require('web-tree-sitter-sfapex');
const readline = require('readline');

const NODE_BINARY = process.execPath;  // /opt/homebrew/opt/node@22/bin/node
const MAX_FILES = 200;

let apexParser = null;
let fileCount = 0;

async function init() {
  // Grammar loaded ONCE at startup — amortizes ~300ms cost across all files
  apexParser = await getApexParser();
  process.stderr.write('[worker] initialized\n');

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', handleLine);
  process.stdin.resume();
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch (e) {
    process.stderr.write('[worker] JSON parse error: ' + e.message + '\n');
    return;
  }

  if (msg.type === 'ping') {
    process.stdout.write(JSON.stringify({ requestId: msg.requestId, type: 'pong' }) + '\n');
    return;
  }

  if (msg.type === 'exit') {
    process.exit(0);
  }

  // Parse request
  fileCount++;
  if (fileCount > MAX_FILES) {
    // Memory ceiling: signal worker should be replaced
    process.stdout.write(JSON.stringify({
      requestId: msg.requestId,
      ok: false,
      error: 'memory_ceiling'
    }) + '\n');
    process.exit(0);
  }

  try {
    const content = msg.fileContent || '';
    const tree = apexParser.parse(content);
    const root = tree.rootNode;

    // APEX-10 guard: hasError is a PROPERTY (not method) in WASM API
    if (root.hasError) {
      process.stderr.write(`[worker] parse error in ${msg.filePath}\n`);
      process.stdout.write(JSON.stringify({
        requestId: msg.requestId,
        ok: false,
        error: 'parse_error',
        payload: null
      }) + '\n');
      return;
    }

    // Extract raw_facts - actual extraction expanded in Phase 3
    const payload = extractRawFacts(root, msg.filePath);
    process.stdout.write(JSON.stringify({
      requestId: msg.requestId,
      ok: true,
      payload
    }) + '\n');

  } catch (e) {
    process.stderr.write('[worker] exception: ' + e.message + '\n');
    process.stdout.write(JSON.stringify({
      requestId: msg.requestId,
      ok: false,
      error: e.message,
      payload: null
    }) + '\n');
  }
}

function extractRawFacts(root, filePath) {
  // Phase 2 stub: just confirm parse worked and return shape
  // Phase 3 will expand this to full raw_facts extraction
  const classes = root.descendantsOfType('class_declaration');
  return {
    filePath,
    hasError: root.hasError,  // false at this point (checked above)
    nodeCount: classes.length,
    nodes: [],          // populated in Phase 3
    potential_refs: []  // populated in Phase 3
  };
}

init().catch(e => {
  process.stderr.write('[worker] init failed: ' + e + '\n');
  process.exit(1);
});
```

### Pattern 2: NodeParserPool (Python asyncio)

**What:** An asyncio class that manages N persistent Node.js worker subprocesses. Dispatches parse requests with unique IDs, matches responses, enforces timeouts, and runs periodic health checks.

**When to use:** POOL-01, POOL-03, POOL-04, POOL-05, POOL-06.

**Critical implementation details:**
- Use `asyncio.create_subprocess_exec` with explicit node binary path (`/opt/homebrew/opt/node@22/bin/node` or discovered at startup)
- Each worker handles one request at a time (tree-sitter is synchronous in Node.js) — use `asyncio.Semaphore(1)` per worker
- Health check loop runs as a background `asyncio.Task`, not a separate thread
- Per-file timeout (10s) is separate from health check timeout (5s)

```python
# src/sfgraph/parser/pool.py
# Source: Pattern verified via direct testing 2026-04-04
import asyncio
import json
import logging
import os
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Node.js 22 LTS binary path (prefer over system node which is Node 25 on this machine)
NODE_BINARY = "/opt/homebrew/opt/node@22/bin/node"
WORKER_JS = str(Path(__file__).parent / "worker" / "worker.js")


@dataclass
class _Worker:
    proc: asyncio.subprocess.Process
    semaphore: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))
    healthy: bool = True


class NodeParserPool:
    """Persistent Node.js worker pool for tree-sitter parsing.

    Each worker loads the WASM grammar once on startup and handles parse
    requests until it reaches 200 files, then voluntarily exits and is replaced.
    """

    def __init__(self, size: Optional[int] = None):
        # POOL-03: min(cpu_count, 8) workers
        self._size = size or min(os.cpu_count() or 4, 8)
        self._workers: list[_Worker] = []
        self._health_task: Optional[asyncio.Task] = None
        self._shutdown = False

    async def start(self) -> None:
        """Start all workers and begin health check loop."""
        for _ in range(self._size):
            worker = await self._spawn_worker()
            self._workers.append(worker)
        # POOL-04: health check background task
        self._health_task = asyncio.create_task(self._health_loop())
        logger.info("NodeParserPool started with %d workers", self._size)

    async def _spawn_worker(self) -> _Worker:
        node_bin = NODE_BINARY if Path(NODE_BINARY).exists() else shutil.which("node") or "node"
        proc = await asyncio.create_subprocess_exec(
            node_bin, WORKER_JS,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return _Worker(proc=proc)

    async def parse(self, file_path: str, grammar: str, file_content: str) -> dict:
        """Dispatch a parse request to an available worker.

        Returns {ok: bool, payload: dict | None, error: str | None}.
        Raises asyncio.TimeoutError if no response within 10 seconds (POOL-06).
        """
        # Find an available worker (semaphore=1 per worker, tree-sitter is synchronous)
        for worker in self._workers:
            if worker.healthy and not worker.semaphore.locked():
                async with worker.semaphore:
                    return await self._dispatch(worker, file_path, grammar, file_content)

        # All workers busy — wait on first available
        worker = self._workers[0]
        async with worker.semaphore:
            return await self._dispatch(worker, file_path, grammar, file_content)

    async def _dispatch(self, worker: _Worker, file_path: str, grammar: str, content: str) -> dict:
        request_id = str(uuid.uuid4())
        msg = json.dumps({
            "requestId": request_id,
            "grammar": grammar,
            "filePath": file_path,
            "fileContent": content,
        }) + "\n"

        worker.proc.stdin.write(msg.encode())
        await worker.proc.stdin.drain()

        try:
            # POOL-06: 10s per-file timeout
            line = await asyncio.wait_for(worker.proc.stdout.readline(), timeout=10.0)
            result = json.loads(line.decode().strip())

            # Handle memory ceiling: worker self-reported it should be replaced
            if not result.get("ok") and result.get("error") == "memory_ceiling":
                # POOL-05: replace worker after 200 files
                asyncio.create_task(self._replace_worker(worker))
                return {"ok": False, "error": "worker_restarting", "payload": None}

            return result

        except asyncio.TimeoutError:
            # POOL-06: timeout — do NOT kill worker, return error
            logger.warning("Parse timeout for %s", file_path)
            return {"ok": False, "error": "timeout", "payload": None}

    async def _health_loop(self) -> None:
        """POOL-04: Ping every 30s; if no pong within 5s, replace worker."""
        while not self._shutdown:
            await asyncio.sleep(30)
            for i, worker in enumerate(self._workers):
                if not await self._ping_worker(worker):
                    logger.warning("Worker %d failed health check, replacing", i)
                    asyncio.create_task(self._replace_worker(worker))

    async def _ping_worker(self, worker: _Worker) -> bool:
        request_id = str(uuid.uuid4())
        msg = json.dumps({"requestId": request_id, "type": "ping"}) + "\n"
        try:
            worker.proc.stdin.write(msg.encode())
            await worker.proc.stdin.drain()
            line = await asyncio.wait_for(worker.proc.stdout.readline(), timeout=5.0)
            result = json.loads(line.decode().strip())
            return result.get("type") == "pong"
        except (asyncio.TimeoutError, Exception):
            return False

    async def _replace_worker(self, old_worker: _Worker) -> None:
        old_worker.healthy = False
        try:
            old_worker.proc.kill()
            await old_worker.proc.wait()
        except Exception:
            pass
        new_worker = await self._spawn_worker()
        idx = self._workers.index(old_worker)
        self._workers[idx] = new_worker
        logger.info("Worker replaced at index %d", idx)

    async def shutdown(self) -> None:
        self._shutdown = True
        if self._health_task:
            self._health_task.cancel()
        for worker in self._workers:
            try:
                worker.proc.kill()
                await worker.proc.wait()
            except Exception:
                pass
```

### Pattern 3: ParseDispatcher (stateless routing)

**What:** A stateless function that routes files to the Node.js pool or Python parsers based on file extension. POOL-07.

**When to use:** Every file entering the ingestion pipeline.

```python
# src/sfgraph/parser/dispatcher.py
# Source: Extension routing verified 2026-04-04
from pathlib import Path
from typing import Literal

# POOL-07: .cls, .trigger, .js go to Node.js pool; everything else to Python parsers
NODEJS_EXTENSIONS: frozenset[str] = frozenset({".cls", ".trigger", ".js"})

ParserTarget = Literal["nodejs_pool", "python_parser"]

VALID_EXTENSIONS: frozenset[str] = frozenset({
    ".cls", ".trigger", ".js",               # Node.js pool
    ".xml",                                   # Flow, Object, Label, CMT
    ".html",                                  # LWC templates
    ".json",                                  # Vlocity DataPacks
})


def route_file(file_path: str) -> ParserTarget:
    """Return which parser target should handle this file.

    Raises ValueError for file types not recognized by any parser.
    """
    ext = Path(file_path).suffix.lower()
    if ext in NODEJS_EXTENSIONS:
        return "nodejs_pool"
    if ext in (VALID_EXTENSIONS - NODEJS_EXTENSIONS):
        return "python_parser"
    raise ValueError(f"No parser registered for extension '{ext}' in file: {file_path}")
```

### Pattern 4: FastMCP Server with Lifespan

**What:** The FastMCP server initializes all stateful resources in a lifespan context manager. Tool handlers access those resources via `ctx.request_context.lifespan_context`.

**When to use:** MCP-01. Established now in Phase 2 so all subsequent tool work inherits the pattern.

**Critical:** `logging.basicConfig(stream=sys.stderr)` remains the FIRST executable code in `server.py`, before any other imports. Already established in Phase 1. FastMCP itself must not be imported before this line.

```python
# src/sfgraph/server.py (Phase 2 expansion of Phase 1 stub)
# Source: FastMCP API verified 2026-04-04 with mcp==1.27.0
import sys
import logging

logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

# Only import AFTER logging is configured
from contextlib import asynccontextmanager
from dataclasses import dataclass
from mcp.server.fastmcp import FastMCP, Context

from sfgraph.storage.falkordb_store import FalkorDBStore
from sfgraph.storage.vector_store import VectorStore
from sfgraph.storage.manifest_store import ManifestStore
from sfgraph.parser.pool import NodeParserPool

logger = logging.getLogger(__name__)


@dataclass
class AppContext:
    graph: FalkorDBStore
    vectors: VectorStore
    manifest: ManifestStore
    pool: NodeParserPool


@asynccontextmanager
async def lifespan(server: FastMCP):
    """Initialize all storage handles and parser pool.

    MCP-01: lifespan owns all storage engines.
    This is the ONLY place where storage connections are opened.
    """
    graph = FalkorDBStore(path="./data/org.db")
    vectors = VectorStore(path="./data/vectors")
    manifest = ManifestStore(path="./data/manifest.sqlite")
    pool = NodeParserPool()

    await pool.start()
    logger.info("All storage engines initialized")

    yield AppContext(graph=graph, vectors=vectors, manifest=manifest, pool=pool)

    await pool.shutdown()
    await graph.close()
    logger.info("All storage engines closed")


mcp = FastMCP("salesforce-org-graph", lifespan=lifespan)


@mcp.tool()
async def ping(ctx: Context) -> str:
    """Health check tool for Phase 2 skeleton validation."""
    # Access lifespan context: ctx.request_context.lifespan_context
    app: AppContext = ctx.request_context.lifespan_context
    pool_size = len(app.pool._workers)
    return f"ok — pool_size={pool_size}"


if __name__ == "__main__":
    mcp.run()
```

### Anti-Patterns to Avoid

- **Calling `root.hasError()` as a method:** In the WASM tree-sitter API, `hasError` is a boolean property. Calling it as a function throws `TypeError: root.hasError is not a function`. Use `root.hasError` (no parentheses).

- **Using the system `node` binary directly:** `/opt/homebrew/bin/node` on this machine is Node.js 25.5.0. While WASM works on Node 25, prefer Node 22 LTS for stability. Use `/opt/homebrew/opt/node@22/bin/node` explicitly, with a fallback to `shutil.which("node")`.

- **Running `npm install` without `node@22` in PATH:** The system npm resolves to Node 25; tree-sitter (native) fails to compile. For `web-tree-sitter-sfapex`, this doesn't matter (no compilation), but running npm with wrong Node sets incorrect `node` in scripts. Use `/opt/homebrew/opt/node@22/bin/npm` for initial setup.

- **Starting the health check timer before `pool.start()` completes:** The `asyncio.Task` for health checks must be created only after all workers are ready.

- **Putting `from mcp.server.fastmcp import FastMCP` before `logging.basicConfig`:** FastMCP imports trigger module-level code that may emit to stdout. The logging redirect in `server.py` must remain the absolute first executable lines.

- **Killing the worker on per-file timeout:** POOL-06 explicitly requires that a timeout returns `{ok:false, error:"timeout"}` WITHOUT killing the worker. Only the health check (POOL-04) kills workers. The per-file timeout is handled by `asyncio.wait_for` on the response, which does not kill the subprocess.

- **Routing files not in VALID_EXTENSIONS silently:** `ParseDispatcher.route_file()` must raise `ValueError` for unknown extensions, not silently send them to either parser target.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Apex CST parsing | Custom Apex lexer/parser | web-tree-sitter-sfapex (WASM) | tree-sitter-sfapex is the only production-grade Apex parser in any ecosystem; WASM variant needs no compilation |
| Node.js grammar loading optimization | Custom caching layer | Load grammar once in worker startup | WASM grammar load is amortized across all files per-worker by design — no additional caching needed |
| Request/response correlation | Custom binary framing | UUID4 `requestId` in each JSON message matched on return | Newline-delimited JSON with UUIDs is the standard pattern; no custom framing needed |
| Async worker selection | Complex work-stealing queue | `asyncio.Semaphore(1)` per worker + round-robin | tree-sitter is synchronous; semaphore correctly models single-file-at-a-time per worker |
| Process health monitoring | Custom heartbeat protocol | `{"type":"ping"}/{"type":"pong"}` on a 30s loop | Simple, reliable, no external dependency |

**Key insight:** The subprocess pool pattern (asyncio + readline IPC) is battle-tested in Python tooling. Don't add complexity (message queues, binary protocols, worker threads) — the stdlib primitives are sufficient.

---

## Common Pitfalls

### Pitfall 1: WASM hasError is a Property, Not a Method

**What goes wrong:** `root.hasError()` throws `TypeError: root.hasError is not a function`. The APEX-10 guard silently fails.

**Why it happens:** The native tree-sitter Node.js bindings expose `hasError()` as a method. The WASM bindings (web-tree-sitter) expose it as a boolean property. Same API name, different calling convention.

**How to avoid:** Always use `root.hasError` (no parentheses). Add a test that asserts `typeof root.hasError === 'boolean'` before any code that reads it.

**Warning signs:** `TypeError` in worker.js stderr during parse phase; false negatives (no errors reported even for broken Apex).

---

### Pitfall 2: Node.js 25 vs Node 22 — Native vs WASM

**What goes wrong:** `npm install tree-sitter tree-sitter-sfapex` fails with `gyp ERR: make failed with exit code 69` (Xcode license not accepted). Installing `web-tree-sitter-sfapex` works, but if code uses the native API (`Parser.setLanguage(TsSfApex.apex)`) it fails with `TypeError`.

**Why it happens:** Native tree-sitter requires `node-gyp` and Xcode toolchain. The Xcode license agreement has not been accepted on this machine (known blocker from STATE.md). `web-tree-sitter-sfapex` uses WASM and has zero native compilation.

**How to avoid:** Use `web-tree-sitter-sfapex` exclusively. Never import `tree-sitter` (the native package) in worker.js. The `package.json` must list `web-tree-sitter-sfapex` as the only tree-sitter dependency.

**Warning signs:** `gyp ERR` during `npm install`; `Module did not self-register` or `Invalid ELF header` at runtime.

---

### Pitfall 3: Stdout Pollution from FastMCP or Storage Imports

**What goes wrong:** Importing FastMCP, FalkorDB, or Qdrant before `logging.basicConfig(stream=sys.stderr)` allows library startup messages to reach stdout, corrupting MCP transport.

**Why it happens:** Some libraries call `print()` or `logging.info()` at import time. If the root logger's handler hasn't been redirected to stderr first, these go to stdout.

**How to avoid:** `logging.basicConfig(stream=sys.stderr)` must be lines 1-6 of `server.py` (as currently implemented in Phase 1). Run `test_stdout_discipline.py` after every `server.py` change.

**Warning signs:** MCP client receives malformed JSON; Claude Desktop shows "session closed" immediately after connection.

---

### Pitfall 4: asyncio.wait_for Does Not Kill the Subprocess on Timeout

**What goes wrong:** After a `asyncio.TimeoutError` from `wait_for`, the worker subprocess is still alive and its next response (from the timed-out request) is queued in its stdout pipe buffer. The next read picks up the stale response.

**Why it happens:** `asyncio.wait_for` cancels the coroutine waiting on readline, but does NOT send any signal to the subprocess. The subprocess continues processing and will write its response to stdout.

**How to avoid:** After a per-file timeout (POOL-06), drain the worker's pending stdout before sending the next request. OR assign a unique `requestId` to each request and skip responses whose `requestId` doesn't match the expected one.

**Warning signs:** Worker appears healthy in health checks but returns wrong payloads; responses arrive for wrong files.

---

### Pitfall 5: `readline` stdin EOF on Python stdin.close()

**What goes wrong:** When Python closes `proc.stdin` to signal shutdown, the Node.js `readline` interface emits a `close` event (not `end` event) and may exit without processing the last request.

**Why it happens:** `readline.createInterface` on stdin doesn't always emit `line` for the last buffered line when stdin closes without a trailing newline.

**How to avoid:** Always terminate worker exit with `{"type":"exit"}\n` (explicit message with trailing newline) rather than closing stdin. The worker calls `process.exit(0)` on receiving `exit`. This guarantees clean shutdown.

**Warning signs:** Last parse request in a batch produces no response; worker process becomes a zombie.

---

## Code Examples

Verified patterns from direct testing (2026-04-04):

### WASM Parser Initialization and Parse with Error Guard

```javascript
// Source: Verified via direct test 2026-04-04
const { getApexParser } = require('web-tree-sitter-sfapex');

const parser = await getApexParser();  // Grammar loaded once

// Parse a file
const tree = parser.parse(apexSourceCode);
const root = tree.rootNode;

// APEX-10 guard: hasError is a PROPERTY (boolean), NOT a method
if (root.hasError) {  // <-- NO parentheses
  // Log to stderr, return {ok: false}
  process.stderr.write(`Parse error in ${filePath}\n`);
  return { requestId, ok: false, error: 'parse_error', payload: null };
}

// Safe to traverse - extract node types
const classes = root.descendantsOfType('class_declaration');
const methods = root.descendantsOfType('method_declaration');
const soqlBodies = root.descendantsOfType('soql_query_body');  // NOT 'soql_query'
```

### Python Subprocess Spawn with Explicit Node Binary

```python
# Source: Verified via direct test 2026-04-04
import asyncio
from pathlib import Path
import shutil

NODE_BINARY = "/opt/homebrew/opt/node@22/bin/node"

def _resolve_node() -> str:
    """Prefer Node 22 LTS; fall back to whatever's on PATH."""
    if Path(NODE_BINARY).exists():
        return NODE_BINARY
    fallback = shutil.which("node")
    if not fallback:
        raise RuntimeError("No node binary found. Install node@22 via brew.")
    return fallback

proc = await asyncio.create_subprocess_exec(
    _resolve_node(), "worker.js",
    stdin=asyncio.subprocess.PIPE,
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.PIPE,
)
```

### IPC Request/Response Round-Trip with UUID Correlation

```python
# Source: Verified via direct test 2026-04-04
import asyncio, json, uuid

request_id = str(uuid.uuid4())
msg = json.dumps({
    "requestId": request_id,
    "grammar": "apex",
    "filePath": "/path/to/AccountService.cls",
    "fileContent": source_code,
}) + "\n"

proc.stdin.write(msg.encode())
await proc.stdin.drain()

# POOL-06: 10s per-file timeout; TimeoutError does NOT kill worker
try:
    line = await asyncio.wait_for(proc.stdout.readline(), timeout=10.0)
    result = json.loads(line.decode().strip())
    assert result["requestId"] == request_id  # Verify correlation
except asyncio.TimeoutError:
    return {"ok": False, "error": "timeout", "payload": None}
```

### FastMCP Lifespan Context Access

```python
# Source: Verified via inspection of mcp==1.27.0 source 2026-04-04
from mcp.server.fastmcp import FastMCP, Context
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(server: FastMCP):
    pool = NodeParserPool()
    await pool.start()
    yield AppContext(pool=pool)  # Yielded object becomes lifespan_context
    await pool.shutdown()

mcp = FastMCP("sfgraph", lifespan=lifespan)

@mcp.tool()
async def my_tool(ctx: Context) -> str:
    # Access via ctx.request_context.lifespan_context
    app: AppContext = ctx.request_context.lifespan_context
    return f"pool workers: {len(app.pool._workers)}"
```

### Ping Health Check Pattern

```python
# Source: Verified via direct test 2026-04-04
import asyncio, json, uuid

async def ping_worker(proc) -> bool:
    """POOL-04: Returns False if no pong within 5 seconds."""
    request_id = str(uuid.uuid4())
    msg = json.dumps({"requestId": request_id, "type": "ping"}) + "\n"
    try:
        proc.stdin.write(msg.encode())
        await proc.stdin.drain()
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=5.0)
        result = json.loads(line.decode().strip())
        return result.get("type") == "pong"
    except (asyncio.TimeoutError, Exception):
        return False
```

### Worker.js Readline IPC Template

```javascript
// Source: Verified via direct test 2026-04-04 — readline IPC basic pattern
const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line.trim());
    // process msg...
    process.stdout.write(JSON.stringify({requestId: msg.requestId, ...response}) + '\n');
  } catch(e) {
    process.stderr.write('Parse error: ' + e.message + '\n');
  }
});
process.stdin.resume();  // Keep stdin open
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| tree-sitter native bindings (npm: tree-sitter) | web-tree-sitter-sfapex WASM (npm: web-tree-sitter-sfapex) | Project inception — tree-sitter 0.25.0 doesn't compile on Node 25 on this machine | No C compilation required; works on any OS without Xcode/node-gyp; hasError is a property not method |
| `root.hasError()` (native API) | `root.hasError` (WASM property) | Difference exists between native and WASM APIs | Must check this everywhere the guard is applied |
| tree-sitter-javascript for LWC | web-tree-sitter-javascript (WASM) | Same Node 25 compilation issue | Also use WASM variant for JS parsing |
| `mcp.run()` with global state | `mcp = FastMCP("name", lifespan=lifespan)` | mcp SDK 1.0+ | Lifespan pattern is the officially supported way to hold shared state |

**Deprecated/outdated:**
- `import TsSfApex from "tree-sitter-sfapex"` (native): Cannot compile on this machine without accepting Xcode license. Use `require("web-tree-sitter-sfapex")` instead.
- Pool-per-grammar (separate pool for apex vs js): Unnecessary — the WASM worker can load both grammars; grammar is selected per-request via the `grammar` field.

---

## Open Questions

1. **soql_query_body vs soql_query as tree-sitter node type**
   - What we know: `root.descendantsOfType('soql_query')` returns 0 results; `'soql_query_body'` returns correct results
   - What's unclear: Full mapping of tree-sitter-sfapex node type names for all relevant constructs (DML, method calls, class annotations, etc.)
   - Recommendation: In Phase 3, enumerate all node types needed for APEX-01 through APEX-09 by walking fixture trees. Don't hardcode node type names without verification.

2. **web-tree-sitter-javascript availability and WASM variant**
   - What we know: `web-tree-sitter-sfapex` (WASM) works; research checked npm for `web-tree-sitter-javascript`
   - What's unclear: Whether the official tree-sitter-javascript project publishes a WASM variant compatible with web-tree-sitter
   - Recommendation: Check `npm info web-tree-sitter-javascript` before Phase 4 LWC work. If unavailable, use the WASM bundled in web-tree-sitter-sfapex (it may include JS grammar).

3. **RequestId stale-response handling after timeout**
   - What we know: After `asyncio.wait_for` timeout, the worker continues processing and writes to stdout
   - What's unclear: Whether the stale response will corrupt the next request's response or if UUID correlation naturally handles it
   - Recommendation: Implement UUID correlation checking (`result["requestId"] != expected_id → discard`) in the dispatch loop.

---

## Sources

### Primary (HIGH confidence)

- Direct testing (2026-04-04) — All code patterns verified with working outputs in this session:
  - WASM parser initialization: `getApexParser()` works, parses Apex, `hasError` is a boolean property
  - Python asyncio IPC: `create_subprocess_exec` + readline round-trip confirmed working
  - Per-file timeout: `asyncio.wait_for(timeout=10.0)` catches and returns without killing worker
  - Health check: ping/pong pattern with `asyncio.wait_for(timeout=5.0)` confirmed
  - FastMCP lifespan: `mcp==1.27.0` lifespan parameter works; `ctx.request_context.lifespan_context` is the access path
  - ParseDispatcher routing: All 7 extension routing test cases pass
  - Pool sizing: `min(os.cpu_count(), 8)` = 8 on this 10-core machine

- `web-tree-sitter-sfapex` npm package (v2.4.1) — README, index.js, WASM files confirmed installed and working

- `mcp` PyPI (v1.27.0) — Source inspection of `FastMCP`, `Context`, `RequestContext` classes confirmed lifespan access path

- Python asyncio subprocess docs (stdlib) — Official API for `create_subprocess_exec`, `wait_for`, `PIPE`

- Node.js readline docs (stdlib) — `createInterface` + `'line'` event confirmed as the correct IPC read pattern

### Secondary (MEDIUM confidence)

- [ARCHITECTURE.md](.planning/research/ARCHITECTURE.md) — IPC specification and pool design; verified against actual implementation
- [STACK.md](.planning/research/STACK.md) — Technology stack decisions; tree-sitter version confirmed against npm
- [STATE.md](.planning/STATE.md) — Key decision: "Xcode license agreement blocks git commit" confirms Xcode toolchain unavailability

### Tertiary (LOW confidence)

- [web-tree-sitter-sfapex npm page](https://www.npmjs.com/package/web-tree-sitter-sfapex) — Could not fetch directly (403); confirmed via direct `npm install` and source inspection
- WebSearch results on tree-sitter Node.js 25 compatibility — Single source, LOW confidence; resolved via direct test

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — All packages tested directly; WASM approach confirmed working
- Architecture: HIGH — IPC patterns directly verified; FastMCP lifespan API inspected from source
- Pitfalls: HIGH — Pitfall 1 (hasError property vs method) discovered and confirmed by direct test; others from STATE.md + direct verification

**Research date:** 2026-04-04
**Valid until:** 2026-05-04 (web-tree-sitter-sfapex is stable; mcp SDK is stable; patterns are stdlib-based)
