# sfgraph hardening + capability expansion

## What This Is

A fork of `@ryanstark24/sfgraph` (an MCP-first Salesforce metadata graph + analysis toolkit) hardened for production use against hybrid Vlocity-CMT + OmniStudio-on-Core orgs. The monorepo at `packages/{core,cli,mcp-server,models,shared,skills,web}` is the source of truth — upstream is the npm publication; this repo is where shipped changes live. The goal of this milestone is to close documented silent-failure and provenance gaps, expand ingestion fidelity for OmniStudio/Vlocity migrations, and add the interop surface (SARIF, glob selectors, `package.xml` output) needed to make sfgraph adoptable in CI and IDE workflows alongside sfdx-scanner, CodeScan, and Clayton.

## Core Value

**Every edge in the graph carries enough provenance that "why does X depend on Y" is answerable from the data alone — and every ingest failure is loud, named, and recoverable.** Everything else (MCD fast-path, SARIF, overlap detector, package.xml) is in service of this. If a feature lands but ingest still silently swallows schema drift or edges still can't cite source location, the milestone has failed regardless of feature count.

## Requirements

### Validated

<!-- Existing sfgraph capabilities inferred from the installed code (packages/core/src) and competitive analysis. These are locked. -->

- ✓ 26 MCP tools with `{summary, markdown, data, follow_up_tools}` response shape — existing
- ✓ 88 typed edge relationships in `domain/rel-types.ts` — existing
- ✓ Per-pool Bottleneck rate limiting (Tooling/Metadata/Data) with retry-after and liveness probe — existing
- ✓ Adaptive metadata.read bisection (`MAX_BISECT_DEPTH=6`) — existing
- ✓ Sliding-window async-iterator merge with default 12 in-flight — existing
- ✓ Async ingest jobs (fire-and-forget, pollable via `get_ingest_job`) — existing
- ✓ Per-org SQLite via `env-paths` (`~/Library/Application Support/sfgraph/<orgId>.sqlite` on macOS) — existing
- ✓ Read-only org connection proxy enforcing no DML — existing
- ✓ Vector search via `sqlite-vec` (384-dim MiniLM-L6 embeddings, KNN partitioned by org) — existing
- ✓ Cross-flavor CMT↔core canonical resolver emitting `CANONICAL_OF` edges — existing
- ✓ Apex parsing via `apex-parser` (antlr4ts), LWC JS via Babel, LWC HTML via parse5, Flow via fast-xml-parser — existing
- ✓ Four Vlocity JSON parsers (DataRaptor, IntegrationProcedure, OmniScript, VlocityCard) — existing
- ✓ Snapshot/point-in-time tools, multi-org orchestrator, WIP/git-diff toolset, GenAI/Agentforce extractors — existing
- ✓ Local web visualizer at `localhost:7777` (3d-force-graph + three.js) — existing
- ✓ 21 declarative YAML rule files — existing
- ✓ sf-CLI delegation auth via `@salesforce/core` — existing

### Active

<!-- This milestone's scope. Three waves, organized by leverage-per-risk. -->

**Wave 1 — In-place fixes (close existing gaps, no new features):**
- [ ] **W1-01**: Replace silent `catch {}` blocks at `extractors/live-org/vlocity/runner.ts:76,188,246` with logged warnings; surface `warnings: string[]` on `LiveIngestResult`
- [ ] **W1-02**: Add `sourceUri?: string; line?: number; column?: number` to `EdgeFact`; thread context through every parser's edge emission
- [ ] **W1-03**: Add `lwc:if / lwc:elseif / lwc:else / lwc:for:each` directive handling to LWC HTML visitor; emit USES edges for bound expressions inside conditionals
- [ ] **W1-04**: Tighten Apex arity resolver to match by `(name, arity, argTypes[])` where call-site args are typed locals or literals; fall back to `ambiguous: true` only when statically undeterminable
- [ ] **W1-05**: Add `IS_TEST` attribute on Apex class/method nodes (from `@isTest` annotation, not filename)
- [ ] **W1-06**: Correct self-description in README/marketing per analysis (timeout band 15–120s, 11 typed extractors + 21 rules + fallback, 88 edges, name+arity resolver, env-paths storage location)

**Wave 2 — Capability gaps (port + new features):**
- [ ] **W2-01**: Port OmniStudio overlap detector to `parsers/omnistudio/overlap-detector.ts`; wire as 5th post-merge pass next to `resolveCrossFlavor` with `disableOverlapDetect?: boolean` flag and `overlapEdges` field on result
- [ ] **W2-02**: Port `retrieve()`-based OmniStudio-on-Core extractor to `extractors/live-org/extractors/omnistudio-retrieve.ts`; capability-gated, falls back to existing SOQL path; preserves full XML envelope for design-time fields invisible to SOQL
- [ ] **W2-03**: MCD fast-path baseline extractor for long-tail metadata (Layouts, FieldSets, EmailTemplates, Tabs, Groups/Queues) with `attributes.source: 'mcd' | 'parsed'` tagging; merge rule: parsed wins on overlap
- [ ] **W2-04**: Port Happy Soup MCD gap-fills (`createLookupFieldDependencies`, `createValueSetDependencies`, `createControllingPicklistDependencies`) and `isDynamicReference` heuristic
- [ ] **W2-05**: `tryWithSmallerQueries` auto-rebatcher for Tooling SOQL paths (HTTP 414/431 and >300 IN-clause IDs)
- [ ] **W2-06**: Composite-subrequest batching of 25 for `metadata.read` before adaptive bisection kicks in

**Wave 3 — Distribution and interop:**
- [ ] **W3-01**: PMD-aligned YAML rule schema rename (`name / message / description / priority / externalInfoUrl / properties / example`) across all 21 rule files
- [ ] **W3-02**: SARIF 2.1.0 emitter in `render/sarif.ts` + new MCP tool `export_sarif`
- [ ] **W3-03**: Verify and wire `package.xml` generator as `follow_up_tool` on every impact-flavored MCP tool
- [ ] **W3-04**: Glob-selector query tool `find_nodes` (e.g. `apex.Class.Foo.*`, `salesforce.Flow.instance.Lead_*`)
- [ ] **W3-05**: ElemID rename stability — persist `(orgId, serviceId) → qualifiedName` map; on ingest, rewrite edges on rename instead of delete+add

### Out of Scope

<!-- Explicit non-goals. Each has a reason so it doesn't get re-added later. -->

- **Hosted/SaaS deployment** — the local-only privacy posture is the single strongest commercial wedge vs Elements.cloud / Sherlock / Copado / Strongpoint. Don't give it up.
- **Two-way deploy (Salto-style `salto deploy`)** — multi-month rabbit hole, not the use case. The read-only proxy in `extractors/live-org/read-only-proxy.js` is correct architecture.
- **Custom CQL/SQL DSL** — selectors (W3-04) + the existing 26 MCP tools are enough; let the LLM compose queries. CQL is too much surface for too little gain.
- **Per-path symbolic execution (SFGE direction)** — source of SFGE's 15-minute traversal timeouts. For interactive MCP-loop targets (sub-second), pre-computed reachability + indexed lookups beats path expansion.
- **Regex-based Apex analysis (Happy Soup direction)** — antlr4ts is the correct choice; even Happy Soup's maintainer commented out the regex SymbolTable path.
- **Global atomic transaction wrapping merge + post-passes** — locks the DB for the entire 5-minute ingest, kills concurrent reads, doesn't pay for itself. The existing per-resolver try/catch isolation is correct.
- **JVM/Java rule API (SFGE direction)** — keep YAML; PMD alignment in W3-01 expands the schema rather than replacing the language.
- **VS Code / JetBrains IDE extensions** — deferred to next milestone. Worth doing, but Wave 1+2+3 is already 4-6 weeks. Land SARIF first; extensions consume it.

## Context

- **Two analyses already exist for this milestone**: a Vlocity/OmniStudio head-to-head (Downloads-vs-installed) and a five-tool competitive analysis (Happy Soup / Salto / SFGE+PMD / MCD / commercial). Both are the source-of-truth for scope; gaps and fixes were code-grounded against `packages/core/src`.
- **Three concrete gaps verified against actual code before milestone init**:
  1. `extractors/live-org/vlocity/runner.ts` — three silent `catch {}` blocks (lines 76, 188, 246), no logging, no warnings field.
  2. `domain/edge-fact.ts` — `EdgeFact` interface has no source location fields. Provenance lives in `ParseContext.sourceUri` at parse time and is discarded on emit.
  3. LWC HTML parser — no `lwc:if/elseif/else/for` directive handling in `parsers/lwc/`. Bound expressions inside conditionals are invisible to the graph.
- **Architectural strengths to preserve**: MCP-first response shape (no competitor has this); 88 typed edges (highest-fidelity dependency model in OSS); local-only privacy posture; live-org grounding via sf-CLI; production-hardened ingest pipeline (per-pool rate limiting, async jobs, adaptive bisection).
- **Largest threat surface**: Gearset has the distribution to weaponize an MCP server faster than anyone if they ship one. Salto/Strongpoint is the architecturally-closest competitor. Mitigation = ship SARIF + glob selectors + `package.xml` (Wave 3) before they wake up.
- **Brownfield status**: this monorepo has packages/core (TS source, NOT dist-only), apps/sfgraph, plus six adjacent packages (cli, mcp-server, models, shared, skills, web). All changes ship from packages/core/src.

## Constraints

- **Tech stack**: TypeScript / Node 20+, antlr4ts-based `apex-parser`, Babel for LWC JS, parse5 for LWC HTML, fast-xml-parser for Flow XML, better-sqlite3 for storage, `sqlite-vec` for embeddings, `@huggingface/transformers` MiniLM-L6 for vectors, Bottleneck for rate-limiting, `@salesforce/core` for auth — Don't introduce a parallel parser stack or alternative auth path.
- **Repo layout**: monorepo packages (`packages/core/src` is the canonical source). Cross-package changes require version-bump coordination across `sfgraph-core / sfgraph-server / sfgraph-cli / sfgraph-shared / sfgraph-skills / sfgraph-models / sfgraph-web` — Group related changes per wave to minimize fan-out commits.
- **Backwards compat**: Existing 26 MCP tool surfaces and `{summary, markdown, data, follow_up_tools}` shape are public API — Any change must be additive. New fields on `EdgeFact`/`LiveIngestResult` are OK; renamed/removed fields are not.
- **License surface**: Apache-2.0 (matches Downloads heritage); Happy Soup port (W2-04) is AGPL-3.0 in original — re-implement based on documented behavior, do NOT copy-paste source.
- **Timeline**: 4-6 weeks for all three waves. Week 1 = Wave 1; Weeks 2-3 = Wave 2; Week 4 = Wave 3.
- **Performance**: MCP tool responses must remain sub-second on warm graph. SARIF emission and overlap detection can be slower (one-shot exports / one-shot ingest passes).
- **No skipping pre-commit hooks** unless explicitly requested.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| This monorepo IS the fork | User confirmed — `packages/core/src` is source of truth. No upstream PR dependency, no wrapper-package complexity. | — Pending (validate by milestone end that releases ship from here) |
| Scope = all three waves in one milestone | User chose comprehensive scope. Higher milestone drift risk, but completes the resilient/faster/safer/better-results vision in one cycle. | — Pending |
| Primary pain = silent failures during ingest | User priority. W1-01 (silent catch) and W1-02 (edge provenance) get top priority within Wave 1. | — Pending |
| Wave 1 must land before Wave 2 | Edge provenance (W1-02) and warnings field (W1-01) are prerequisites for the overlap detector (W2-01) reporting which signature mismatches mattered. | — Pending |
| Sequencing inside Wave 2: 2.1 → 2.3 → 2.5 → 2.6 → 2.2 | Overlap detector first (highest leverage 1.5d in plan); OmniStudio retrieve() last (biggest piece, benefits from earlier provenance/warnings plumbing). | — Pending |
| PMD-aligned rule schema BEFORE SARIF emitter | SARIF mapping is trivial once rule fields are PMD-shaped; doing them out of order requires double-work. | — Pending |
| No global atomic transaction | Existing per-resolver try/catch isolation is already non-atomic; adding overlap detector doesn't make it worse, and full-ingest transaction would lock DB for 5+ min. | — Pending |

---
*Last updated: 2026-05-17 after initialization*
