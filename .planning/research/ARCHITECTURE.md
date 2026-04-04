# Architecture Patterns

**Domain:** Local static analysis + graph store + multi-agent MCP query tool
**Researched:** 2026-04-03
**Overall confidence:** HIGH (design locked at v6.1; research validates component boundaries and IPC patterns)

---

## Recommended Architecture

The tool is a single Python process (the MCP server) that owns three storage engines and delegates one parsing concern to a Node.js subprocess pool. All components are embedded — nothing requires Docker or a network port except the optional MCP HTTP transport.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MCP Server Process (Python)                        │
│                                                                             │
│  ┌───────────────┐   ┌─────────────────────────────────────────────────┐   │
│  │  FastMCP      │   │              Service Layer                      │   │
│  │  Tool Layer   │──▶│  IngestionService  │  QueryService  │  Status  │   │
│  │               │   └────────────────────────────────────────────────┘   │
│  └───────────────┘             │                    │                       │
│                                ▼                    ▼                       │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         Storage Layer                               │  │
│  │   FalkorDBLite (subprocess+Unix socket)  │  Qdrant (in-proc/file)  │  │
│  │   SQLite Manifest (stdlib sqlite3)                                  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                │                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                       Ingestion Pipeline                            │  │
│  │  FileScanner → ParseDispatcher → [Python parsers / Node.js pool]   │  │
│  │              → RawFactsCollector → NodeWriter → EdgeWriter          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                │                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         Query Pipeline                              │  │
│  │  Agent 1: SchemaFilter (Haiku)                                      │  │
│  │  Agent 2: QueryGenerator (Sonnet) + CypherCorrector (iterative)    │  │
│  │  Agent 3: ResultFormatter (Sonnet, structured output contract)      │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
         │
         │  stdin/stdout JSON-L (newline-delimited)
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Node.js Parser Pool Process(es)                        │
│  WorkerPool (workerpool npm)  →  tree-sitter-sfapex  (Apex / .trigger)    │
│                               →  tree-sitter-javascript (LWC .js)         │
│  HealthCheck loop  │  200-file memory ceiling  │  Replay-on-crash mode     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Boundaries

| Component | Responsibility | Owns | Communicates With |
|-----------|---------------|------|-------------------|
| **FastMCP Tool Layer** | Expose MCP tools; validate inputs; return structured results | None (stateless handlers) | ServiceLayer via lifespan context |
| **IngestionService** | Orchestrate full and incremental ingest runs | Run-state only | ParseDispatcher, NodeWriter, EdgeWriter, ManifestStore |
| **QueryService** | Run three-agent pipeline; execute Cypher; format results | None (stateless per-request) | FalkorDBStore, SchemaIndex, LLM clients |
| **StatusService** | Track ingest progress, expose get_ingestion_status | SQLite via ManifestStore | IngestionService |
| **FileScanner** | Walk metadata directory tree; SHA-256 delta against manifest | Filesystem | ManifestStore |
| **ParseDispatcher** | Route files to correct parser by extension/type; collect raw_facts | None | PythonParsers, NodeParserPool |
| **PythonParsers** | Parse XML (Flow, Object, Label, Vlocity), LWC HTML (lxml) | None (pure functions) | ParseDispatcher |
| **NodeParserPool** | Manage async subprocess pool of Node.js workers; health checks | N async subprocesses | ParseDispatcher (caller), Node.js processes (workers) |
| **Node.js worker (pool entry)** | Load tree-sitter grammars once; parse Apex/JS files; return raw_facts JSON | In-process grammar cache | NodeParserPool (via stdin/stdout) |
| **NodeWriter** | Write node batch to FalkorDB; upsert via MERGE | None | FalkorDBStore |
| **EdgeWriter** | Run all matchers against raw_facts; write edges | None | FalkorDBStore, ManifestStore |
| **SchemaIndex** | Curated subset of graph schema for Agent 1 context injection | SQLite or in-memory | QueryService |
| **GraphStore Protocol** | ABC abstracting FalkorDB Cypher operations | None (interface) | NodeWriter, EdgeWriter, QueryService |
| **FalkorDBStore** | Concrete GraphStore backed by FalkorDBLite | FalkorDBLite subprocess | NodeWriter, EdgeWriter, QueryService |
| **VectorStore** | Qdrant local file-backed collection | Qdrant client (in-proc) | IngestionService (index), QueryService (search) |
| **ManifestStore** | SQLite file tracking: path, sha256, ingest_status, last_ingested_at | sqlite3 file | FileScanner, EdgeWriter, StatusService |

---

## Data Flow

### Ingestion Flow

```
Metadata directory on disk
    │
    ▼
FileScanner
    ├── Read existing ManifestStore (SQLite)
    ├── Walk directory tree, compute SHA-256 per file
    └── Emit: {new_files[], changed_files[], unchanged_files[]}
         │
         ▼
ParseDispatcher
    ├── .cls / .trigger  ──────────▶ NodeParserPool (Node.js IPC)
    ├── .js (LWC)        ──────────▶ NodeParserPool (Node.js IPC)
    ├── .html (LWC)      ──────────▶ PythonParser: lxml
    ├── *-meta.xml (Flow)─────────▶ PythonParser: ElementTree
    ├── *__c.object-meta.xml ──────▶ PythonParser: ElementTree
    ├── Vlocity JSON     ──────────▶ PythonParser: json
    └── Label/CMT XML    ──────────▶ PythonParser: ElementTree
         │
         ▼ raw_facts: List[dict]  (one dict per source entity)
         │
    ┌────┴────────────────────────────────────────────────────────────────┐
    │                    Two-Phase Graph Write                            │
    │                                                                     │
    │  Phase 1 — NodeWriter                                               │
    │    MERGE each node into FalkorDB by (label, qualifiedName)         │
    │    Write source attribution: sourceFile, lineNumber, parserType    │
    │    Update ManifestStore: file status = NODES_WRITTEN               │
    │                                                                     │
    │  Phase 2 — EdgeWriter (runs after ALL files in NodeWriter)         │
    │    Run relationship matchers against raw_facts                      │
    │    Resolve references by MATCH on existing nodes                   │
    │    Attach: confidence, resolutionMethod, edgeCategory, snippet     │
    │    Update ManifestStore: file status = EDGES_WRITTEN               │
    └────────────────────────────────────────────────────────────────────┘
         │
         ▼
    VectorStore (Qdrant)
    Chunk source code per node, embed, upsert collection
         │
         ▼
    SchemaIndex rebuild (post-ingest hook)
    Materializes node-label counts + relationship-type catalogue into SQLite
```

### Query Flow

```
MCP client natural language question
    │
    ▼
Agent 1 — SchemaFilter (Haiku)
    Input:  question + SchemaIndex summary (lightweight, ~500 tokens)
    Output: relevant_node_labels[], relevant_rel_types[], query_intent
    Purpose: Cuts full schema 20-40x before injecting into Agent 2
         │
         ▼
Agent 2 — QueryGenerator (Sonnet)
    Input:  question + filtered schema slice + Agent 1 output
    Output: Cypher query string
    ┌──── CypherCorrector loop (max 4 iterations) ────────────────────┐
    │  Execute query against FalkorDB                                  │
    │  On error: feed error message back to Sonnet, re-generate       │
    │  On success: break                                               │
    └────────────────────────────────────────────────────────────────┘
         │
         ▼  raw graph results (nodes, edges, properties)
         │
Agent 3 — ResultFormatter (Sonnet, structured output contract)
    Input:  question + raw results + confidence metadata
    Output: {
        mode: "TRAVERSE" | "ANSWER",
        confidence_tier: "Definite" | "Probable" | "Review manually",
        answer: string,
        supporting_nodes: [],
        trace_limit_hit: bool
    }
    Note: TRAVERSE_LIMIT_HIT signals code complexity, not tool weakness
         │
         ▼
MCP tool response (structured JSON → LLM client renders)
```

### Node.js IPC Flow

```
Python NodeParserPool
    │
    │  asyncio.create_subprocess_exec("node", "worker.js")
    │  stdin: PIPE, stdout: PIPE
    ▼
For each file batch (up to 200 files per process):
    Python writes: {"id": "uuid", "file": "/path/to/Foo.cls", "content": "..."}\n
    Node.js reads line, parses with tree-sitter, writes back:
                  {"id": "uuid", "raw_facts": {...}, "error": null}\n
    Python reads response line, matches by id, resolves future

Health check:
    Python sends: {"id": "hc-1", "cmd": "ping"}\n
    Node.js responds: {"id": "hc-1", "pong": true}\n
    If no response in 5s → kill, restart, re-queue pending

Memory ceiling:
    Node.js worker tracks file count; after 200 files → sends {"cmd": "exit"}
    Python starts a fresh worker process
```

---

## Patterns to Follow

### Pattern 1: GraphStore Abstraction Protocol

**What:** Define an ABC (Abstract Base Class) for all graph operations before writing any FalkorDB-specific code.

**When:** Before NodeWriter or EdgeWriter are implemented.

**Why:** Enables FalkorDB→DuckPGQ swap with zero changes to ingestion/query logic. ~2 day cost, major future flexibility.

```python
from abc import ABC, abstractmethod
from typing import Any

class GraphStore(ABC):
    @abstractmethod
    async def merge_node(self, label: str, key_props: dict, all_props: dict) -> str: ...

    @abstractmethod
    async def merge_edge(self, src_id: str, rel_type: str, dst_id: str, props: dict) -> None: ...

    @abstractmethod
    async def query(self, cypher: str, params: dict | None = None) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def schema_summary(self) -> dict: ...
```

### Pattern 2: FastMCP Lifespan for Shared Resources

**What:** Initialize all stateful resources (FalkorDB connection, Qdrant client, SQLite connection, Node.js pool) in the FastMCP lifespan context manager. Inject into tool handlers via typed context.

**When:** Server startup before any tool handler is called.

```python
from contextlib import asynccontextmanager
from fastmcp import FastMCP, Context

@asynccontextmanager
async def lifespan(server: FastMCP):
    graph = FalkorDBStore(path="./data/org.db")
    vectors = VectorStore(path="./data/vectors")
    manifest = ManifestStore(path="./data/manifest.sqlite")
    pool = NodeParserPool(workers=4)
    await pool.start()
    yield AppContext(graph=graph, vectors=vectors, manifest=manifest, pool=pool)
    await pool.shutdown()
    await graph.close()

mcp = FastMCP("salesforce-org-analyzer", lifespan=lifespan)
```

### Pattern 3: Newline-Delimited JSON for Node.js IPC

**What:** Each IPC message is a single JSON object terminated by `\n`. No framing protocol needed because JSON does not contain bare newlines.

**When:** All communication between Python NodeParserPool and Node.js workers.

**Why:** asyncio readline() is the natural consumer; JSON has no embedded newlines; stdlib json handles both sides.

```python
# Python sender
async def send_parse_request(proc, request_id: str, file_path: str, content: str):
    msg = json.dumps({"id": request_id, "file": file_path, "content": content})
    proc.stdin.write((msg + "\n").encode())
    await proc.stdin.drain()

# Python receiver
async def read_response(proc) -> dict:
    line = await asyncio.wait_for(proc.stdout.readline(), timeout=30.0)
    return json.loads(line.decode())
```

### Pattern 4: Two-Phase Ingestion (Nodes-First)

**What:** Complete all node writes for the entire corpus before starting any edge-writing pass. Edge matchers can always MATCH on existing nodes.

**When:** Every full and incremental ingest run.

**Why:** Eliminates forward-reference ordering problems entirely. A Flow that calls an Apex class defined later in the alphabet still resolves correctly.

```
Phase 1: for each dirty_file in manifest → parse → MERGE node(s) into FalkorDB
Phase 2: for each dirty_file in manifest → run matchers → MERGE edge(s) into FalkorDB
Phase 3: post-ingest → rebuild SchemaIndex → update Qdrant → stamp manifest
```

### Pattern 5: Incremental Refresh via SHA-256 Manifest

**What:** SQLite table `files(path TEXT PK, sha256 TEXT, status TEXT, last_ingested_at REAL)`. FileScanner computes SHA-256 for each file on disk, compares against manifest, and only passes delta to ParseDispatcher.

**When:** All refresh calls after the initial ingest.

```python
# status values: PENDING | NODES_WRITTEN | EDGES_WRITTEN | FAILED
# Only files with sha256 != stored sha256 (or status != EDGES_WRITTEN) enter the pipeline
```

### Pattern 6: Structured Output Contract for Agent 3

**What:** Agent 3 (ResultFormatter) must return a JSON object conforming to a Pydantic model. The MCP tool handler validates the model before returning to the client. Never let free-form prose reach the MCP boundary.

**When:** All query tool responses.

```python
class QueryResponse(BaseModel):
    mode: Literal["TRAVERSE", "ANSWER"]
    confidence_tier: Literal["Definite", "Probable", "Review manually"]
    answer: str
    supporting_nodes: list[NodeRef]
    trace_limit_hit: bool
    cypher_used: str
```

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Importing falkordb-py directly in tool handlers

**What:** Tool handler functions call FalkorDB directly rather than going through GraphStore protocol.

**Why bad:** Binds the entire tool layer to FalkorDB API surface. A DuckPGQ fallback or test mock requires rewriting all tool handlers.

**Instead:** Tool handlers call `QueryService.run(question)`. QueryService owns all graph access. Tool handlers are stateless.

### Anti-Pattern 2: Single-phase ingestion (nodes + edges in one pass)

**What:** Parse a file, write its nodes, immediately try to write edges pointing to other files' nodes.

**Why bad:** If `ClassA` calls `ClassB` and ClassB hasn't been parsed yet, the MATCH for ClassB's node fails. Workarounds (retry queues, deferred edge writes) recreate two-phase manually but worse.

**Instead:** Enforce the nodes-first / edges-second discipline at the IngestionService orchestration level.

### Anti-Pattern 3: Synchronous Node.js subprocess per file

**What:** For each .cls file, `subprocess.run(["node", "parse.js", file])` — one process per file.

**Why bad:** Grammar load time (~200ms) dominates parse time (~5ms). 2000 .cls files = 400 seconds of grammar loading alone.

**Instead:** Node.js worker pool — grammar loaded once per worker process, amortized across hundreds of files per worker lifetime.

### Anti-Pattern 4: Full schema injection into Agent 2

**What:** Dump the entire graph schema (all node labels, all relationship types, all properties) into the Query Generator's context.

**Why bad:** A large Salesforce org schema is ~3000 tokens. Multiply by every query call. Schema Filter (Agent 1, Haiku) reduces this 20-40x to ~100-150 tokens of relevant schema.

**Instead:** Always run Agent 1 first to produce a filtered schema slice; only that slice goes into Agent 2's context.

### Anti-Pattern 5: MCP tool handler blocking on long-running ingest

**What:** `ingest_org` tool runs synchronously in the tool handler coroutine.

**Why bad:** Blocks the MCP server event loop. Any other tool call during ingest (e.g. `get_ingestion_status`) is starved.

**Instead:** `ingest_org` tool handler spawns an asyncio Task for the ingest run, returns immediately with a `run_id`. Status is polled via `get_ingestion_status(run_id)`.

---

## Component Boundaries: What Talks to What

```
MCP Tool Layer
    │  reads/writes via
    ▼
Service Layer (IngestionService, QueryService, StatusService)
    │  reads/writes via
    ├──▶ GraphStore (FalkorDBStore)
    ├──▶ VectorStore (Qdrant local)
    ├──▶ ManifestStore (SQLite)
    └──▶ ParseDispatcher
              │  delegates to
              ├──▶ PythonParsers (in-process)
              └──▶ NodeParserPool
                        │  IPC over stdin/stdout JSON-L
                        └──▶ Node.js worker process(es)
```

Nothing in the MCP Tool Layer touches storage directly.
Nothing in the Node.js layer touches storage at all.
ParseDispatcher does not know about FalkorDB.
GraphStore protocol does not know about parsing.

---

## Suggested Build Order (Critical Path)

The critical path is: storage foundations → ingestion plumbing → one working parser → graph write → MCP transport → remaining parsers → query pipeline → polish.

### Phase 1 — Foundations (unblocks everything)

1. **ManifestStore** (SQLite schema, CRUD) — unblocks FileScanner and incremental refresh
2. **GraphStore Protocol** (ABC only, no implementation) — unblocks NodeWriter / EdgeWriter implementations
3. **FalkorDBStore** (concrete implementation of GraphStore) — unblocks all graph writes
4. **VectorStore** (Qdrant local init, basic upsert/search) — can run in parallel after foundations

Rationale: Every subsequent component either writes to or reads from these stores. Build them first and test them in isolation before any pipeline work.

### Phase 2 — Node.js Parser Pool (longest integration risk)

5. **Node.js worker script** (tree-sitter-sfapex grammar load + single-file parse → raw_facts JSON) — standalone Node.js unit test first
6. **NodeParserPool** (Python asyncio subprocess management, health checks, memory ceiling) — integration tested against the Node.js worker
7. **ParseDispatcher** (routing logic only, stubs for all parsers except Node.js) — enables end-to-end parse→raw_facts path for Apex files

Rationale: The Python↔Node.js IPC boundary is the highest integration risk in the system. Prove it works early with Apex files before building any Python parsers.

### Phase 3 — Ingestion Pipeline Core

8. **NodeWriter** (raw_facts → MERGE nodes into FalkorDB, source attribution)
9. **EdgeWriter** (relationship matchers → MERGE edges, confidence/snippet)
10. **IngestionService** (orchestrate Phase 1/2 graph write, async Task pattern)
11. **FileScanner** (SHA-256 delta, manifest update)
12. **Incremental refresh** (wire FileScanner → IngestionService for dirty-only re-ingest)

Rationale: Two-phase write (NodeWriter before EdgeWriter) is enforced at this layer. NodeWriter must be complete before EdgeWriter can be tested.

### Phase 4 — Python Parsers

13. **Flow XML parser** (ElementTree → raw_facts)
14. **Object/Field XML parser** (SFObject, SFField, formula fields, picklist, global value sets)
15. **LWC HTML parser** (lxml → child components, field bindings)
16. **LWC JS parser** (tree-sitter-javascript → wire + imperative Apex calls, via Node.js pool)
17. **Vlocity DataPack parsers** (IP, OmniScript, DataRaptor JSON → raw_facts)
18. **Custom Label / Custom Setting / CMT / Platform Event parsers**

Rationale: All parsers are independent of each other. They can be built and tested in parallel once ParseDispatcher exists. Flow and Object parsers first because they cover the most common metadata types.

### Phase 5 — MCP Server Transport

19. **FastMCP server bootstrap** (lifespan context, all shared resources)
20. **Tool: ingest_org** (triggers IngestionService async Task, returns run_id)
21. **Tool: get_ingestion_status** (polls ManifestStore for run progress)
22. **Tool: query** (entry point for three-agent pipeline, returns QueryResponse)
23. **Tool: get_node** (single-node lookup by qualifiedName)
24. **Tool: explain_field** (specialized shortcut: field → all dependent edges)
25. **Tool: refresh** (incremental re-ingest for dirty files)

Rationale: MCP transport should be wired up as soon as ingest_org works end-to-end for Apex files. This gives a usable tool for manual testing while Python parsers are completed.

### Phase 6 — Query Pipeline

26. **SchemaIndex** (post-ingest materialization of node/rel catalogue into SQLite)
27. **Agent 1: SchemaFilter** (Haiku, filtered schema slice from SchemaIndex)
28. **Agent 2: QueryGenerator** (Sonnet, Cypher generation + CypherCorrector loop)
29. **Agent 3: ResultFormatter** (Sonnet, structured output contract, confidence tiers)
30. **Variable Origin Tracer** (depth=5, cost=50, cycle detection)

Rationale: Query pipeline requires a populated graph to test against. Build it after at least one full ingest (Apex + Flows + Objects) works end-to-end.

### Phase 7 — Hardening and OSS Readiness

31. **Dynamic Accessor Registry** (YAML config, org-specific utility method mapping)
32. **Formula field parser** (validation rules, workflow updates, approval criteria)
33. **File watcher** (watchdog, 2s debounce → incremental refresh trigger)
34. **Node.js pool hardening** (replay mode, production health checks)
35. **PyPI packaging** (pyproject.toml, uv build, CLI entrypoint)
36. **OSS docs** (README, contributor guide, schema reference)

---

## Testing Strategy Per Component

| Component | Test Type | Approach |
|-----------|-----------|----------|
| ManifestStore | Unit | In-memory SQLite; test CRUD, SHA-256 delta, status transitions |
| GraphStore Protocol | Unit | Mock implementation; verify ABC contract |
| FalkorDBStore | Integration | Temporary FalkorDBLite file; test MERGE node/edge, query round-trips |
| Node.js worker (parse.js) | Unit (Jest) | Fixture .cls files; assert raw_facts shape, node count, edge count |
| NodeParserPool | Integration | Spin real Node.js workers; test health check, memory ceiling, crash recovery |
| ParseDispatcher | Unit | Mock NodeParserPool + Python parsers; test routing by file extension |
| PythonParsers (each) | Unit | XML/JSON fixture files; assert raw_facts node labels and properties |
| NodeWriter | Integration | Real FalkorDBStore (temp file); verify MERGE idempotency |
| EdgeWriter | Integration | Pre-seeded FalkorDB with nodes; verify edge confidence scores, snippets |
| IngestionService | Integration | Full pipeline against synthetic fixture corpus (20-30 files) |
| FileScanner | Unit | Temp directory with known SHA-256 values; test delta detection |
| SchemaIndex | Integration | Post-ingest on fixture corpus; verify label/rel counts |
| QueryService (Agent pipeline) | Unit + Integration | Unit: mock LLM clients, assert CypherCorrector loop logic. Integration: real LLM calls against fixture graph (slow, gated) |
| MCP Tool handlers | Unit | Mock ServiceLayer; test input validation, error responses, async Task dispatch |
| End-to-end | E2E | Full ingest of synthetic corpus → MCP query → assert structured response |

**Key principle:** Every parser has a fixture file. Fixtures live in `tests/fixtures/` organized by parser type. Integration tests use ephemeral FalkorDBLite files (temp directory, cleaned up after each test).

---

## Python to Node.js IPC: Technical Specification

**Transport:** stdin/stdout pipe (not Unix socket, not HTTP — simpler, no port management)

**Framing:** Newline-delimited JSON (JSON-L). Each message is one UTF-8 JSON line. Python uses `asyncio.create_subprocess_exec` with `stdin=PIPE, stdout=PIPE`.

**Request schema (Python → Node.js):**
```json
{"id": "uuid4", "file": "/abs/path/to/Foo.cls", "content": "..source.."}
```
Special commands:
```json
{"id": "uuid4", "cmd": "ping"}
{"id": "uuid4", "cmd": "exit"}
```

**Response schema (Node.js → Python):**
```json
{
  "id": "uuid4",
  "raw_facts": {
    "nodes": [...],
    "potential_refs": [...]
  },
  "error": null
}
```
On error:
```json
{"id": "uuid4", "raw_facts": null, "error": "SyntaxError: ..."}
```

**Pool management (Python side):**
- Pool size: configurable, default 4 workers (one per vCPU)
- Each worker: persistent process, handles up to 200 files then graceful exit + replacement
- Health check: `ping` every 10s; if no `pong` in 5s → SIGKILL + restart + re-queue
- Backpressure: asyncio semaphore limits in-flight requests per worker to 1 (tree-sitter is synchronous in Node.js)
- Startup: `node worker.js --grammar apex` — grammar loaded once at process start

**Node.js worker internals:**
- Grammar cache: loaded on startup, never reloaded (amortizes ~200ms grammar init across all files)
- Line reading: `readline` module on `process.stdin`, one message per line
- Error isolation: parse errors caught per-file, returned in error field, process continues

**Confidence:** HIGH — this IPC pattern is the established approach for Python↔Node.js interop. Python asyncio subprocess documentation, newline-delimited JSON, and readline-based Node.js readers are all battle-tested primitives.

---

## Scalability Considerations

| Concern | At 500 files | At 5K files | At 20K files |
|---------|-------------|-------------|--------------|
| Parse throughput | 4 Node.js workers sufficient | 4–8 workers, 200-file ceiling per worker | Tune pool size, consider batching file content |
| FalkorDB ingest | Single-threaded MERGE, fast enough | Two-phase batching (1000 nodes/tx) | Batch size tuning, parallel EdgeWriter shards |
| Query latency | FalkorDB < 10ms for 3-hop | Indexing on qualifiedName critical | SchemaIndex cache; precomputed traversal cache (v1.5) |
| Qdrant indexing | In-memory fine | File-backed, FastEmbed CPU batch | Consider GPU-backed embedding for initial ingest |
| SQLite manifest | Trivial | Trivial | WAL mode, single writer, reads unblocked |

---

## Sources

- [FalkorDBLite: Embedded Python Graph Database](https://www.falkordb.com/blog/falkordblite-embedded-python-graph-database/) — Process model, Unix socket IPC, zero-config architecture. Confidence: HIGH (official FalkorDB docs)
- [FalkorDBLite GitHub](https://github.com/FalkorDB/falkordblite) — API compatibility, async API, multiple graph support. Confidence: HIGH
- [MCP Python SDK Lifespan Management](https://deepwiki.com/modelcontextprotocol/python-sdk/2.5-context-injection-and-lifespan) — AsyncContextManager lifespan pattern for shared resources. Confidence: HIGH
- [FastMCP Dependencies](https://gofastmcp.com/python-sdk/fastmcp-server-dependencies) — Dependency injection, Context injection. Confidence: HIGH
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/) — Single responsibility, async tool handlers, circuit breakers. Confidence: HIGH
- [Multi-Agent GraphRAG: Text-to-Cypher Framework](https://arxiv.org/pdf/2511.08274) — Agent roles, schema filter → query generator → validator pipeline. Confidence: HIGH (peer-reviewed)
- [Graph-Based Code Analysis Engine Architecture](https://rustic-ai.github.io/codeprism/blog/graph-based-code-analysis-engine/) — Layered parser→AST→graph→index→query architecture. Confidence: MEDIUM
- [Python asyncio subprocess documentation](https://docs.python.org/3/library/asyncio-subprocess.html) — Subprocess IPC, readline, PIPE, avoid deadlocks. Confidence: HIGH (official Python docs)
- [Node.js Child Process Documentation](https://nodejs.org/api/child_process.html) — IPC channel limitations for non-Node child processes. Confidence: HIGH (official Node.js docs)
- [Qdrant local embedded mode](https://qdrant.tech/blog/qdrant-edge/) — File-backed local Qdrant, no server dependency. Confidence: HIGH (official Qdrant)
- [CodeFuse-Query static analysis architecture](https://arxiv.org/html/2401.01571v1) — Four-layer static analysis architecture pattern. Confidence: MEDIUM
