# Project Research Summary

**Project:** sfgraph hardening + capability expansion
**Domain:** Salesforce metadata graph + dependency analysis tooling (MCP-first, local-only)
**Researched:** 2026-05-17
**Confidence:** HIGH (architecture grounded in actual source reads with file:line citations; stack verified against live npm registry 2026-05-17; pitfalls code-verified; features grounded in PROJECT.md + competitive landscape)

## Executive Summary

sfgraph is a production Salesforce metadata dependency graph served as an MCP server. The existing codebase is architecturally sound — 26 tools, 88 typed edges, live-org ingest, async jobs, per-pool rate limiting, adaptive bisection, and a local-only privacy posture that no commercial competitor matches. This milestone is a brownfield hardening exercise, not a v1 build. The core value statement is precise and testable: every edge in the graph must carry source-location provenance, and every ingest failure must be loud, named, and recoverable. Everything in Waves 1, 2, and 3 is in service of that statement or directly enables CI/IDE adoption once the foundation is sound.

The build order is determined by a single structural fact confirmed independently by all four research streams: **W1-02 (edge provenance) is the keystone**. The SARIF emitter (W3-02) needs `physicalLocation` data. The overlap detector (W2-01) needs source coordinates to produce actionable findings. The `find_nodes` tool (W3-04) needs location fields on results to be useful in CI. Slipping W1-02 cascades across both later waves. W1-01 (silence-to-warnings) must land in the same push as W1-02 because the overlap detector also requires a `warnings` channel to surface skipped candidates. These two items are the non-negotiable foundation; everything else stacks on top in a dependency-topological order that is consistent across all three non-stack research files.

The three critical risks to manage are: (1) **schema decisions on first commit are effectively irreversible** — sourceUri interning via a `sources` table FK must ship with W1-02, not as a follow-up, because retrofitting costs a full re-ingest migration; (2) **W2-01 (overlap detector) and W3-05 (ElemID rename) must ship feature-flagged off** with escape hatches (`disableOverlapDetect: true` default; `sfgraph reset-elemid-map <orgId>`) because false-positive graph corruption is harder to recover from than a missing feature; (3) **MCD's 2,000-row hard cap has no OFFSET workaround** — per-type chunking must ship in the first cut of W2-03, not as a follow-up, or large orgs silently lose edges with no error signal.

---

## Key Findings

### Recommended Stack

The existing stack (TypeScript / Node 20+ / apex-parser / Babel / parse5 / fast-xml-parser / better-sqlite3 / sqlite-vec / Bottleneck / jsforce / @salesforce/core) is locked. New dependencies are minimal and purposeful. The dominant new addition is `@salesforce/source-deploy-retrieve@^12.35.10` — the official Salesforce CLI metadata retrieval library — which serves both W2-02 (OmniStudio retrieve extractor) and W3-03 (package.xml generation): one install that pays for two wave items. Beyond that, `picomatch@^4.0.4` is the right choice for W3-04's in-memory glob matching (engine under micromatch, verified on npm 2026-05-17; fast-glob is filesystem-oriented and wrong here). SARIF emission should be hand-rolled using `@types/sarif@^2.1.7` (type-only, zero runtime cost) with `ajv@^8.20.0` in devDependencies for CI validation. The existing `yaml` and `zod` packages handle W3-01 with no new dependencies. Stay on Zod 3; Zod 4 migration is deferred to a dedicated milestone. Total new runtime dependencies: 2.

**Core new technologies:**

- `@salesforce/source-deploy-retrieve@^12.35.10` — Metadata API retrieve(), ZIP unpacking, package.xml generation — officially maintained, daily releases, same lineage as `sf project retrieve`. Serves W2-02 and W3-03.
- `picomatch@^4.0.4` — Single-pattern glob matching for `find_nodes` (W3-04) — fastest in-memory matcher in the Node ecosystem; avoids filesystem-walker shape of fast-glob.
- `@types/sarif@^2.1.7` (devDep) — TypeScript types for SARIF 2.1.0 objects; avoids string-concatenation SARIF construction. Matches Microsoft's own interfaces.
- `ajv@^8.20.0` (devDep) — Validate emitted SARIF against OASIS schema in CI; catches malformed output before GitHub silently rejects it.

**Do NOT add:** jsforce-metadata-tools (unmaintained since 2022), sarif-builder (does not exist on npm), fast-glob (filesystem walker, wrong shape), adm-zip (synchronous FS-coupled API), micromatch (use picomatch directly), Zod 4 (save for dedicated migration). Do NOT vendor Happy Soup TypeScript source — original is AGPL-3.0, this fork is Apache-2.0; re-implement from documented behavior only.

---

### Expected Features

**Must have (table stakes — closes gaps vs Happy Soup, Salto, sfdx-scanner):**

- Edge source-location provenance (file/line/column) — Salto NaCl carries it; SARIF consumers require it; currently absent on every EdgeFact. **(W1-02)**
- Silent failure surface — every competitor logs failures; the current `catch {}` pattern is production-unfit for CI. **(W1-01)**
- LWC `lwc:if/elseif/else/for:each` directive extraction — Salto and Elements.cloud cover this; current graph misses conditional dependencies. **(W1-03)**
- MCD long-tail coverage (Layouts, FieldSets, EmailTemplates, Tabs, Groups/Queues) — Happy Soup's main selling point; currently absent. **(W2-03 + W2-04)**
- Tooling SOQL auto-rebatch on HTTP 414/431 — operational gap that users at scale hit regularly. **(W2-05)**
- Composite-subrequest batching for metadata.read — 10x ingest speed improvement available for free. **(W2-06)**
- SARIF 2.1.0 output — GitHub code-scanning, sfdx-scanner v3+, and CodeScan all consume it; CI-adoption gate. **(W3-02)**
- `package.xml` generator wired as `follow_up_tool` — every commercial deploy tool ships this; the generator exists but is not wired. **(W3-03)**
- PMD-compatible rule schema — enables bidirectional portability with PMD-Apex rules. **(W3-01)**
- `IS_TEST` from annotation (not filename) — accuracy gap that breaks deploy impact sets. **(W1-05)**
- README correctness — trust gap; misrepresented capabilities cause abandonment. **(W1-06)**
- Rename stability across ingests — Salto's ElemID model is their headline differentiator; sfgraph currently delete+adds. **(W3-05)**

**Should have (differentiators — widens the moat):**

- OmniStudio overlap detector — no competitor does cross-flavor (CMT-to-core) signature-mismatch detection; Vlocity migration story. **(W2-01)**
- `retrieve()`-based OmniStudio extractor — SOQL misses design-time fields; retrieve() gets full XML envelope. **(W2-02)**
- `find_nodes` glob selector — Salto NaCl selectors are a known UX win; LLMs need pattern-based queries. **(W3-04)**
- Tightened Apex arity resolver — reduces `ambiguous: true` over-approximation; precision differentiates from regex tools. **(W1-04)**
- `attributes.source: 'mcd' | 'parsed'` tagging — marks edge fidelity; combined MCD speed + parser fidelity is best-of-both. **(W2-03)**

**Defer to next milestone:**

- VS Code / JetBrains IDE extensions — SARIF is the correct interop layer first; extensions consume it after.
- Two-way deploy (Salto-style) — read-only is a feature; sf-CLI handles deploy.
- Hosted/SaaS deployment — destroys the strongest commercial wedge.
- Custom CQL/SQL DSL — MCP tool composition + glob selectors covers the use case.
- Per-path symbolic execution — source of SFGE's 15-minute timeouts.

---

### Architecture Approach

The architecture is a four-stage ingest pipeline (Extract -> Parse -> Merge -> Post-merge resolve) with a read-only MCP server above it. All additions slot into the existing pattern without restructuring. New extractors (W2-02, W2-03) slot into `extractors/live-org/extractors/` and yield the same `RawMember` shape the merge stage already consumes. New post-merge resolver passes (W2-01, W2-04) follow the canonical shape established by `cross-flavor-resolver.ts` — `(store, opts) -> Result`, per-pass `store.transaction()`, caller wraps in `try/catch`, result field additive on `LiveIngestResult`. New MCP tools (W3-02, W3-04) follow the existing `{summary, markdown, data, follow_up_tools}` envelope.

**Major components and Wave additions:**

1. **`ingest/live-ingest.ts` (orchestrator)** — wires W2-01 as 5th post-merge pass at line ~713; adds `warnings: string[]` and `overlapEdges: number` to `LiveIngestResult`.
2. **`domain/edge-fact.ts` (shared interface)** — W1-02 adds optional `sourceUri?/line?/column?`; sourceUri interned via `sources` table FK in SQLite from first commit.
3. **`parsers/common.ts:30` (`makeEdge`)** — W1-02's surgical site; currently drops `ctx.sourceUri` (verified by code read); fix mirrors what `makeNode` already does 10 lines earlier.
4. **`extractors/live-org/vlocity/runner.ts`** — W1-01: replace catch sites at lines 76, 188, 246; classify errors before logging; aggregate per `(vdpType, namespace, errorClass)` tuple.
5. **`parsers/omnistudio/overlap-detector.ts`** (NEW) — W2-01; mirrors `cross-flavor-resolver.ts` shape exactly; `disableOverlapDetect: true` default.
6. **`extractors/live-org/extractors/omnistudio-retrieve.ts`** (NEW) — W2-02; capability-gated; SOQL fallback; never blocks synchronous ingest path; async ingest job integration.
7. **`extractors/live-org/extractors/mcd-baseline.ts`** (NEW) — W2-03; per-type chunked queries; `mcdQueriedAt` timestamp; `source: 'mcd'` tag; parsed wins on overlap in merge stage.
8. **`render/sarif.ts`** (NEW) — W3-02; hand-rolled emitter using `@types/sarif` typed object literals; `ajv` validates at emit time; GitHub-subset compliance.
9. **`query/glob-selector.ts`** (NEW) — W3-04; `picomatch` single-pattern matching against `qualifiedName`; implicit `version=latest` filter on Flow instances; hard cap 500 results.

**Key patterns to follow (not invent around):**

- Post-merge pass shape: `(store, {orgId, ctx}) -> Result`; per-pass `store.transaction()`; disable flag in opts; result field additive on `LiveIngestResult`.
- Additive interface evolution: new fields on `EdgeFact`/`LiveIngestResult` are optional; never rename existing fields.
- Capability-gated extractor: check `caps.<flag>` first; fall back gracefully; merge stage stays agnostic to extractor source.

---

### Critical Pitfalls

All 8 critical pitfalls in PITFALLS.md are code-verified. Top 5 most likely to cause milestone failure:

1. **W1-02 sourceUri inline storage causes SQLite bloat** — Storing `sourceUri` as a string column on every EdgeFact row duplicates ~80 bytes across millions of edges. Prevention: intern via `sources(id, uri)` table + INTEGER FK on EdgeFact from the first commit. Acceptance criterion: SQLite file size grows <20% on largest test fixture. This decision is irreversible-cheap-to-get-right, expensive-to-fix-after-shipping.

2. **MCD 2,000-row hard cap with no OFFSET workaround** — Querying `MetadataComponentDependency` without per-type filtering silently drops rows beyond 2,000; no error is raised. Prevention: per-type chunking from day 1; detect overflow when `records.length === 2000` and recurse with tighter filter. Shipping W2-03 without this violates the milestone's core value — it is invisible data loss.

3. **W1-04 arity resolver precision drops edges downstream consumers depend on** — W1-04 is a semantics shift, not a bug fix. The existing `ambiguous: true` over-approximation is intentional for rules and vector search re-ranking. Prevention: keep `ambiguous: true` edges alongside new precise edges; add `attributes.resolved: 'exact' | 'ambiguous'`; verify 21 YAML rule golden outputs are unchanged after W1-04.

4. **W2-01 overlap detector emits false-positive OVERLAPS_WITH edges** — Signature comparison must include `PropertySet` JSON hashes and element order. Prevention: `disableOverlapDetect: true` default; emit overlap as a similarity score (0..1), not a binary edge; exclude `CANONICAL_OF` pairs; manual spot-check requiring >70% true-positive rate before enabling by default.

5. **W3-02 SARIF silently rejected by GitHub Code Scanning** — GitHub returns HTTP 200 on upload but sets `processing_status: 'failed'` retrievable only via a second API call. Prevention: `ajv` validation at emit time against OASIS schema; round-trip test via upload to a test GitHub repo; every `ruleId` in `results[]` must exist in `rules[]`; repo-relative URIs only; `level` must be in `{none, note, warning, error}`.

Additional pitfalls requiring attention: W3-05 ElemID composite-key collision (must key by `(orgId, namespace, serviceId, componentType)`, not `serviceId` alone); W2-02 Metadata API retrieve() blocking ingest pipeline (must be async job; 10,000-call/24h org quota).

---

## Implications for Roadmap

The build-order spine is consistent across all three non-stack research files and is determined by hard data dependencies, not preference. The recommended structure is **5 phases** corresponding to Wave 1 (1 phase) + Wave 2 (2 phases) + Wave 3 (2 phases). Wave 2 splits because W2-02 is 2-3x the size of any other item and has distinct Metadata API risk; isolating it protects the rest of Wave 2 from its schedule variance. Wave 3 splits because W3-01 must strictly precede W3-02 (double-work if reversed), while W3-03/04/05 are independent.

---

### Phase 1: Foundation (Wave 1 — in-place fixes)

**Rationale:** W1-01 and W1-02 are structural prerequisites for the entire milestone. Every downstream feature that needs to report "where" (overlap detector, SARIF, find_nodes) is blocked without edge provenance. W1-03/04/05/06 are independent and can parallelize with W1-01/02 but must all land before Wave 2 starts.

**Delivers:** Graph where every edge optionally carries `(sourceUri, line, column)`; every ingest failure surfaces to `LiveIngestResult.warnings` with structured `{stage, code, message, count}` shape; LWC conditional/loop edges extracted; Apex arity precise with ambiguous fallback preserved; test classes annotation-identified; README accurate.

**Addresses:** W1-01, W1-02, W1-03, W1-04, W1-05, W1-06.

**Avoids:**
- Edge provenance bloat: intern `sourceUri` via `sources` table FK from first commit.
- Log explosion from W1-01: classify errors before logging; aggregate per `(vdpType, namespace, errorClass)` tuple; cap `warnings[]` at 200 with `warningsTruncated` flag.
- Arity precision dropping downstream edges: preserve `ambiguous: true` edges; verify 21 YAML rule golden outputs unchanged.

**Schema decisions that are irreversible:** W1-02 EdgeFact shape (`sources` table interning). Must be right on first commit.

**Research flags:** None — all changes are surgical fixes to verified code locations. Architecture research provides exact file/line targets. Skip `/gsd:research-phase`.

---

### Phase 2: Capability gaps — reliability and coverage (Wave 2a: W2-01, W2-03, W2-04, W2-05, W2-06)

**Rationale:** These five items share no inter-dependency with W2-02 and can begin immediately after Phase 1. W2-01 (overlap detector) is highest-leverage (1.5d in plan per PROJECT.md) and benefits from W1-01 warnings + W1-02 provenance being in place. W2-03 must precede W2-04. W2-05 and W2-06 should land before W2-02 so the retrieve() extractor at scale inherits them. Scheduling `@salesforce/source-deploy-retrieve` in the next phase keeps this phase's dependency surface minimal.

**Delivers:** OmniStudio overlap detection (feature-flagged off by default); MCD fast-path for long-tail metadata with per-type chunking, freshness timestamps, and source tagging; Happy Soup gap-fills for lookup/value-set/controlling-picklist edges (re-implemented, not vendored); Tooling SOQL auto-rebatcher for HTTP 414/431; composite-subrequest batching of 25 for metadata.read.

**Addresses:** W2-01, W2-03, W2-04, W2-05, W2-06.

**Avoids:**
- Overlap false positives: `disableOverlapDetect: true` default; similarity score on edge attributes; exclude `CANONICAL_OF` pairs; include `PropertySet` hash in signature.
- MCD silent truncation: per-type chunking; `records.length === 2000` overflow detection; `mcdQueriedAt` freshness annotation.
- Rebatcher infinite recursion: depth cap at 4 levels; per-ID fallback on exhaustion.
- Composite partial-success: inspect each subrequest's `httpStatusCode` independently.
- AGPL license contamination: re-implement Happy Soup gap-fills from documented behavior; zero source copy-paste.

**Research flags:** W2-01 signature schema design warrants a short spike before implementation to verify which `PropertySet` JSON fields vary semantically between OmniStudio process types. All other items follow well-documented patterns.

---

### Phase 3: Capability gaps — OmniStudio retrieve() extractor (Wave 2b: W2-02)

**Rationale:** W2-02 is the largest single item in the milestone. It has distinct risks (Metadata API async semantics, 10k/24h quota, 5,000-component-per-package.xml limit) best managed after Wave 2a's reliability plumbing is stable. W2-05 and W2-06 being in place means the retrieve extractor at scale immediately inherits them. Async ingest job infrastructure being battle-tested through Phase 2 reduces the risk of W2-02's async-poll pattern introducing a new failure mode.

**Delivers:** Full XML envelope extraction for OmniStudio-on-Core; design-time fields invisible to SOQL are now in the graph; capability-gated with SOQL fallback; never blocks synchronous ingest path.

**Uses:** `@salesforce/source-deploy-retrieve@^12.35.10` (first introduction); `jszip@^3.10.1` as optional fallback.

**Addresses:** W2-02.

**Avoids:**
- Quota exhaustion: track `metadataRetrievesUsedToday`; reject retrieve path when within 10% of 10k/24h limit; check `Sforce-Limit-Info` response header.
- Pipeline blocking: retrieve() as async ingest job; polling backoff 5s to 60s, max 30 min.
- Package.xml oversize: chunk manifests at <2,000 components per retrieve.

**Research flags:** Validate `Sforce-Limit-Info` header behavior against a real OmniStudio-on-Core sandbox before committing to the quota guard implementation. A local spike is recommended.

---

### Phase 4: Distribution and interop — rules + SARIF (Wave 3a: W3-01, W3-02)

**Rationale:** W3-01 must strictly precede W3-02. The SARIF emitter maps `runs[].tool.driver.rules[]` 1:1 to PMD rule fields; building the emitter before renaming rules requires double-work. W3-02 also hard-depends on W1-02 being in place (edge `sourceUri/line/column` feeds SARIF `physicalLocation`), which was delivered in Phase 1.

**Delivers:** All 21 YAML rule files renamed to PMD-aligned field names via migration script; Zod schema validator enforcing new shape in CI; `render/sarif.ts` SARIF 2.1.0 emitter; new MCP tool `export_sarif`; ajv validation at emit time; GitHub code-scanning compatible output.

**Uses:** `yaml` + `zod` (existing); `@types/sarif@^2.1.7` (devDep); `ajv@^8.20.0` (devDep).

**Addresses:** W3-01, W3-02.

**Avoids:**
- SARIF silent rejection by GitHub: `ajv` validation at emit time; every `ruleId` in `results[]` must exist in `rules[]`; `physicalLocation` required; repo-relative URIs only; `level` in `{none, note, warning, error}`.
- PMD field shadowing: one-commit migration script across all 21 files; CI schema validator; `legacy_*` aliases for one release cycle.
- SARIF response size: emit to file; MCP response returns path, not inline document.

**Research flags:** Validate PMD canonical field list against the `EmptyCatchBlock` rule before writing the migration script (MEDIUM-HIGH confidence flag in Stack research). Round-trip upload to a test GitHub repo is required acceptance criterion for W3-02.

---

### Phase 5: Distribution and interop — tools + rename stability (Wave 3b: W3-03, W3-04, W3-05)

**Rationale:** W3-03, W3-04, and W3-05 are independent of each other and of Phase 4. W3-05 is isolated last because it has the largest persistence-layer surface area — a wrong composite key causes graph corruption that is hard to recover from. W3-05 is also the designated slip candidate if Phase 4 overruns. `@salesforce/source-deploy-retrieve` is already installed from Phase 3; W3-03 uses it for free.

**Delivers:** `package.xml` generator wired as `follow_up_tool` on every impact-flavored MCP tool; `find_nodes` glob selector MCP tool; ElemID rename stability with `(orgId, namespace, serviceId, componentType)` composite key; `sfgraph reset-elemid-map <orgId>` escape hatch.

**Uses:** `picomatch@^4.0.4` (new runtime dep); `@salesforce/source-deploy-retrieve` (already installed) for W3-03.

**Addresses:** W3-03, W3-04, W3-05.

**Avoids:**
- ElemID composite-key collision: key by `(orgId, namespace, serviceId, componentType)` — never by `serviceId` alone; detect collision, log warning, skip rewrite, fall back to delete+add.
- W3-05 ships feature-flagged off by default until validated against managed-package fixture.
- Glob over-collection: implicit `version=latest` filter on Flow-instance globs; hard cap 500 results with `truncated: true`.
- SQL injection via glob: parse glob into AST via picomatch; emit parameterized SQLite queries only.

**Research flags:** W3-05 ElemID semantics across managed namespaces and sandbox refreshes are MEDIUM confidence. Validate with a managed-package fixture before enabling by default.

---

### Phase Ordering Rationale

- **W1-02 first above all else:** Architecture research confirms `makeEdge` at `parsers/common.ts:30` currently discards `ctx.sourceUri` while `makeNode` 10 lines earlier preserves it. This single bug blocks SARIF's `physicalLocation`, the overlap detector's source coordinates, and find_nodes location output. Every Wave 2/3 feature that needs "where" is blocked until W1-02 lands.
- **W2-02 isolated in Phase 3:** It is 2-3x the size of any other individual item and has distinct Metadata API risk (quota, async polling, chunking). Isolation protects the rest of Wave 2 from its schedule variance.
- **W3-01 strictly before W3-02:** Confirmed independently by all three non-stack research files. Double-work if reversed.
- **W3-05 last:** Largest persistence-layer surface area; designated slip candidate. Graph corruption from a wrong composite key is costly to recover from.
- **Shared dep scheduling:** `@salesforce/source-deploy-retrieve` introduced once in Phase 3, reused for free in Phase 5. No install coordination needed.

---

### Research Flags

**Phases needing deeper research during planning:**

- **Phase 2 (W2-01 overlap detector):** Signature schema design — specifically which `PropertySet` JSON fields vary semantically between OmniStudio process types and how to hash them. Requires access to a real CMT-to-Core migration fixture. Short spike recommended before implementation.
- **Phase 3 (W2-02 retrieve() extractor):** Validate against an OmniStudio-on-Core sandbox before committing to the async-job integration design. The `Sforce-Limit-Info` header behavior and 5,000-component limit should be empirically confirmed.
- **Phase 4 (W3-01 PMD schema):** Validate PMD canonical field list against the `EmptyCatchBlock` canonical rule before locking the migration script. Stack research rates this MEDIUM-HIGH and flags it explicitly.

**Phases with standard patterns (skip `/gsd:research-phase`):**

- **Phase 1 (Wave 1):** All changes are surgical fixes to verified code locations with exact file/line citations. No unknowns.
- **Phase 2 (W2-03, W2-04, W2-05, W2-06):** MCD Tooling SOQL patterns, composite batching, and auto-rebatcher all follow established patterns already in the codebase.
- **Phase 4 (W3-02 SARIF):** SARIF 2.1.0 Errata 01 is an OASIS standard (verified). Hand-rolled emitter with `@types/sarif` is the pattern Microsoft uses internally.
- **Phase 5 (W3-03, W3-04):** Package.xml generation via SDR and find_nodes via picomatch are both documented library use cases with no unknowns.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | npm versions verified live against registry on 2026-05-17. SARIF 2.1.0 spec verified at OASIS. SDR verified at github.com/forcedotcom/source-deploy-retrieve. One MEDIUM-HIGH flag: PMD field list synthesized from docs pages, not from XML schema directly — validate before locking W3-01. |
| Features | HIGH | Feature classification grounded in PROJECT.md Validated + Active + Out-of-Scope sections (HIGH confidence source). Competitor capability claims are MEDIUM (public docs, marketing-grade for commercial tools) but directionally correct and internally consistent with competitive analyses referenced in PROJECT.md. |
| Architecture | HIGH | Every claim in Architecture research is grounded in an actual code read with file:line citations verified at research time. Integration patterns are code-confirmed, not inferred. Highest-confidence research file. |
| Pitfalls | HIGH | All 8 critical pitfalls are code-verified against `packages/core/src`. MCD 2,000-row cap and Metadata API quota are vendor-documented. SARIF GitHub rejection behavior is documented in OASIS spec + GitHub docs. W3-05 managed-namespace ID semantics rated MEDIUM (CTA-domain knowledge, not single-source). |

**Overall confidence: HIGH**

### Gaps to Address During Implementation

- **PMD field enumeration:** Validate `name / message / description / priority / externalInfoUrl / properties / example` against a canonical PMD rule (e.g. `EmptyCatchBlock` at pmd-code.org) before writing the W3-01 migration script.
- **OmniStudio PropertySet schema:** The exact structure of PropertySet JSON blobs across OmniScript, IntegrationProcedure, DataRaptor, and FlexCard process types needs to be verified against a real CMT fixture before implementing the W2-01 signature hash.
- **MCD type coverage matrix:** Salesforce does not publish a complete list of which metadata types MCD covers vs does not cover. The research flags known gaps at MEDIUM confidence (community-validated) — empirically confirm during W2-03 implementation.
- **Metadata API quota header format:** `Sforce-Limit-Info` header behavior for the Metadata API (vs REST API) should be confirmed against a real org response before the W2-02 quota guard is implemented.

---

## Sources

### Primary (HIGH confidence)

- `/Users/anshulmehta/Documents/salesforceMCP/.planning/PROJECT.md` — milestone scope, key decisions, validated capabilities, constraints, out-of-scope items
- `packages/core/src/ingest/live-ingest.ts:680-809` — post-merge pass shape, atomicity decision in code, resolver integration points
- `packages/core/src/parsers/common.ts:10-47` — verified `makeEdge` drops `ctx.sourceUri` while `makeNode` preserves it
- `packages/core/src/domain/edge-fact.ts` — current 12-line EdgeFact interface, no provenance fields
- `packages/core/src/extractors/live-org/vlocity/runner.ts:76, 188, 246` — three verified silent catch sites
- `packages/core/src/parsers/lwc/html-visitor.ts` — verified zero `lwc:if|lwc:for|lwc:else` handling
- `packages/core/src/parsers/contract.ts:7` — ParseContext already has `sourceUri` typed
- `packages/core/src/parsers/cross-flavor-resolver.ts` — reference shape for all new post-merge passes
- OASIS SARIF 2.1.0 Errata 01 — `https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html` (verified 2023-08-28 publication)
- `github.com/forcedotcom/source-deploy-retrieve` — retrieve(), package.xml gen, ZIP handling capabilities
- npm registry (live verification 2026-05-17) — `@salesforce/source-deploy-retrieve@12.35.10`, `picomatch@4.0.4`, `@types/sarif@2.1.7`, `ajv@8.20.0`, `jszip@3.10.1`
- Salesforce Platform Limits documentation — Metadata API 10,000 calls/24h; 5,000 components per package.xml
- Salesforce MetadataComponentDependency Tooling API documentation — 2,000-row limit; async refresh lag
- GitHub Code Scanning SARIF documentation — rule-ID consistency, physicalLocation requirement, level enum

### Secondary (MEDIUM confidence)

- Happy Soup (github.com/forcedotcom/dependencies-cli / happysoup.io) — MCD-based, gap-fills behavior
- Salto (docs.salto.io) — NaCl format, ElemID model, retrieve()-based, selector patterns
- sfdx-scanner / SFGE (github.com/forcedotcom/sfdx-scanner) — SARIF output, PMD integration, path expansion timeouts
- PMD-Apex (pmd-code.org) — field enumeration synthesized from rule reference pages (validate against canonical XML schema before locking W3-01)
- Salesforce ID semantics across managed namespaces and sandbox refreshes — CTA domain knowledge, well-known but not single-source documented

### Tertiary (LOW confidence)

- Elements.cloud / Strongpoint / Sherlock / CodeScan / Clayton / Gearset / Copado — vendor marketing pages; feature parity claims are directional only

---
*Research completed: 2026-05-17*
*Ready for roadmap: yes*
