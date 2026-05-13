# sfgraph v1 — Implementation Plan

> Status: Phase 0 + 1 complete in a previous sandbox session (now lost).
> Re-implementation needed on this branch. All decisions below are locked.

## Goals

1. **Live sync** — `sfgraph ingest --org <alias>` works against a real Salesforce org with no metadata-export prerequisite.
2. **Correct parsers** — typed semantic edges (`READS_FIELD`, `CALLS_DR`, …) for Apex, LWC, Flow, Vlocity DataPacks, native OmniStudio.
3. **Multi-org first-class** — `org_id` is a column on every node and edge; cross-org diff is one graph query.
4. **Hybrid retrieval** — property graph + vector index in the same SQLite file, partition-pruned by org.
5. **Skills + visuals** — agents reach the right tool from intent; tool responses include Mermaid diagrams that render in Cursor / Claude / VS Code.
6. **Local-only, read-only** — nothing leaves the user's machine; Salesforce APIs are runtime-verified read-only.
7. **Distribution that works** — npm package with vendored embedding model; `sfgraph install` wires Cursor / Claude / VS Code in one command.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Language | TypeScript only. Python preserved in `legacy/` until v1.0.0, then deleted. |
| 2 | Repo layout | pnpm workspace monorepo. `packages/*` + `apps/*` + `legacy/`. |
| 3 | Storage backend | `better-sqlite3` + `sqlite-vec`. Single file per org. |
| 4 | Mermaid in tool responses | On by default. Tools also return structured JSON. |
| 5 | Embedding model | `all-MiniLM-L6-v2` quantized, vendored via Git LFS in `@sfgraph/models`. |
| 6 | Test org | User provides; integration tests run locally, never in CI with credentials. |
| 7 | Package name | `sfgraph*` family on npm. Apps publish as `sfgraph` (unscoped). |
| 8 | Telemetry | Default off. Local sink in MVP; HTTP sink deferred. Failure-only, sanitized. |
| 9 | Snapshots | Snapshot-based time-travel. Auto pre-sync; manual checkpoints. 30-day retention. |
| 10 | Privacy | Read-only enforced via Proxy wrapper; sanitizer-allowlisted telemetry; zero codebase egress. |

## Architecture summary

```
MCP client (Cursor/Claude/VS Code)
        │ stdio JSON-RPC
        ▼
@sfgraph/mcp-server          ← stdio MCP, shutdown discipline, tool dispatch
        │ in-process
        ▼
@sfgraph/core                ← engine: storage, parsers, extractors, analyze, render
   ├─ storage/                  GraphStore + VectorStore + SnapshotStore (sqlite)
   ├─ extractors/               filesystem + live-org (jsforce, read-only proxy)
   ├─ parsers/                  per-type (apex, lwc, flow, vlocity, omnistudio, …)
   ├─ ingestion/                pipeline, piscina worker pool, hash short-circuit
   ├─ search/                   embedder + hybrid (vector → graph filter → re-rank)
   ├─ analyze/                  impact, test-gap, cross-layer, dead-code, what-broke
   └─ render/                   markdown + mermaid generators

@sfgraph/cli                 ← sfgraph install / ingest / snapshot / diff / telemetry
@sfgraph/models              ← vendored ONNX (LFS) + loader + checksum
@sfgraph/skills              ← SKILL.md playbooks + installer (Cursor / Claude)
@sfgraph/shared              ← cross-cutting: errors, logger, paths, config
```

## Phase plan

### Phase 0 — Scaffold (1 week)

**Exit gate:** `pnpm install && pnpm test && pnpm build` green on a fresh clone.

Deliverables:
- pnpm workspace, 7 packages stubbed (`shared`, `core`, `mcp-server`, `cli`, `skills`, `models`, `apps/sfgraph`)
- TS strict-mode config, Biome lint+format, Vitest, GitHub Actions CI
- Git LFS configured; `@sfgraph/models/data/` reserved for ONNX
- Read-only Salesforce connection Proxy stub (`packages/core/src/extractors/live-org/`)
- Telemetry scaffolding: `NullSink`, `LocalFileSink`, `Sanitizer` with 50+ adversarial tests
- `sfgraph --version` works

### Phase 1 — Storage, snapshots, freshness (2 weeks)

**Exit gate:** 50k synthetic nodes ingest + snapshot + diff in <5s.

Deliverables:
- `GraphStore` interface + SQLite impl; `(org_id, qualified_name)` composite PK
- `VectorStore` via `sqlite-vec`; partition-prune by `org_id`; node + bundle vectors
- `SnapshotStore` with snapshot/node_snapshots/edge_snapshots tables; copy-on-snapshot
- Migrations registry (`_sfgraph_schema_version`); pre-migration auto-backup
- Freshness columns on every node
- Orgs table

### Phase 2 — MVP parsers (2-3 weeks)

**Exit gate:** every parser passes golden fixtures; ≥30% more typed edges than legacy.

Apex (apex-parser), LWC (Babel+parse5), Flow (fast-xml-parser), Object/Field, 4 Vlocity hot types (DataRaptor, IntegrationProcedure, OmniScript, VlocityCard), 4 OmniStudio native (OmniProcess, OmniDataTransform, OmniUiCard, OmniIntegrationProcedure), 3 security (Profile, PermissionSet, SharingRule), 3 integration (NamedCredential, ExternalServiceRegistration, PlatformEvent). Cross-flavor resolver. piscina worker pool.

### Phase 3 — Live sync (2-3 weeks)

**Exit gate:** `sfgraph ingest --org <alias>` against a real org. 50K-node full sync <6 min; incremental <30s.

`@salesforce/core` auth + `jsforce` wrapped read-only; capability probe; bulk-retrieve; SourceMember polling.

### Phase 4 — Tools + render + visuals (2 weeks)

12 MCP tools incl. `what_broke`, `point_in_time_diff`, `freshness_report`. Mermaid render layer. Dual output (`{ summary, markdown, data, follow_up_tools }`).

### Phase 5 — Skills + installer + binary (1 week)

10 SKILL.md files; `sfgraph install` writes Cursor/Claude/VS Code MCP config; vendored MiniLM; npm publish workflow.

### Post-MVP (4-6 weeks → v1.0.0)

Long-tail metadata, pre-computed analysis tables, deployment manifest gen, QA + release.

## Privacy & security commitments

- **Read-only Salesforce APIs** — runtime Proxy on every jsforce connection throws `ReadOnlyViolationError` on writes. Lint + integration test back it up.
- **Local-only data** — graph DB, vectors, embedding model, logs all in `env-paths('sfgraph')`. No cloud, no remote backup.
- **Telemetry default off** — when on, sanitizer allowlists fields. Codebase content cannot be emitted. Failure-only events. Local sink in MVP.
- **No credentials in our process** — `@salesforce/core` reads `~/.sfdx/`; we never see passwords.

## Conventions

- One tool per file under `packages/mcp-server/src/tools/`. >200 LOC means analysis logic moves to `packages/core/src/analyze/`.
- One parser per metadata type under `packages/core/src/parsers/<category>/`. >300 LOC means decomposition.
- `packages/core/src/domain/` imports nothing except `@sfgraph/shared/types`. Lint-enforced.
- Every error has a stable `ErrorCode`; never grep error messages in callers.

## Companion docs

- Notion: sfgraph v1 — Architecture Design — https://www.notion.so/35fbb916ac3581539568fc1644abde4c
- Notion: sfgraph v1 — Low-Level Design — https://www.notion.so/35fbb916ac358179b4d6e784a2de151c