# Design decisions

For the storage-layer and ingestion-pipeline implementation deep-dive, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Why TypeScript

`sfgraph` started as a Python project (`sfgraph@0.1.x` on PyPI). v1.0 is a clean-room TypeScript rewrite. Four reasons drove the pivot:

1. **MCP-native tooling.** [Anthropic's Model Context Protocol](https://modelcontextprotocol.io) has first-class SDK support in TypeScript. The `@modelcontextprotocol/sdk` package gives us stdio transport, schema validation, and tool dispatch for free. The Python MCP ecosystem exists but trails the TypeScript one in stability and feature parity.
2. **Salesforce ecosystem alignment.** The official `@salesforce/cli`, `@salesforce/core`, and `jsforce` libraries are all TypeScript. Running on the same runtime as the user's `sf` CLI means we read `~/.sfdx/` auth state with zero translation, no wrapper, and no separate token cache.
3. **Single-binary distribution via npm.** A Salesforce developer almost always has Node.js installed (it powers `sf`, Vlocity Build, Codey, sfdx-source-deploy). Asking them to also install Python 3.12 + a virtualenv + `uv` was friction.
4. **Strict typing for a graph engine.** sfgraph's value depends on the integrity of `NodeFact` / `EdgeFact` shapes across ~25 metadata categories. TypeScript with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax` catches at compile-time the same class of bugs that Python's `mypy --strict` catches at lint time.

The Python codebase is retired; no v0.x branches are maintained. The storage layer changed from DuckDB / FalkorDB to SQLite + sqlite-vec — there is no auto-migration path.

---

## Major architectural choices

| Decision | Choice | Why |
|---|---|---|
| **Storage backend** | SQLite + sqlite-vec, one file per org | Zero-install. Survives reboots. WAL journaling. vec0 partitions by `org_id` so cross-org search never spills into the wrong org. DuckDB was faster on some scans but added a 60MB native binary and concurrency complexity for stdio servers. |
| **Schema model** | Per-label node tables + per-rel-type edge tables, lazy CREATE | Composite PKs `(org_id, qualified_name)` on nodes, reverse-traversal index `(org_id, dst_qname)` on edges. "Who depends on X?" is as cheap as "what does X depend on?". |
| **Embeddings** | MiniLM-L6-v2 quantized ONNX, vendored via Git LFS, run in-process by transformers.js | No external embedding service. 384-dim vectors. ~30 MB binary that ships once. Batched inference in a side-stream queue so parsing never blocks. |
| **Parser dispatch** | `conn.metadata.describe()` at ingest start → runtime type registry | No hardcoded type list. New Salesforce releases or installed packages surface immediately. Unknown types route to a generic opaque-node parser; the graph is never blind. |
| **Code parsers vs. rules** | 6 code parsers (Apex/LWC/Flow/Object + 4 Vlocity JSON), 21 YAML rule files for the rest | Apex AST and LWC bundle work are too complex for declarative rules. Everything else fits in 30 lines of YAML. |
| **Vlocity coverage** | Vendor `vlocity_build/QueryDefinitions.yaml` (MIT), probe all 5 industry namespaces | Vlocity is in maintenance mode; the registry is stable. Vendoring is a 50-line file, not a runtime dependency. |
| **Cross-flavor resolver** | Post-pass that emits `CANONICAL_OF` edges between Vlocity-CMT and OmniStudio-on-Core duplicates | Many orgs are mid-migration. The agent treats `DataRaptor:X` and `OmniDataTransform:X` as the same logical asset. |
| **Live sync auth** | Delegated to `sf` CLI / `@salesforce/core` | We never see passwords. Token lives in `~/.sfdx/`. Re-using the user's existing login means zero new credentials to manage. |
| **Read-only enforcement** | Runtime Proxy, not just convention | Every mutating method on `jsforce` throws synchronously. Verified by 41 adversarial tests. |
| **Telemetry sink** | `LocalFileSink` only; no remote endpoint exists in the codebase | Local-only is a code-level guarantee, not a config flag. |
| **Rate limiting** | Three independent Bottleneck pools (Tooling / Metadata / Data), drained in parallel | Salesforce throttles per-API. Separate budgets let us hit ~20 concurrent calls without violating any single limit. |
| **MCP tool envelope** | `{ summary, markdown, data, follow_up_tools? }` | Agents read `summary`. Humans read `markdown`. Programmatic consumers read `data`. `follow_up_tools` lets skills compose. |
| **Incremental sync** | `SourceMember` polling on Source-Tracking-enabled orgs | One Tooling SOQL, refetch only changed members. Sub-30s on sandboxes. Falls back to full sync on production orgs. |

---

## How the analysis actually works

Every tool answers a question by traversing a typed property graph stored locally in SQLite. The graph is built ingest-time by capability-driven parsers; analysis at query-time is mostly bounded graph traversal plus a few cached scores.

### The underlying graph

- **Nodes** (`NodeFact`): one per metadata entity. Keyed by `(org_id, qualified_name)`. Stored in per-label SQLite tables (`_sfg_n_apexclass`, `_sfg_n_lwc`, `_sfg_n_customfield`, …) created lazily on first ingest.
- **Edges** (`EdgeFact`): typed relationships. Keyed by `(org_id, src_qname, dst_qname)` per rel-type table. Each edge table has a reverse-traversal index `(org_id, dst_qname)`.
- **Snapshots**: copy-on-snapshot into `_sfgraph_node_snapshots` / `_sfgraph_edge_snapshots`. Diff is set arithmetic over `qualified_name`.
- **Vectors**: 384-dim embeddings in `vec0(org_id PARTITION KEY, embedding float[384])`. KNN is `MATCH ? AND k = ?`, partition-pruned by org.

Everything is partition-keyed on `org_id`. Same-org queries never read another org's rows.

### Parser dispatch at ingest start

1. **`probeCapabilities()`** detects installed managed packages (Vlocity-CMT and the other 4 industry namespaces, OmniStudio-on-Core, Agentforce, Experience Cloud, Source Tracking).
2. **`conn.metadata.describe(apiVersion)`** asks the org for its full supported type list.
3. The **dispatch table** maps each type to a fetch strategy:
   - `toolingSoql` for code metadata (Apex, LWC, Aura, StaticResource)
   - `metadataReadList` for XML configuration (Profile, Layout, Workflow, …)
   - `vlocityRunner` for legacy DataPacks (gated on `caps.vlocityLegacy`)
4. The **parser registry** routes each fetched record to either a code parser or a declarative rule. Unknown types fall through to a generic-opaque rule.

### Live sync algorithm

1. **Auth** via `@salesforce/core` from `~/.sfdx/`. Connection is wrapped in `wrapConnectionReadOnly()`.
2. **Capability probe** — parallel `describe` calls.
3. **Discover metadata types** — `conn.metadata.describe(apiVersion)`.
4. **Load rule files** — `loadAllRules()` zod-validates and registers all `*.yml` in `parsers/rules/`.
5. **Build dispatch table** — per-type fetch strategy.
6. **Pre-sync snapshot** — `is_auto=true` snapshot; this is what `what_broke` looks back to.
7. **Decide mode** — incremental if `caps.sourceTracking && org.last_synced_at` exists, else full.
8. **Fan out across three pools** — toolingPool (5), metadataPool (10), dataPool (10). Each has its own 429+Retry-After handler.
9. **For each member** → parser → `mergeNodes` / `mergeEdges`. Content-hash short-circuit: unchanged records skip the write.
10. **Embedding queue (side-stream)** — push `{ qname, text }` per new node; queue batches 16-at-a-time and invokes transformers.js MiniLM. Vectors land in `vec0`.
11. **Cross-flavor resolver** — emits `CANONICAL_OF` edges between Vlocity ↔ OmniStudio duplicates.
12. **Populate analysis tables** — governor risks, dead-code scores, test coverage, security findings.
13. **Touch sync timestamp** and **drain embedding queue + prune snapshots**.

### Why this design is fast

- **Reverse-edge index** makes "who depends on X?" as cheap as "what does X depend on?".
- **Composite PKs partition every table by org_id** — SQLite range-scans only the rows for the org in question.
- **Content-hash short-circuit** on merge means no write amplification on unchanged metadata.
- **Cached analysis tables** turn governor / dead-code / security audits from full-table scans into single SELECTs.
- **vec0 partition key** prunes vector search to one org.

---

## What v1.0 brings over v0.x

- **Real MCP server** instead of a CLI-only Python tool — works natively with Claude Code, Cursor, and VS Code without shell-out tricks.
- **Multi-org** as a first-class concept — every row in storage is partitioned by `org_id`; cross-org diff is one graph query.
- **Typed semantic edges** (`READS_FIELD`, `CALLS_DR`, `INVOKES_REMOTE_ACTION`, `GRANTS_FIELD_ACCESS`, …) replace the v0 heuristic walker's generic `REFERENCES`. 88 typed relationship types now — full enum in `packages/core/src/domain/rel-types.ts`.
- **Snapshots + point-in-time diff** built into the storage layer.
- **Cross-flavor resolver** for Vlocity ↔ OmniStudio.
- **Capability-driven dispatch** — new metadata types ship with Salesforce releases and are picked up automatically.
- **Declarative rule engine** for parser authoring — adding support for a new type is a YAML file, not a Python module.
- **Vendored embedding model** (transformers.js + MiniLM-L6 ONNX) — v0 required a separate Qdrant / FastEmbed service.
