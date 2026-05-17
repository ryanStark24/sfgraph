# Requirements: sfgraph hardening + capability expansion

**Defined:** 2026-05-17
**Core Value:** Every edge in the graph carries enough provenance that "why does X depend on Y" is answerable from the data alone — and every ingest failure is loud, named, and recoverable.

## v1 Requirements

Requirements for this milestone. Categories follow the three-wave structure from PROJECT.md; IDs preserve the Wave numbering used throughout research and planning.

### Wave 1 — Foundation (close existing gaps)

- [ ] **W1-01**: Ingest emits structured warnings instead of silently swallowing failures — replace the three `catch {}` blocks at `extractors/live-org/vlocity/runner.ts:76,188,246` with logged warnings, and add `warnings: string[]` to `LiveIngestResult` so MCP consumers can see what was skipped
- [ ] **W1-02**: Every graph edge carries source location — add optional `sourceUri`, `line`, `column` fields to `EdgeFact` and thread `ctx.sourceUri` through `parsers/common.ts:30` (`makeEdge`) so every existing parser emits provenance without modification; intern source URIs via a `sources` FK table to prevent SQLite bloat
- [ ] **W1-03**: LWC HTML parser handles directive-based conditional rendering — add `lwc:if / lwc:elseif / lwc:else / lwc:for:each` directive handling to the parse5 visitor; emit USES edges for bound expressions inside conditionals
- [ ] **W1-04**: Apex arity resolver matches by argument types where statically determinable — when call-site args are typed locals or literals, resolve by `(name, arity, argTypes[])`; preserve `ambiguous: true` over-approximation edges alongside precise edges to avoid breaking existing YAML rules and `find_callers` consumers
- [ ] **W1-05**: Test classes and methods are identified by `@isTest` annotation, not filename — add `IS_TEST` boolean attribute on Apex class/method nodes derived from AST annotations
- [ ] **W1-06**: Self-description in README and marketing is accurate — correct timeout band (15–120s, not 60s), extractor inventory (11 typed + 21 rules + opaque-fallback, not 80), edge count (88), arity resolver shape (name+arity only, not name+arity+arg-type until W1-04 lands), and storage path (env-paths, not `~/.sfgraph/`)

### Wave 2a — Reliability and coverage (overlap detector, MCD, batching)

- [ ] **W2-01**: OmniStudio overlap detector identifies signature-divergent cross-flavor pairs — new pass `parsers/omnistudio/overlap-detector.ts` wired alongside `resolveCrossFlavor` at `live-ingest.ts:713`; computes shape signature (metadata.type + subType + sorted multiset of edge-type/target-type tuples with namespace prefixes stripped); annotates existing `CANONICAL_OF` edges with `signaturesMatch: boolean` and `divergencePoints: string[]`; excludes `CANONICAL_OF` pairs from its own input to prevent self-comparison; ships feature-flagged off by default (`disableOverlapDetect: true`)
- [ ] **W2-03**: MCD fast-path baseline extractor populates long-tail metadata — new extractor querying `MetadataComponentDependency` for Layouts, FieldSets, EmailTemplates, Tabs, Groups/Queues; per-type ID-range chunking handles the documented 2,000-row hard cap; every emitted edge tagged `attributes.source: 'mcd'`; orchestrated to run before parsed extractors so parsed edges overwrite on overlap
- [ ] **W2-04**: MCD gap-fills synthesize edge classes Salesforce silently omits — re-implement (do not copy AGPL source) the Happy Soup behaviors: lookup-field → target-object, picklist → GlobalValueSet, dependent-picklist → controlling-field; plus `isDynamicReference` heuristic (id === name → `attributes.dynamic: true`)
- [ ] **W2-05**: Tooling SOQL paths auto-rebatch on size limits — wrap all Tooling SOQL extractors with auto-rebatch on HTTP 414/431 and IN-clause sets exceeding 300 IDs; use the existing Bottleneck pools so concurrency stays bounded
- [ ] **W2-06**: `metadata.read` batches into composite subrequests of 25 before falling back to adaptive bisection — reduces RTT count baseline so bisection fires less often

### Wave 2b — OmniStudio retrieve()

- [ ] **W2-02**: OmniStudio-on-Core extracted via Metadata API `retrieve()` for full design-time fidelity — new extractor using `@salesforce/source-deploy-retrieve` for `OmniUiCard / OmniIntegrationProcedure / OmniDataTransform`; returns full XML envelope in addition to existing SOQL rows; capability-gated (only runs when org has retrieve permission, degrades to SOQL otherwise); implements async polling, 10k/24h org-wide quota guard, and 5k-component package.xml chunking; emits structured warnings via the W1-01 surface on quota exhaustion or partial retrieval

### Wave 3a — Rules and SARIF

- [ ] **W3-01**: All 21 YAML rule files conform to PMD-aligned schema — rename fields to `name / message / description / priority / externalInfoUrl / properties / example`; validated against a canonical PMD rule (recommend `EmptyCatchBlock`) before locking the schema
- [ ] **W3-02**: SARIF 2.1.0 emitter exports rule violations in GitHub-code-scanning-compatible format — hand-rolled emitter using `@types/sarif` with `ajv` validation; new MCP tool `export_sarif`; `physicalLocation` populated from W1-02 edge provenance; ajv validation runs in tests to catch malformed reports before GitHub silently rejects them

### Wave 3b — Tools and rename stability

- [ ] **W3-03**: Impact-flavored MCP tools surface `package.xml` as a `follow_up_tool` — verify or implement deployable manifest generation using `@salesforce/source-deploy-retrieve`; wire as follow-up on `impact_from_git_diff`, `trace_downstream`, and other dependency-impact tools
- [ ] **W3-04**: Glob-selector node lookup via new MCP tool `find_nodes` — accepts patterns like `apex.Class.Foo.*` or `salesforce.Flow.instance.Lead_*` using `picomatch`; SQLite-index-backed against `qualified_name`; no new storage
- [ ] **W3-05**: Renames don't break the call graph — persist `(orgId, serviceId) → qualifiedName` map in a new SQLite table; on ingest, when `serviceId` matches but `qualifiedName` differs, rewrite incoming edges to the new qname instead of delete+add; ships feature-flagged off by default with `sfgraph reset-elemid-map` escape hatch; composite-key schema must be correct on first commit (retrofitting is high cost)

## v2 Requirements

Deferred to a follow-up milestone — not in current roadmap.

### IDE distribution

- **IDE-01**: VS Code extension wrapping the MCP server as a code-action provider
- **IDE-02**: JetBrains plugin (parity with VS Code)

### Telemetry

- **TEL-01**: Per-extractor timing + capability-detection trace in `LiveIngestResult` (Downloads-style depth, beyond Wave 1's warnings field)
- **TEL-02**: Per-record hashing module independent of SourceMember (for sandboxes with unreliable source tracking)

### Cached standard library

- **LIB-01**: Ship JSON descriptors for standard SObjects (User, Profile, PermissionSet) so parsers run offline without `describe()` round-trips

## Out of Scope

Explicit exclusions with reasoning. Re-adding requires a new milestone, not a roadmap edit.

| Feature | Reason |
|---------|--------|
| Hosted/SaaS deployment | Local-only privacy posture is the single strongest commercial wedge vs Elements.cloud / Sherlock / Copado / Strongpoint. Architectural moat. |
| Two-way deploy (Salto-style `salto deploy`) | Multi-month rabbit hole; read-only proxy at `extractors/live-org/read-only-proxy.js` is correct architecture |
| Custom CQL/SQL DSL | Selectors (W3-04) + the existing 26 MCP tools are enough; let the LLM compose queries. CQL is too much surface for too little gain |
| Per-path symbolic execution (SFGE direction) | Source of SFGE's 15-minute traversal timeouts; pre-computed reachability + indexed lookups beats path expansion for interactive MCP loops |
| Regex-based Apex analysis (Happy Soup direction) | antlr4ts is the correct choice; even Happy Soup's maintainer commented out the regex SymbolTable path |
| Global atomic transaction wrapping merge + post-passes | Locks the DB for the entire 5-min ingest; existing per-resolver try/catch isolation is correct |
| JVM/Java rule API (SFGE direction) | Keep YAML; PMD alignment in W3-01 expands the schema rather than replacing the language |
| Real-time org-watching (push-driven incremental) | Polling via SourceMember is sufficient; push-driven requires Streaming API + maintained subscriber state |
| Full-text source code search | Vector search (existing) covers the semantic-similarity case; full-text would require a second index with different freshness semantics |
| Graph mutation API | Read-only is a load-bearing safety property; mutation would force a whole new auth/permission model |
| User-defined edge types at runtime | Edge type set is part of the schema; runtime extension complicates downstream consumers and SARIF mapping |

## Traceability

Filled in during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| W1-01 | Phase 1 | Pending |
| W1-02 | Phase 1 | Pending |
| W1-03 | Phase 1 | Pending |
| W1-04 | Phase 1 | Pending |
| W1-05 | Phase 1 | Pending |
| W1-06 | Phase 1 | Pending |
| W2-01 | Phase 2 | Pending |
| W2-03 | Phase 2 | Pending |
| W2-04 | Phase 2 | Pending |
| W2-05 | Phase 2 | Pending |
| W2-06 | Phase 2 | Pending |
| W2-02 | Phase 3 | Pending |
| W3-01 | Phase 4 | Pending |
| W3-02 | Phase 4 | Pending |
| W3-03 | Phase 5 | Pending |
| W3-04 | Phase 5 | Pending |
| W3-05 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 17 total
- Mapped to phases: 17
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-17*
*Last updated: 2026-05-17 after initial definition*
