# Architecture

`sfgraph` is a local-first Salesforce metadata analysis system with three major layers:

- ingestion: parse Salesforce metadata and write graph state
- storage: persist graph state, manifest state, and vector state
- query/MCP: expose lineage, impact, and troubleshooting tools over MCP and CLI

## High-Level Flow

```text
metadata export
  -> parsers
  -> node/edge facts
  -> graph store + manifest + vectors
  -> query service
  -> MCP tools / CLI
```

## Main Components

### Ingestion

Ingestion lives under `src/sfgraph/ingestion/`.

Responsibilities:

- discover supported files in an export
- parse Apex, Flows, objects, LWC, and Vlocity assets
- normalize results into `NodeFact` and `EdgeFact`
- write scoped graph rows
- track run/file status in the manifest
- update vector search chunks for query fallback

Important files:

- [`src/sfgraph/ingestion/service.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/ingestion/service.py)
- [`src/sfgraph/ingestion/models.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/ingestion/models.py)
- [`src/sfgraph/ingestion/scope_migration.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/ingestion/scope_migration.py)
- [`src/sfgraph/ingestion/snapshot.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/ingestion/snapshot.py)

### Parsers

Parsers live under `src/sfgraph/parser/`.

Current parser coverage:

- Apex CST extraction
- Flow XML
- Object and field XML
- LWC JS/HTML metadata references
- OmniStudio / Vlocity JSON

The Apex path uses a Node worker with `web-tree-sitter-sfapex`, which is why `npm install` is required even though the main product is Python.

### Storage

Storage lives under `src/sfgraph/storage/`.

Current runtime model:

- graph store: DuckDB-backed property graph tables
- manifest store: SQLite file state and ingestion run tracking
- vector store: local Qdrant path storage for semantic fallback

Important note:

- FalkorDB exists as an optional backend path, but the default product flow is DuckDB-based.

### Query Layer

Query logic lives under `src/sfgraph/query/`.

Responsibilities:

- node lookup and scoped/unscoped resolution
- upstream and downstream lineage tracing
- evidence-first edge/path formatting
- git-diff impact analysis
- cross-layer flow map generation
- unknown dynamic edge reporting
- heuristic or optional LLM-assisted query shaping

Important files:

- [`src/sfgraph/query/graph_query_service.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/query/graph_query_service.py)
- [`src/sfgraph/query/rules_registry.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/query/rules_registry.py)
- [`src/sfgraph/query/agents.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/query/agents.py)

### MCP Server

The MCP server lives in [`src/sfgraph/server.py`](/Users/anshulmehta/Documents/salesforceMCP/src/sfgraph/server.py).

Responsibilities:

- initialize runtime storage handles
- expose MCP tools over `stdio`
- enforce workspace-local export path validation
- return structured JSON for each tool

## Project Isolation Model

`sfgraph` is designed to avoid cross-project contamination.

Isolation mechanisms:

- graph node keys are stored as `projectScope::qualifiedName`
- vector search is filtered by `project_scope`
- ingestion freshness metadata records `project_scope` and export path
- MCP ingest paths are restricted to the current workspace root

Recommended practice:

- use a separate data directory for each project
- run one MCP server instance per workspace

## Freshness Contract

Many query outputs return:

- `indexed_commit`
- `indexed_at`
- `project_scope`
- `dirty_files_pending`
- `partial_results`

This is meant to make stale or partial graph state visible instead of silent.

## Runtime Layout

Source install default:

- `./data/sfgraph.duckdb`
- `./data/manifest.sqlite`
- `./data/vectors/`

npx bootstrap default:

- cached Python runtime under the user cache directory
- workspace-specific data under:
  - `~/Library/Caches/sfgraph-mcp/workspaces/<hash>/data` on macOS

## Design Goals

The architecture is optimized for:

- evidence over prose
- local operation over hosted dependency
- honest handling of dynamic/unknown edges
- project isolation
- repeatable impact analysis during code review and release validation
