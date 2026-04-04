# Technology Stack

**Project:** Salesforce Org Graph Analyzer (MCP Tool)
**Researched:** 2026-04-03
**Research Mode:** Ecosystem — standard 2025/2026 stack for local embedded Salesforce metadata graph analysis

---

## Recommended Stack

### Runtime and Package Management

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| Python | 3.12+ | Primary orchestration runtime | FalkorDBLite hard-requires Python 3.12 minimum; 3.12 also ships significantly faster asyncio internals vs 3.11 |
| uv | latest (astral-sh) | Package management, lock files, virtualenvs, PyPI publish | 10-100x faster than pip; manages Python version too; `uv add`, `uv sync`, `uv publish` replace entire pip + venv + twine workflow; official MCP docs recommend uv |
| Node.js | 20 LTS | tree-sitter subprocess pool host | tree-sitter-sfapex only ships native Node.js bindings; 20 LTS = longest support window, compatible with tree-sitter 0.25.x |

**Constraint driver:** FalkorDBLite's Python 3.12 requirement forces the entire project to 3.12+. This is fine — 3.12 is stable and widely deployed. Do not try to support 3.11.

---

### Graph Database (Primary Store)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| falkordblite | 0.9.0 (March 2026) | Embedded property graph store; Cypher queries | Zero-config embedded Redis + FalkorDB module; no separate server process; New BSD license (enterprise-safe); purpose-built for GraphRAG workflows; Kùzu was archived by corporate sponsor Oct 2025 — FalkorDB is now the clear embedded Cypher choice |

**Installation:**
```bash
uv add falkordblite
# macOS only: brew install libomp  (OpenMP runtime required)
```

**Python API — instantiation:**
```python
from redislite.falkordb_client import FalkorDB

db = FalkorDB('/path/to/sfgraph.db')
graph = db.select_graph('org_graph')
graph.query("CREATE (:ApexClass {name: $name})", {'name': 'AccountService'})
results = graph.ro_query("MATCH (c:ApexClass)-[:CALLS]->(m:ApexMethod) RETURN c, m")
```

**Key constraints:**
- Python 3.12+ required (hard limit — falkordblite won't load on 3.11)
- macOS requires `libomp` (`brew install libomp`) — document prominently in contributor docs
- FalkorDBLite wraps Redis-lite under the hood; communication is via Unix socket (no network port needed)
- The `GraphStore` abstraction protocol defined in the design doc is essential — all Cypher calls go through a protocol interface so DuckPGQ fallback can be swapped in if FalkorDBLite shows instability

**Confidence:** HIGH — verified against falkordblite PyPI (0.9.0, March 2026) and official FalkorDB docs.

---

### Vector Index (Semantic Search)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| qdrant-client | 1.17.1 (March 2026) | Local vector index for source code chunks | Native local/embedded mode (`QdrantClient(path="...")`) — no server process; Apache-2.0 license; first-class Python API with async support; pairs cleanly with fastembed for CPU-only embedding |
| fastembed | 0.8.0 (March 2026) | Local ONNX-based embeddings | No GPU needed; ONNX Runtime backend (faster than PyTorch); default model BAAI/bge-small-en-v1.5 (768-dim, strong MTEB scores); avoids bringing in sentence-transformers + heavy PyTorch dependency |

**Installation:**
```bash
uv add qdrant-client fastembed
# fastembed auto-downloads model weights on first run (~60MB for bge-small)
```

**Local mode — no server:**
```python
from qdrant_client import QdrantClient

client = QdrantClient(path="/path/to/qdrant_store")  # persistent, no server
# OR:
client = QdrantClient(":memory:")  # in-memory, for tests only
```

**Why not sentence-transformers:** Pulls in full PyTorch (~2GB install), which conflicts with the "minimal local footprint" constraint. FastEmbed delivers comparable accuracy at a fraction of the install size via ONNX quantized models.

**Why not Chroma / Weaviate embedded:** Chroma's embedded mode is unstable for production use. Weaviate requires Docker. Qdrant's local mode is explicitly designed for production embedded deployment.

**Confidence:** HIGH — verified against qdrant-client PyPI (1.17.1, March 2026) and fastembed PyPI (0.8.0, March 2026).

---

### Manifest Store (Incremental Refresh)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| aiosqlite | 0.22.1 (December 2025) | Async SQLite wrapper for file manifest | Python's stdlib `sqlite3` is synchronous; `aiosqlite` provides async/await bridge with zero additional dependencies beyond sqlite3; stores SHA-256 hashes + last_ingested_at timestamps for dirty-file detection |

**Installation:**
```bash
uv add aiosqlite
```

**Why not a full ORM (SQLAlchemy, Tortoise):** The manifest schema is intentionally minimal (files table, hashes, timestamps). An ORM adds indirection and complexity for what is essentially three SQL statements. Raw `aiosqlite` with parameterised queries is the right level of abstraction.

**Confidence:** HIGH — verified against aiosqlite PyPI (0.22.1).

---

### MCP Server

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| mcp | 1.27.0 (April 2026) | MCP server SDK — tool registration, stdio/SSE transport | Official Anthropic SDK; MIT license; latest version implements MCP spec 2025-11-25; supports both stdio (for Claude Desktop) and Streamable HTTP (for remote clients); `uv add "mcp[cli]"` installs server scaffolding |

**Installation:**
```bash
uv add "mcp[cli]"
```

**Server bootstrap pattern:**
```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("salesforce-org-graph")

@mcp.tool()
async def query(question: str) -> str:
    """Answer a natural language question about org dependencies."""
    ...

@mcp.tool()
async def ingest_org(metadata_path: str) -> dict:
    """Ingest a Salesforce metadata export directory."""
    ...

if __name__ == "__main__":
    mcp.run()  # stdio transport by default
```

**Tools to expose (from PROJECT.md):** `ingest_org`, `refresh`, `query`, `get_node`, `explain_field`, `get_ingestion_status`.

**Transport recommendation:** Default to stdio (compatible with Claude Desktop, Cursor, VS Code Copilot). Add Streamable HTTP as a `--transport http` flag for programmatic clients.

**Confidence:** HIGH — verified against mcp PyPI (1.27.0, April 2026) and official MCP documentation.

---

### LLM Query Layer

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| anthropic | 0.89.0 (April 2026) | Claude API client for three-agent pipeline | Official SDK; supports structured outputs, streaming, retry logic built-in; `claude-haiku-4-5` for Schema Filter Agent (cost-optimised), `claude-sonnet-4-6` for Query Generator + Result Formatter (quality) |

**Installation:**
```bash
uv add anthropic
```

**Model assignments (three-agent pipeline):**

| Agent | Model | Rationale |
|-------|-------|-----------|
| Schema Filter (Agent 1) | `claude-haiku-4-5` | Lightweight classification — which schema elements are relevant; 20-40x cheaper than Sonnet; speed is critical here |
| Query Generator (Agent 2) | `claude-sonnet-4-6` | Complex text-to-Cypher translation; needs reasoning quality; iterative correction loop (max 4 iterations) |
| Result Formatter (Agent 3) | `claude-sonnet-4-6` | Structured output contract (TRAVERSE vs ANSWER); confidence tier tagging; prose explanation |

**Structured output for Agent 3:**
```python
# Pydantic model for structured output contract
class QueryResult(BaseModel):
    response_type: Literal["TRAVERSE", "ANSWER"]
    confidence: Literal["Definite", "Probable", "Review manually"]
    answer: str
    sources: list[SourceAttribution]
    trace_limit_hit: bool
```

**Why not OpenAI / local LLMs:** Project targets Anthropic's tool ecosystem (Claude Desktop); Haiku 4.5 + Sonnet 4.6 are the current production models as of April 2026; local LLMs (Ollama, etc.) cannot reliably perform multi-step Cypher generation at required quality. Can be added as optional backend in v2.

**Confidence:** HIGH — verified against anthropic PyPI (0.89.0, April 2026) and Anthropic model docs.

---

### Apex / SOQL / SOSL Parsing (Node.js subprocess pool)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| tree-sitter | 0.25.0 (npm) | Core Node.js tree-sitter runtime | Node bindings for tree-sitter; grammar loader; CST/AST traversal API |
| tree-sitter-sfapex | 2.4.1 (npm, February 2025) | Salesforce Apex + SOQL + SOSL grammars | Only production-grade Apex parser in any ecosystem; covers `.cls`, `.trigger`, inline SOQL, inline SOSL; maintained by community (aheber); includes Salesforce log file parser (sflog) as bonus |
| tree-sitter-javascript | 0.25.0 (npm) | LWC `.js` file parsing | Wire service calls, imperative Apex imports, event handlers; ECMAScript 2025 spec compliance |

**Installation (Node.js side):**
```bash
npm install tree-sitter tree-sitter-sfapex tree-sitter-javascript
```

**Subprocess pool architecture (Python side):**

The Python orchestrator spawns N Node.js worker processes at startup. Workers receive parse requests over stdin (newline-delimited JSON) and return CST results over stdout (newline-delimited JSON). This amortises the grammar load cost (~300ms per grammar) across 2000+ files.

```
Python orchestrator
  → stdin JSON: {"file": "AccountService.cls", "language": "apex", "source": "..."}
  ← stdout JSON: {"nodes": [...], "edges_raw": [...], "error": null}
```

**IPC protocol:** Newline-delimited JSON (ndjson). No NULL terminators needed — JSON escapes newlines in source strings.

**Memory ceiling:** Each Node.js worker is capped at 200 files before restart (prevents V8 heap creep on large orgs).

**Health checks:** Python pool manager pings workers with `{"action":"ping"}` every 30s; dead workers are replaced before the next batch.

**Why not py-tree-sitter with tree-sitter-sfapex:** `tree-sitter-sfapex` ships Node.js native bindings only. The Python `tree-sitter` package requires a compiled `.so`/`.dylib` grammar file, which `tree-sitter-sfapex` does not publish. Generating it from source requires `tree-sitter-cli` and a C compiler, which is an unreasonable install burden for end users. The Node.js subprocess pool is the correct architecture.

**Why not web-tree-sitter (WASM):** WASM in a subprocess adds another layer of complexity and is ~5x slower than native bindings for large files. Native Node bindings are the right choice.

**Confidence:** MEDIUM-HIGH — tree-sitter-sfapex 2.4.1 confirmed via npm (February 2025); tree-sitter Node.js npm package is at 0.25.0 with 0.26.x available in the main repo but not yet published to npm (known issue in tree-sitter GitHub #5334 as of research date).

---

### LWC HTML and Flow/Object/Vlocity XML Parsing (Python side)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| lxml | 5.x (latest stable) | LWC `.html` template parsing; Flow XML; Object/Field XML; Vlocity DataPack JSON | XPath 1.0 support (required for namespace-aware Salesforce XML); 5-10x faster than stdlib ElementTree for large XML; C-backed (libxml2); API is ElementTree-compatible for easy migration |

**Installation:**
```bash
uv add lxml
```

**Why not stdlib ElementTree:** ElementTree's XPath support is limited (no `//` with predicates in all contexts, no `text()` functions, namespace handling is fragile). Salesforce Flow XML uses non-trivial namespace structures. lxml handles these correctly and is 5-10x faster for the XML volumes in a large org export.

**Vlocity DataPacks:** JSON format — use stdlib `json` module. No additional dependency needed.

**Confidence:** HIGH — lxml is the de-facto standard for production Python XML parsing; 6.0.0 released June 2025.

---

### File Watching (Real-Time Mode)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| watchdog | 6.0.0 (2025) | File system event monitoring for incremental refresh | Wraps OS-native APIs (inotify/FSEvents/ReadDirectoryChangesW); Python 3.9+ compatible; 2s debounce implemented via `threading.Timer` on top of watchdog events |

**Installation:**
```bash
uv add watchdog
```

**Confidence:** HIGH — confirmed 6.0.0 on PyPI, Python 3.9+ support.

---

### Data Validation and Structured Outputs

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| pydantic | v2 (2.x latest) | Input validation for MCP tool arguments; structured output contracts for Agent 3; GraphStore protocol models | v2 is Rust-backed (10-50x faster than v1); required by `mcp` SDK; `model_json_schema()` generates LLM-ready schemas at zero cost |

**Installation:**
```bash
uv add pydantic  # mcp[cli] already pulls this in as a transitive dep
```

**Confidence:** HIGH — Pydantic v2 is standard across the Python ecosystem; mcp SDK depends on it.

---

### CLI Entrypoint

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| typer | 0.12.x | CLI (`sfgraph ingest`, `sfgraph query`, `sfgraph serve`) | Type-hint-driven CLI with zero boilerplate; built on Click; completion support out of the box; consistent with uv/modern Python tooling style |

**Installation:**
```bash
uv add typer
```

**Confidence:** MEDIUM — Typer is widely adopted in 2025 Python CLIs; version 0.9+ has enhanced type hint support.

---

### Testing

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| pytest | 8.x | Test runner | De-facto standard; fixture system fits ingestion pipeline testing perfectly |
| pytest-asyncio | 0.24.x | Async test support | MCP server and Qdrant client are async; asyncio mode required |
| pytest-cov | 5.x | Coverage reporting | `--cov-fail-under=90` enforced in CI per CLAUDE.md standards |

**Installation:**
```bash
uv add --dev pytest pytest-asyncio pytest-cov
```

**Confidence:** HIGH — all standard pytest ecosystem packages.

---

## Alternatives Considered and Rejected

| Category | Recommended | Alternative | Why Rejected |
|----------|-------------|-------------|--------------|
| Graph DB | FalkorDBLite | Kùzu | Corporate sponsor abandoned project Oct 2025; repository archived; no production path |
| Graph DB | FalkorDBLite | DuckPGQ | Promising but SQL/PGQ syntax diverges significantly from Cypher; text-to-Cypher training data far larger for Cypher; DuckPGQ is a community extension still maturing |
| Graph DB | FalkorDBLite | Neo4j embedded | No true embedded mode; requires separate JVM server process; GPL license conflicts with OSS distribution |
| Vector Index | Qdrant (local) | Chroma | Chroma's embedded mode has known stability issues at production scale; inferior metadata filtering |
| Vector Index | Qdrant (local) | Weaviate | Requires Docker; not embeddable in Python process |
| Embeddings | FastEmbed | sentence-transformers | Pulls full PyTorch (~2GB); unnecessary GPU deps; fastEmbed ONNX approach is lighter and faster for CPU inference |
| Apex Parser | Node.js subprocess pool | py-tree-sitter + compiled grammar | sfapex does not publish Python-compatible compiled grammars; building from source adds C toolchain requirement |
| Apex Parser | Node.js subprocess pool | Jorje (SF tooling JAR) | JVM dependency; no public API; requires Salesforce tooling license |
| XML Parsing | lxml | stdlib ElementTree | Insufficient XPath, fragile namespace handling, 5-10x slower |
| LLM SDK | anthropic | LangChain / LlamaIndex | Unnecessary abstraction layer; both frameworks add significant dependency weight; for a three-agent pipeline the raw SDK gives full control over retry logic and structured output contracts |
| CLI | typer | click | Typer is click with type hints; less boilerplate; consistent with modern Python style |
| CLI | typer | argparse | Verbose syntax; no type hint integration; inferior DX |

---

## Complete Installation

**Python environment:**
```bash
# Install uv (if not present)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Create project with Python 3.12
uv init salesforce-org-graph --python 3.12
cd salesforce-org-graph

# Core runtime dependencies
uv add falkordblite qdrant-client fastembed aiosqlite "mcp[cli]" anthropic lxml watchdog pydantic typer

# Development dependencies
uv add --dev pytest pytest-asyncio pytest-cov

# macOS only (for FalkorDBLite's OpenMP requirement)
brew install libomp
```

**Node.js environment (subprocess pool):**
```bash
npm install tree-sitter tree-sitter-sfapex tree-sitter-javascript
```

**pyproject.toml structure:**
```toml
[project]
name = "salesforce-org-graph"
version = "0.1.0"
description = "Local Salesforce org metadata graph analyzer with MCP server"
requires-python = ">=3.12"
dependencies = [
    "falkordblite>=0.9.0",
    "qdrant-client>=1.17.0",
    "fastembed>=0.8.0",
    "aiosqlite>=0.22.0",
    "mcp[cli]>=1.27.0",
    "anthropic>=0.89.0",
    "lxml>=5.0.0",
    "watchdog>=6.0.0",
    "pydantic>=2.0.0",
    "typer>=0.12.0",
]

[project.scripts]
sfgraph = "salesforce_org_graph.cli:app"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.uv]
dev-dependencies = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.24.0",
    "pytest-cov>=5.0.0",
]
```

---

## Architecture Notes for Stack Consumers

**Python 3.12 is non-negotiable.** FalkorDBLite will not load on 3.11. Every CI matrix, Docker base image, and contributor setup guide must specify 3.12.

**The Node.js pool is a first-class architectural component**, not a hack. It has health checks, memory ceilings, and replay mode. Budget ~2 days to build and harden it in the first milestone. Do not attempt to replace it with py-tree-sitter — the grammar compilation story for sfapex in Python is not viable for a distributable package.

**FalkorDBLite's macOS libomp requirement is a contributor friction point.** Put `brew install libomp` in line 1 of the Quick Start section of the README. Add a startup check that prints a clear error message if libomp is missing before the import fails silently.

**FalkorDB 1.2.2 (the connected-server client) is different from falkordblite 0.9.0 (embedded).** Do not confuse them. The project uses `falkordblite` only — no Redis server, no Docker. The design doc's `GraphStore` abstraction must import from `redislite.falkordb_client`, not `falkordb`.

**FastEmbed downloads model weights on first run.** For an air-gapped or offline install scenario, pre-download BAAI/bge-small-en-v1.5 and set `FASTEMBED_CACHE_DIR`. Document this in the offline install guide.

---

## Confidence Assessment

| Area | Confidence | Basis |
|------|------------|-------|
| FalkorDBLite version + API | HIGH | Official FalkorDB docs + PyPI (0.9.0 March 2026) confirmed |
| FalkorDBLite Python 3.12 requirement | HIGH | Official docs explicit: "Python 3.12 or higher" |
| qdrant-client version | HIGH | PyPI verified (1.17.1 March 2026) |
| FastEmbed version | HIGH | PyPI verified (0.8.0 March 2026) |
| MCP SDK version | HIGH | PyPI verified (1.27.0 April 2026) |
| anthropic SDK version | HIGH | PyPI verified (0.89.0 April 2026) |
| tree-sitter-sfapex version | MEDIUM | npm search confirmed 2.4.1 (February 2025); latest sfapex grammar activity is current |
| tree-sitter npm version | MEDIUM | npm stuck at 0.25.0 while upstream is 0.26.5 (known GitHub issue #5334); use 0.25.0 |
| aiosqlite version | HIGH | PyPI verified (0.22.1 December 2025) |
| watchdog version | HIGH | PyPI shows 6.0.0 (2025) |
| Kùzu abandonment | HIGH | Multiple credible sources; The Register, BigGo News, FalkorDB migration guide — Oct 2025 |
| Claude model names (Haiku 4.5 / Sonnet 4.6) | HIGH | Anthropic release notes; model names confirmed current as of April 2026 |

---

## Sources

- [falkordblite on PyPI](https://pypi.org/project/falkordblite/) — version history
- [FalkorDBLite Python docs](https://docs.falkordb.com/operations/falkordblite/falkordblite-py.html) — official API reference
- [FalkorDBLite GitHub](https://github.com/FalkorDB/falkordblite) — Python 3.12 requirement, libomp note
- [qdrant-client on PyPI](https://pypi.org/project/qdrant-client/) — version 1.17.1, March 2026
- [fastembed on PyPI](https://pypi.org/project/fastembed/) — version 0.8.0, March 2026
- [mcp on PyPI](https://pypi.org/project/mcp/) — version 1.27.0, April 2026
- [MCP Python SDK GitHub](https://github.com/modelcontextprotocol/python-sdk) — official Anthropic SDK
- [anthropic on PyPI](https://pypi.org/project/anthropic/) — version 0.89.0, April 2026
- [aiosqlite on PyPI](https://pypi.org/project/aiosqlite/) — version 0.22.1
- [watchdog on PyPI](https://pypi.org/project/watchdog/) — version 6.0.0
- [tree-sitter-sfapex GitHub](https://github.com/aheber/tree-sitter-sfapex) — Apex/SOQL/SOSL grammar
- [tree-sitter Node.js bindings](https://github.com/tree-sitter/node-tree-sitter) — version 0.25.0
- [KuzuDB archived — The Register](https://www.theregister.com/2025/10/14/kuzudb_abandoned/) — abandonment confirmation
- [FalkorDB KuzuDB migration guide](https://www.falkordb.com/blog/kuzudb-to-falkordb-migration/) — migration rationale
- [MCP build server docs](https://modelcontextprotocol.io/docs/develop/build-server) — uv recommendation
- [uv documentation](https://docs.astral.sh/uv/) — project management patterns
