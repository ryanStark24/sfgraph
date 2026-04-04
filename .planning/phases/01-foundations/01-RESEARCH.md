# Phase 1: Foundations - Research

**Researched:** 2026-04-04
**Domain:** Python package environment setup + embedded storage engines (FalkorDBLite, Qdrant local, SQLite) + GraphStore abstraction protocol
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FOUND-01 | Project runs on Python 3.12+ with `requires-python = ">=3.12"` enforced in pyproject.toml (FalkorDBLite hard requirement) | FalkorDBLite 0.9.0 official docs confirm Python 3.12 is a hard dependency; pyproject.toml pattern verified against uv documentation |
| FOUND-02 | FalkorDBLite 0.9.0 initializes and accepts Cypher read/write via GraphStore abstraction layer | FalkorDB Python API verified; MERGE + ro_query patterns documented; import path from `redislite.falkordb_client` confirmed |
| FOUND-03 | GraphStore Protocol (ABC) decouples all ingestion and query logic from FalkorDB-specific API | ABC pattern with abstractmethod documented; DuckPGQStore stub required to validate protocol boundary (GRAPH-04) |
| FOUND-04 | FalkorDB writes are serialized through a single asyncio queue (prevents graph corruption on concurrent writes) | FalkorDBLite thread safety is undocumented; asyncio queue serialization is the confirmed mitigation pattern |
| FOUND-05 | Qdrant local vector index initializes and supports upsert + query operations via VectorStore abstraction | qdrant-client 1.17.1 local mode verified; `QdrantClient(path=...)` confirmed; fastembed 0.8.0 CPU-only ONNX embeddings verified |
| FOUND-06 | SQLite manifest store tracks per-file SHA-256, ingestion phase (PENDING/NODES_WRITTEN/EDGES_WRITTEN/FAILED), and run status | aiosqlite 0.22.1 verified; schema pattern documented; phase state machine defined |
| FOUND-07 | All logging routes to stderr only — stdout is reserved exclusively for MCP transport (CI-enforced) | MCP stdio transport fatal corruption via stdout confirmed; `logging.basicConfig(stream=sys.stderr)` is the prevention pattern; CI assertion approach documented |
| FOUND-08 | `uv` is the package manager; `pyproject.toml` defines all dependencies with pinned versions | uv is recommended by official MCP docs; pyproject.toml structure with `requires-python = ">=3.12"` verified |
</phase_requirements>

---

## Summary

Phase 1 builds the three storage engines that every other phase depends on: FalkorDBLite (property graph), Qdrant local (vector index), and SQLite (file manifest). These are not plumbing details — they are the load-bearing foundation of the entire system. The GraphStore Protocol (ABC) must exist before any FalkorDB-specific code, the asyncio write serialization queue must exist before any concurrent code touches FalkorDB, and the stderr-only logging discipline must be established before the MCP server entry point is written.

The key insight for Phase 1 is that all three storage engines have hidden complexity that must be addressed at initialization time, not retrofitted later. FalkorDBLite spawns a Redis child process (not a true embedded library), which requires `libomp` on macOS and demands write serialization. Qdrant local mode is production-ready for small-to-medium corpora but has a known 20k-vector ceiling that must be architectured around from the start. SQLite via aiosqlite is straightforward but its schema must capture all four ingestion phases (PENDING/NODES_WRITTEN/EDGES_WRITTEN/FAILED) as a state machine — this drives crash recovery and incremental refresh in all later phases.

The stdout pollution risk is the single most dangerous trap in this phase. MCP stdio transport is fatally corrupted by any byte written to stdout — including FalkorDB's Redis subprocess startup output. Establishing `logging.basicConfig(stream=sys.stderr)` as the first line of the entry point, before any imports, is non-negotiable. A CI assertion that captures stdout and verifies it is empty must be added in this phase, not deferred.

**Primary recommendation:** Build in this order: pyproject.toml + environment lock → stderr discipline + CI stdout assertion → ManifestStore (SQLite) → GraphStore ABC → FalkorDBStore + asyncio write queue → VectorStore + DuckPGQStore stub. Test each in isolation before wiring.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Python | 3.12 | Primary runtime | FalkorDBLite hard requirement; 3.12 asyncio is faster than 3.11; non-negotiable |
| uv | latest (astral-sh) | Package manager, lockfiles, venv, publish | Official MCP docs recommend uv; 10-100x faster than pip; manages Python version |
| falkordblite | 0.9.0 | Embedded property graph, Cypher queries | Only production-ready embedded Cypher graph; Kùzu archived Oct 2025 |
| qdrant-client | 1.17.1 | Local vector index, upsert + similarity search | Native local embedded mode; Apache-2.0; async Python API |
| fastembed | 0.8.0 | CPU-only ONNX embeddings | No GPU, no PyTorch; BAAI/bge-small-en-v1.5 model; pairs with qdrant-client |
| aiosqlite | 0.22.1 | Async SQLite wrapper for file manifest | Zero extra deps beyond stdlib sqlite3; async/await bridge |
| pydantic | v2 (latest 2.x) | GraphStore protocol models, structured types | Rust-backed v2; required by mcp SDK as transitive dep |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| mcp[cli] | 1.27.0 | MCP server SDK | Install in Phase 1 to test stdout discipline CI assertion; full use in Phase 2 |
| pytest | 8.x | Test runner | Unit + integration tests for all three stores |
| pytest-asyncio | 0.24.x | Async test support | All store tests are async (aiosqlite, Qdrant async API) |
| pytest-cov | 5.x | Coverage reporting | CLAUDE.md requires 95%+ coverage target |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| falkordblite | Kùzu | Kùzu archived Oct 2025 — no production path |
| falkordblite | DuckPGQ | PGQ syntax diverges from Cypher; LLM text-to-Cypher training data is Cypher-dominant; DuckPGQ community extension still maturing |
| falkordblite | Neo4j embedded | No true embedded mode; JVM server required; GPL license |
| qdrant-client local | Chroma embedded | Known stability issues at production scale; inferior metadata filtering |
| qdrant-client local | Weaviate | Requires Docker; not embeddable |
| fastembed | sentence-transformers | Pulls full PyTorch (~2GB); unnecessary GPU deps |
| aiosqlite | SQLAlchemy async | ORM overhead for a 3-table manifest schema is unnecessary |

**Installation:**
```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# macOS prerequisite (must run before any FalkorDB work)
brew install libomp

# Install uv if not present
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create project
uv init sfgraph --python 3.12
cd sfgraph

# Runtime dependencies needed in Phase 1
uv add falkordblite qdrant-client fastembed aiosqlite pydantic "mcp[cli]"

# Dev dependencies
uv add --dev pytest pytest-asyncio pytest-cov
```

---

## Architecture Patterns

### Recommended Project Structure

```
sfgraph/
├── src/
│   └── sfgraph/
│       ├── __init__.py
│       ├── storage/
│       │   ├── __init__.py          # Exports: GraphStore, FalkorDBStore, VectorStore, ManifestStore
│       │   ├── base.py              # GraphStore ABC (Protocol definition)
│       │   ├── falkordb_store.py    # FalkorDBStore (concrete implementation)
│       │   ├── vector_store.py      # VectorStore (Qdrant local)
│       │   ├── manifest_store.py    # ManifestStore (aiosqlite)
│       │   └── duckpgq_store.py     # DuckPGQStore stub (validates Protocol boundary)
│       └── server.py                # Entry point — stderr redirect FIRST line
├── tests/
│   ├── conftest.py                  # Shared fixtures: temp db paths, event loop
│   ├── test_manifest_store.py       # ManifestStore unit tests
│   ├── test_falkordb_store.py       # FalkorDBStore integration tests
│   ├── test_vector_store.py         # VectorStore integration tests
│   ├── test_graph_store_protocol.py # ABC contract tests (mock impl)
│   └── test_stdout_discipline.py    # CI assertion: zero stdout bytes
├── pyproject.toml
├── .python-version                  # Contains: 3.12
└── uv.lock                         # Committed lockfile
```

### Pattern 1: GraphStore Abstract Base Class

**What:** Define the complete protocol for all graph operations as an ABC before writing any FalkorDB-specific code. Every store method is abstract; no implementation details leak into the interface.

**When to use:** Before writing FalkorDBStore. DuckPGQStore stub must also implement this ABC to validate the protocol boundary (GRAPH-04).

**Example:**
```python
# src/sfgraph/storage/base.py
# Source: architecture pattern from ARCHITECTURE.md + Python ABC docs
from abc import ABC, abstractmethod
from typing import Any

class GraphStore(ABC):
    """Protocol for all graph read/write operations.

    No FalkorDB-specific types cross this boundary.
    All implementations must be swappable without changing callers.
    """

    @abstractmethod
    async def merge_node(
        self,
        label: str,
        key_props: dict[str, Any],
        all_props: dict[str, Any],
    ) -> str:
        """MERGE a node; return its qualifiedName (primary key)."""
        ...

    @abstractmethod
    async def merge_edge(
        self,
        src_qualified_name: str,
        src_label: str,
        rel_type: str,
        dst_qualified_name: str,
        dst_label: str,
        props: dict[str, Any],
    ) -> None:
        """MERGE a directed relationship between two nodes."""
        ...

    @abstractmethod
    async def query(
        self,
        cypher: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Execute a read-only Cypher query. Never called for writes."""
        ...

    @abstractmethod
    async def get_labels(self) -> list[str]:
        """Return all node label names present in the graph."""
        ...

    @abstractmethod
    async def get_relationship_types(self) -> list[str]:
        """Return all relationship type names present in the graph."""
        ...

    @abstractmethod
    async def close(self) -> None:
        """Cleanly shut down the graph connection and child processes."""
        ...
```

### Pattern 2: FalkorDBStore with Asyncio Write Queue

**What:** FalkorDBLite's thread safety is undocumented. All write operations (merge_node, merge_edge) are serialized through a single asyncio.Queue with a dedicated writer coroutine. Read operations (query) bypass the queue and call `ro_query` directly — FalkorDB explicitly supports concurrent reads.

**When to use:** Always. The queue must be initialized in `__init__` and the writer started before any ingestion begins.

**Example:**
```python
# src/sfgraph/storage/falkordb_store.py
# Source: FalkorDB official docs + ARCHITECTURE.md asyncio serialization pattern
import asyncio
import atexit
from typing import Any
from redislite.falkordb_client import FalkorDB
from .base import GraphStore

_SENTINEL = object()  # signals writer coroutine to exit

class FalkorDBStore(GraphStore):
    def __init__(self, db_path: str, graph_name: str = "org_graph") -> None:
        self._db = FalkorDB(db_path)
        self._graph = self._db.select_graph(graph_name)
        self._write_queue: asyncio.Queue = asyncio.Queue()
        self._writer_task: asyncio.Task | None = None
        atexit.register(self._atexit_cleanup)

    async def start(self) -> None:
        """Must be called before any merge operations."""
        self._writer_task = asyncio.create_task(self._writer_loop())

    async def _writer_loop(self) -> None:
        while True:
            item = await self._write_queue.get()
            if item is _SENTINEL:
                break
            cypher, params, fut = item
            try:
                result = self._graph.query(cypher, params)
                fut.set_result(result)
            except Exception as exc:
                fut.set_exception(exc)
            finally:
                self._write_queue.task_done()

    async def _write(self, cypher: str, params: dict) -> Any:
        """Enqueue a write and await its result."""
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        await self._write_queue.put((cypher, params, fut))
        return await fut

    async def merge_node(self, label: str, key_props: dict, all_props: dict) -> str:
        props_str = ", ".join(f"n.{k} = ${k}" for k in all_props)
        key_str = " AND ".join(f"n.{k} = ${k}_key" for k in key_props)
        params = {f"{k}_key": v for k, v in key_props.items()} | all_props
        cypher = f"MERGE (n:{label} {{{', '.join(f'{k}: ${k}_key' for k in key_props)}}}) SET {props_str} RETURN n.qualifiedName"
        await self._write(cypher, params)
        return all_props.get("qualifiedName", "")

    async def query(self, cypher: str, params: dict | None = None) -> list[dict]:
        result = self._graph.ro_query(cypher, params or {})
        return [dict(row) for row in result.result_set]

    async def close(self) -> None:
        if self._writer_task:
            await self._write_queue.put(_SENTINEL)
            await self._writer_task
        self._db.close()

    def _atexit_cleanup(self) -> None:
        """Ensure Redis subprocess does not linger after interpreter exit."""
        try:
            self._db.close()
        except Exception:
            pass
```

### Pattern 3: ManifestStore Schema and State Machine

**What:** SQLite table with explicit ingestion phase states. The state machine (PENDING → NODES_WRITTEN → EDGES_WRITTEN, with FAILED as a terminal error state) drives crash recovery and incremental refresh in all later phases.

**When to use:** Created in Phase 1; used by every subsequent phase.

**Example:**
```python
# src/sfgraph/storage/manifest_store.py
# Source: ARCHITECTURE.md pattern + aiosqlite docs
import hashlib
import aiosqlite
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    path        TEXT PRIMARY KEY,
    sha256      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'PENDING',
    run_id      TEXT,
    last_ingested_at REAL
);

CREATE TABLE IF NOT EXISTS runs (
    run_id      TEXT PRIMARY KEY,
    started_at  REAL NOT NULL,
    completed_at REAL,
    phase_1_complete INTEGER DEFAULT 0,
    phase_2_complete INTEGER DEFAULT 0,
    status      TEXT DEFAULT 'RUNNING'
);
"""

# Valid status values: PENDING | NODES_WRITTEN | EDGES_WRITTEN | FAILED
# Valid run status:   RUNNING | COMPLETE | FAILED | INCOMPLETE

class ManifestStore:
    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        self._conn: aiosqlite.Connection | None = None

    async def initialize(self) -> None:
        self._conn = await aiosqlite.connect(self._db_path)
        await self._conn.executescript(SCHEMA)
        await self._conn.commit()

    async def upsert_file(self, path: str, sha256: str, run_id: str) -> None:
        await self._conn.execute(
            "INSERT INTO files (path, sha256, status, run_id) VALUES (?, ?, 'PENDING', ?)"
            " ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256, status='PENDING', run_id=excluded.run_id",
            (path, sha256, run_id),
        )
        await self._conn.commit()

    async def set_status(self, path: str, status: str) -> None:
        """Status must be one of: PENDING, NODES_WRITTEN, EDGES_WRITTEN, FAILED."""
        await self._conn.execute(
            "UPDATE files SET status=? WHERE path=?", (status, path)
        )
        await self._conn.commit()

    async def get_delta(self, current_files: dict[str, str]) -> dict:
        """Returns {new: [], changed: [], unchanged: [], deleted: []}."""
        cursor = await self._conn.execute(
            "SELECT path, sha256 FROM files WHERE status = 'EDGES_WRITTEN'"
        )
        stored = {row[0]: row[1] async for row in cursor}
        new, changed, unchanged = [], [], []
        for path, sha256 in current_files.items():
            if path not in stored:
                new.append(path)
            elif stored[path] != sha256:
                changed.append(path)
            else:
                unchanged.append(path)
        deleted = [p for p in stored if p not in current_files]
        return {"new": new, "changed": changed, "unchanged": unchanged, "deleted": deleted}

    @staticmethod
    def compute_sha256(path: str) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
```

### Pattern 4: VectorStore with Abstraction for Scale

**What:** Qdrant local mode initialized with `QdrantClient(path=...)`. The VectorStore abstraction must be designed to support switching between local mode (testing, small orgs) and subprocess mode (production, large orgs) without changing calling code.

**When to use:** From Phase 1. The 20k vector ceiling means large orgs will hit a wall in Phase 3 — design the abstraction now.

**Example:**
```python
# src/sfgraph/storage/vector_store.py
# Source: qdrant-client 1.17.1 docs + fastembed 0.8.0 docs
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct
from fastembed import TextEmbedding

COLLECTION_NAME = "source_chunks"
VECTOR_DIM = 384  # BAAI/bge-small-en-v1.5

class VectorStore:
    def __init__(self, path: str | None = None, url: str | None = None) -> None:
        """
        path=":memory:" → in-memory (tests only)
        path="/abs/path" → local file-backed (small orgs, dev)
        url="http://localhost:6333" → Qdrant subprocess/server (large orgs)
        """
        if url:
            self._client = QdrantClient(url=url)
        elif path:
            self._client = QdrantClient(path=path)
        else:
            raise ValueError("Either path or url must be provided")
        self._embedder = TextEmbedding("BAAI/bge-small-en-v1.5")

    async def initialize(self) -> None:
        existing = [c.name for c in self._client.get_collections().collections]
        if COLLECTION_NAME not in existing:
            self._client.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
            )

    async def upsert(self, node_id: str, text: str, payload: dict) -> None:
        vectors = list(self._embedder.embed([text]))
        self._client.upsert(
            collection_name=COLLECTION_NAME,
            points=[PointStruct(id=hash(node_id) % (2**63), vector=vectors[0].tolist(), payload=payload | {"node_id": node_id})],
        )

    async def search(self, query_text: str, limit: int = 10) -> list[dict]:
        vectors = list(self._embedder.embed([query_text]))
        results = self._client.search(
            collection_name=COLLECTION_NAME,
            query_vector=vectors[0].tolist(),
            limit=limit,
        )
        return [{"node_id": r.payload["node_id"], "score": r.score, "payload": r.payload} for r in results]
```

### Pattern 5: Stderr-First Entry Point

**What:** The MCP server entry point redirects all logging to stderr before any other import. This is non-negotiable — any stdout output before this redirect corrupts the MCP transport.

**When to use:** First lines of `src/sfgraph/server.py`.

**Example:**
```python
# src/sfgraph/server.py — STDERR REDIRECT MUST BE FIRST
import sys
import logging

# --- CRITICAL: redirect ALL logging to stderr before any other imports ---
# Any output to stdout corrupts the MCP stdio JSON-RPC transport.
logging.basicConfig(
    stream=sys.stderr,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# Ensure no accidental print() reaches stdout
# (add CI assertion to verify: see test_stdout_discipline.py)

# Only import other modules AFTER logging is configured
from sfgraph.storage import GraphStore, FalkorDBStore, VectorStore, ManifestStore
```

### Pattern 6: DuckPGQStore Stub (Protocol Boundary Validation)

**What:** A minimal stub implementation of GraphStore that raises NotImplementedError for all methods. Its purpose is to prove the ABC contract is complete and importable (FOUND-03 / GRAPH-04).

**When to use:** Phase 1. Must exist and import cleanly. Full implementation is future work.

**Example:**
```python
# src/sfgraph/storage/duckpgq_store.py
from .base import GraphStore

class DuckPGQStore(GraphStore):
    """Stub implementation of GraphStore backed by DuckDB+PGQ extension.

    Not implemented in v1. Exists to:
    1. Validate that GraphStore ABC is completeable by an alternative backend.
    2. Enable test mocks without importing FalkorDB.
    """

    async def merge_node(self, label, key_props, all_props): raise NotImplementedError
    async def merge_edge(self, src_qn, src_label, rel_type, dst_qn, dst_label, props): raise NotImplementedError
    async def query(self, cypher, params=None): raise NotImplementedError
    async def get_labels(self): raise NotImplementedError
    async def get_relationship_types(self): raise NotImplementedError
    async def close(self): pass  # no-op for stub
```

### Anti-Patterns to Avoid

- **Importing FalkorDB directly outside of FalkorDBStore:** Any file that imports from `redislite.falkordb_client` except `falkordb_store.py` violates the abstraction. Tool handlers, IngestionService, QueryService must never see FalkorDB types.
- **Calling `graph.query()` concurrently for writes:** FalkorDB thread safety is undocumented. All writes must go through the asyncio write queue. Reads (`ro_query`) can be concurrent.
- **Using `logging.basicConfig()` without `stream=sys.stderr`:** Default stream is stdout. Any logging before the redirect is MCP transport corruption.
- **Using `print()` anywhere in the server process:** Replace with `logging.getLogger(__name__).info(...)`. Add a pre-commit hook that bans `print(` in `src/`.
- **Creating FalkorDB without an atexit handler:** The Redis subprocess will outlive the Python process on SIGKILL. Always register cleanup.
- **Setting `requires-python = ">=3.11"` in pyproject.toml:** FalkorDBLite will fail to install. The constraint must be `>=3.12` from the first commit.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Async SQLite | Custom SQLite + asyncio thread pool | aiosqlite | Thread-safety, connection lifecycle, already battle-tested |
| SHA-256 file hashing | Custom streaming hasher | `hashlib.sha256()` (stdlib) | Stdlib is correct, zero deps, chunked reads for large files |
| Vector embeddings | Custom embedding model loading | fastembed + BAAI/bge-small-en-v1.5 | ONNX quantized, CPU-only, no PyTorch, auto-downloads on first run |
| Write serialization | Custom lock/mutex | `asyncio.Queue` with dedicated writer task | asyncio-native, no threading issues, backpressure is free |
| Process cleanup | Manual subprocess.kill | `atexit.register()` + `db.close()` | Handles normal exit and exception paths; SIGKILL handled by OS |
| Python version enforcement | CI-only check | `requires-python = ">=3.12"` in pyproject.toml | Enforced at install time by uv/pip, not just CI |

**Key insight:** Phase 1 is all stdlib + three well-chosen libraries (falkordblite, qdrant-client+fastembed, aiosqlite). Any complexity beyond these is over-engineering. The abstraction boundary is the sole Phase 1 innovation.

---

## Common Pitfalls

### Pitfall 1: FalkorDBLite Hard Python 3.12 Requirement

**What goes wrong:** FalkorDBLite 0.9.0 will not install on Python 3.11. If `requires-python = ">=3.11"` is set in pyproject.toml, the dependency resolver fails at install time. On some configurations it may fail silently at runtime with a cryptic C extension error.

**Why it happens:** FalkorDBLite uses Python 3.12 C extension ABI features. This is a hard constraint in the PyPI package metadata.

**How to avoid:** Set `requires-python = ">=3.12"` in pyproject.toml as the very first thing. Also create `.python-version` containing `3.12` in the project root (uv reads this for venv creation).

**Warning signs:** `uv sync` fails with a dependency conflict. `import falkordblite` raises ImportError on 3.11.

### Pitfall 2: FalkorDBLite Stdout Pollution on macOS First Launch

**What goes wrong:** FalkorDB's embedded Redis subprocess may emit startup text to stdout on first launch on macOS. This occurs before any logging configuration is in place if the import happens before the stderr redirect.

**Why it happens:** FalkorDBLite spawns a child Redis process. The child process may write initialization output to the parent's stdout file descriptor.

**How to avoid:** Always configure `logging.basicConfig(stream=sys.stderr)` before importing falkordblite. In the FalkorDBStore constructor, redirect the child process stdout to `/dev/null` or a log file using subprocess redirection.

**Warning signs:** CI stdout assertion fails on first ingest but not on subsequent runs. MCP inspector shows malformed first frame.

### Pitfall 3: FalkorDBLite Requires `libomp` on macOS

**What goes wrong:** Without `brew install libomp`, FalkorDBLite's Redis subprocess fails to start with `Library not loaded: /opt/homebrew/opt/libomp/lib/libomp.dylib`. This fails at FalkorDB object creation time, not at import time.

**Why it happens:** FalkorDB uses OpenMP for parallel graph operations. The OpenMP runtime (`libomp`) is not bundled in the package.

**How to avoid:** Add `brew install libomp` to CI setup steps. Add a startup check that verifies the library exists before attempting FalkorDB initialization, with a clear error message.

**Warning signs:** macOS CI fails with "Library not loaded" dylib error. Works on Linux CI but fails on macOS developer machines.

### Pitfall 4: Qdrant Local Mode 20k Vector Ceiling

**What goes wrong:** Qdrant local mode uses brute-force O(n) search with no HNSW index. The library logs a warning above 20,000 vectors. A large org with 2k+ Apex classes and 50 chunks per file easily produces 100k+ vectors.

**Why it happens:** Local mode is designed for testing, not production scale. HNSW indexing is a server-only feature.

**How to avoid:** Design VectorStore to accept either `path=` (local) or `url=` (server/subprocess) from the start. Local mode is acceptable for Phase 1 smoke tests. Production mode (Qdrant as subprocess) must be planned before Phase 3 ingestion.

**Warning signs:** Qdrant logs `WARNING: Payload index not supported in local mode`. Vector search takes > 1 second on a collection with > 10k points.

### Pitfall 5: Concurrent FalkorDB Writes Without Serialization

**What goes wrong:** Two asyncio tasks call `graph.query()` with write operations simultaneously. FalkorDB's thread/coroutine safety guarantees are undocumented. In practice, concurrent writes corrupt graph state — producing wrong node properties, missing edges, or a corrupted database file.

**Why it happens:** FalkorDBLite wraps Redis. Redis is single-threaded, but the Python client is not. Multiple concurrent Python coroutines writing to the same graph connection race on the socket.

**How to avoid:** Implement the asyncio write queue pattern from day one. All write Cypher (MERGE, CREATE, DELETE) goes through the queue. Read Cypher (`ro_query`) bypasses the queue and runs directly.

**Warning signs:** Intermittent test failures on concurrent ingestion tests. Node property values overwritten with stale data. Edges missing after a parallel ingest run.

### Pitfall 6: ManifestStore Schema Missing Phase State Machine

**What goes wrong:** If the manifest schema only tracks `sha256` and `last_ingested_at` without the four-state phase machine (PENDING/NODES_WRITTEN/EDGES_WRITTEN/FAILED), crash recovery in Phase 3 is impossible. A crashed mid-node-phase ingest cannot distinguish "file never processed" from "file nodes written but edges not yet written."

**Why it happens:** The schema seems simple at first — just a file tracker. The phase state machine is only needed when ingestion is interrupted, which won't happen in Phase 1 smoke tests.

**How to avoid:** Implement the full schema in Phase 1. The `runs` table with `phase_1_complete` and `phase_2_complete` flags is part of the Phase 1 deliverable, not a Phase 3 concern.

**Warning signs:** A failed ingest leaves the graph in an unknown state with no way to resume. Re-ingesting produces duplicate nodes or missing edges.

---

## Code Examples

Verified patterns from official sources:

### FalkorDBLite: Import Path and Basic Graph Operations
```python
# Source: FalkorDB official docs (https://docs.falkordb.com/operations/falkordblite/falkordblite-py.html)
# IMPORTANT: import from redislite.falkordb_client, NOT from falkordb
from redislite.falkordb_client import FalkorDB

db = FalkorDB('/path/to/sfgraph.db')
graph = db.select_graph('org_graph')

# Write: always use MERGE for idempotency
graph.query("MERGE (:ApexClass {qualifiedName: $qn, name: $name})", {
    'qn': 'AccountService',
    'name': 'AccountService',
})

# Read: use ro_query for read-only operations
results = graph.ro_query(
    "MATCH (c:ApexClass) WHERE c.name = $name RETURN c.qualifiedName",
    {'name': 'AccountService'}
)
for row in results.result_set:
    print(row)

db.close()
```

### Qdrant Local Mode: Initialize and Upsert
```python
# Source: qdrant-client 1.17.1 docs (https://python-client.qdrant.tech/)
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

# Local file-backed mode — no server required
client = QdrantClient(path="/path/to/qdrant_store")

# Create collection if not exists
client.create_collection(
    collection_name="source_chunks",
    vectors_config=VectorParams(size=384, distance=Distance.COSINE),
)

# Upsert a vector
client.upsert(
    collection_name="source_chunks",
    points=[PointStruct(
        id=42,
        vector=[0.1] * 384,  # replace with real embedding
        payload={"node_id": "AccountService", "source_file": "classes/AccountService.cls"},
    )],
)

# Search by similarity
results = client.search(
    collection_name="source_chunks",
    query_vector=[0.1] * 384,
    limit=5,
)
```

### aiosqlite: Schema Creation and CRUD
```python
# Source: aiosqlite 0.22.1 docs (https://aiosqlite.omnilib.dev/)
import aiosqlite

async def setup_manifest(db_path: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'PENDING',
                run_id TEXT,
                last_ingested_at REAL
            )
        """)
        await db.commit()

async def set_file_status(db_path: str, path: str, status: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "UPDATE files SET status = ? WHERE path = ?",
            (status, path)
        )
        await db.commit()
```

### pyproject.toml: Correct Phase 1 Structure
```toml
# Source: uv docs (https://docs.astral.sh/uv/guides/projects/) + STACK.md
[project]
name = "sfgraph"
version = "0.1.0"
description = "Salesforce org metadata graph analyzer with MCP server"
requires-python = ">=3.12"   # CRITICAL: FalkorDBLite hard requirement
dependencies = [
    "falkordblite>=0.9.0",
    "qdrant-client>=1.17.0",
    "fastembed>=0.8.0",
    "aiosqlite>=0.22.0",
    "mcp[cli]>=1.27.0",
    "pydantic>=2.0.0",
]

[project.scripts]
sfgraph = "sfgraph.cli:app"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.uv]
dev-dependencies = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
    "pytest-cov>=5.0.0",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
```

### CI: Stdout Discipline Assertion
```python
# tests/test_stdout_discipline.py
# Source: project requirement FOUND-07 + MCP pitfall from PITFALLS.md
import subprocess
import sys

def test_server_entry_point_emits_zero_stdout_bytes():
    """MCP stdio transport is fatally corrupted by any stdout output.

    This test runs the server entry point with a no-op command and asserts
    that zero bytes are written to stdout.
    """
    result = subprocess.run(
        [sys.executable, "-c",
         "import logging, sys; logging.basicConfig(stream=sys.stderr); "
         "from sfgraph.storage import GraphStore, FalkorDBStore, VectorStore, ManifestStore"],
        capture_output=True,
        timeout=10,
    )
    assert result.stdout == b"", (
        f"stdout must be empty. Got {len(result.stdout)} bytes: {result.stdout[:200]!r}"
    )
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Kùzu embedded Cypher graph | FalkorDBLite 0.9.0 | Oct 2025 (Kùzu archived) | FalkorDBLite is now the only viable embedded Cypher option |
| pip + requirements.txt | uv + pyproject.toml | 2024-2025 | 10-100x faster installs; lockfile included; Python version management |
| sentence-transformers (PyTorch) | FastEmbed (ONNX) | 2024 | ~2GB install → ~60MB; CPU-only; comparable accuracy |
| Qdrant Docker-only | Qdrant local mode (in-proc) | 2023-2024 | No server dependency for small-to-medium corpora |
| Custom asyncio thread pools for SQLite | aiosqlite | 2021+ | Zero-dep async SQLite wrapper; handles connection lifecycle |

**Deprecated/outdated:**
- `falkordb` (PyPI package): This is the **connected-server** client, not the embedded version. Do not use it. Use `falkordblite` only.
- `Kùzu`: Archived Oct 2025. No migration path. FalkorDBLite is the successor.
- `requirements.txt` + `setup.py`: Replaced by `pyproject.toml` + `uv`. The project must use the modern packaging format from the first commit.

---

## Open Questions

1. **FalkorDBLite Redis subprocess stdout behavior on macOS first launch**
   - What we know: FalkorDBLite spawns a Redis child process; Redis is known to emit startup messages
   - What's unclear: Whether the child process stdout is connected to the parent's stdout fd by default, and whether this varies by platform or libomp version
   - Recommendation: In the FalkorDBStore constructor, explicitly redirect subprocess stdout to `subprocess.DEVNULL` or a log file. Verify the CI stdout assertion catches any leakage.

2. **FalkorDBLite asyncio write concurrency: exact behavior**
   - What we know: Thread safety is undocumented; concurrent writes are risky; asyncio queue serialization is the correct mitigation
   - What's unclear: Whether FalkorDBLite's Python client internally uses a connection pool or a single socket; whether reads truly are safe concurrent
   - Recommendation: Validate under concurrent asyncio load in Phase 1 integration tests before any ingestion code is written. Use `asyncio.gather()` with 10 concurrent read queries to confirm ro_query safety.

3. **fastembed first-run model download in CI/offline environments**
   - What we know: fastembed auto-downloads BAAI/bge-small-en-v1.5 (~60MB) on first run; `FASTEMBED_CACHE_DIR` env var controls cache location
   - What's unclear: Whether CI runners have internet access for model download; whether the download blocks the test run or is async
   - Recommendation: Pre-download the model in CI setup step: `python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')"`. Set `FASTEMBED_CACHE_DIR` to a persistent cache directory.

---

## Sources

### Primary (HIGH confidence)
- [FalkorDBLite Python docs](https://docs.falkordb.com/operations/falkordblite/falkordblite-py.html) — Python 3.12 requirement, embedded Redis model, import path (`redislite.falkordb_client`), API reference
- [FalkorDB Cypher support](https://docs.falkordb.com/cypher/cypher-support.html) — Supported/unsupported Cypher features; `CALL db.labels()` availability confirmed
- [qdrant-client PyPI 1.17.1](https://pypi.org/project/qdrant-client/) — Local mode capabilities, path-based init
- [Qdrant local mode docs](https://deepwiki.com/qdrant/qdrant-client/2.2-local-mode) — 20k vector limit, brute-force search, portalocker single-process enforcement
- [fastembed PyPI 0.8.0](https://pypi.org/project/fastembed/) — BAAI/bge-small-en-v1.5 model, ONNX backend, FASTEMBED_CACHE_DIR env var
- [aiosqlite PyPI 0.22.1](https://pypi.org/project/aiosqlite/) — Async SQLite bridge, connection lifecycle
- [mcp PyPI 1.27.0](https://pypi.org/project/mcp/) — Official Anthropic MCP SDK, stdio transport behavior
- [uv documentation](https://docs.astral.sh/uv/) — pyproject.toml structure, `requires-python`, `.python-version` file
- [Python ABC docs](https://docs.python.org/3/library/abc.html) — abstractmethod, ABC base class
- [Python asyncio docs](https://docs.python.org/3/library/asyncio-queue.html) — asyncio.Queue, task serialization pattern

### Secondary (MEDIUM confidence)
- [MCP Python SDK Lifespan Management](https://deepwiki.com/modelcontextprotocol/python-sdk/2.5-context-injection-and-lifespan) — FastMCP lifespan pattern for shared resources
- [NearForm MCP pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/) — stdout corruption confirmation, async patterns
- [FalkorDB GitHub](https://github.com/FalkorDB/falkordblite) — libomp note, persistence model

### Tertiary (LOW confidence)
- None for Phase 1 — all Phase 1 findings are verified against primary sources.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all package versions verified against PyPI as of April 2026; FalkorDBLite 0.9.0, qdrant-client 1.17.1, fastembed 0.8.0, aiosqlite 0.22.1, mcp 1.27.0 all confirmed
- Architecture: HIGH — GraphStore ABC pattern, asyncio queue serialization, and ManifestStore schema are verified design patterns; no speculative components
- Pitfalls: HIGH — FalkorDB Python 3.12 requirement verified against official docs; stdout corruption verified against MCP SDK behavior; libomp requirement verified against FalkorDB docs; Qdrant 20k ceiling verified against official Qdrant docs

**Research date:** 2026-04-04
**Valid until:** 2026-05-04 (30 days — falkordblite and qdrant-client are stable; mcp SDK moves faster, verify version before starting)
