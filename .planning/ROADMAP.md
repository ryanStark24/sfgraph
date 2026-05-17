# Roadmap: sfgraph hardening + capability expansion

**Created:** 2026-05-17
**Depth:** standard
**Core Value:** Every edge in the graph carries enough provenance that "why does X depend on Y" is answerable from the data alone — and every ingest failure is loud, named, and recoverable.
**Coverage:** 17 / 17 v1 requirements mapped

## Phases

- [ ] **Phase 1: Foundation** — Wave 1 in-place fixes: silent-failure surface, edge provenance, LWC directives, arity precision, IS_TEST annotation, README correctness
- [ ] **Phase 2: Reliability and coverage** — Wave 2a: overlap detector, MCD baseline + gap-fills, Tooling SOQL auto-rebatch, composite-25 batching
- [ ] **Phase 3: OmniStudio retrieve()** — Wave 2b: full XML envelope extraction for OmniStudio-on-Core, capability-gated with SOQL fallback
- [ ] **Phase 4: Rules + SARIF** — Wave 3a: PMD-aligned YAML rule schema, then SARIF 2.1.0 emitter wired to W1-02 provenance
- [ ] **Phase 5: Tools + rename stability** — Wave 3b: package.xml follow-up wiring, glob selector, ElemID rename stability (feature-flagged)

## Phase Details

### Phase 1: Foundation
**Goal**: Every graph edge carries source-location provenance, and every ingest failure surfaces as a structured, named warning rather than silently disappearing.
**Depends on**: Nothing (first phase)
**Requirements**: W1-01, W1-02, W1-03, W1-04, W1-05, W1-06
**Build order**: W1-01 + W1-02 land first as a paired PR (keystone for every downstream wave). W1-03 / W1-04 / W1-05 / W1-06 can parallelize after the paired PR merges.
**Schema decisions that are irreversible (must be right on first commit)**:
  - `EdgeFact.sourceUri` MUST be stored via a `sources(id, uri)` FK table — never inline per-edge string. Retrofitting requires full re-ingest migration.
  - `LiveIngestResult.warnings[]` MUST carry structured `{stage, code, message, count}` objects, capped at 200 entries with `warningsTruncated` flag — not raw strings.
  - `W1-04` MUST preserve existing `ambiguous: true` over-approximation edges alongside new precise edges via `attributes.resolved: 'exact' | 'ambiguous'`.
**Success Criteria** (what must be TRUE when this phase completes):
  1. Engineer running ingest against a Vlocity-CMT + managed-namespace org sees per-skipped-type structured warnings (`{stage, code, message, count}`) on `LiveIngestResult.warnings[]` rather than zero-output silence — including the three previously-swallowed sites at `vlocity/runner.ts:76,188,246`.
  2. Engineer querying any graph edge sees `sourceUri`, `line`, `column` populated whenever the originating parser had AST position information; SQLite file size grows <20% on the largest test fixture (verifies `sources` FK interning shipped correctly).
  3. Engineer inspecting an LWC component using `lwc:if` / `lwc:elseif` / `lwc:else` / `lwc:for:each` sees USES edges emitted for every identifier bound inside the conditional or loop expression.
  4. Engineer running `find_callers` on an overloaded Apex method sees both precise edges (`attributes.resolved: 'exact'`) where arguments are statically typed AND fallback `ambiguous: true` edges where they aren't — the 21 existing YAML rule golden outputs are unchanged.
  5. Engineer reading the README sees accurate self-description: 88 edges, 11 typed extractors + 21 rules + opaque-fallback, 15–120s timeout band, env-paths storage, name+arity+argTypes arity resolver.
**Plans**: TBD

### Phase 2: Reliability and coverage
**Goal**: Long-tail metadata coverage matches Happy Soup; Tooling SOQL paths are operationally robust at scale; cross-flavor OmniStudio overlaps are detected with explicit signature divergence reporting.
**Depends on**: Phase 1 (overlap detector needs warnings surface + edge provenance; without W1-01/W1-02, overlap findings are unactionable)
**Requirements**: W2-01, W2-03, W2-04, W2-05, W2-06
**Build order within phase**: W2-01 first (highest leverage, smallest surface — copy the verbatim shape from `parsers/cross-flavor-resolver.ts`). Then W2-05 + W2-06 in parallel (independent HTTP hardening). Then W2-03 → W2-04 (MCD baseline must precede gap-fills because gap-fills join across MCD-discovered long-tail nodes).
**Anti-features that MUST ship from day 1**:
  - `W2-01` ships feature-flagged off (`disableOverlapDetect: true` default). Overlap is emitted as a similarity score (0..1) plus `signatureMatch: 'exact' | 'structural' | 'lexical'` on edge attributes, NOT a binary OVERLAPS_WITH edge. Signature MUST include `PropertySet` JSON hashes; pairs already linked by `CANONICAL_OF` MUST be excluded from overlap input.
  - `W2-03` MUST handle MCD's documented 2,000-row hard cap via per-`(MetadataComponentType, RefMetadataComponentType)` chunking on first commit. Treat `records.length === 2000` as truncation signal and recurse with tighter filter. Stamp every MCD-sourced edge with `attributes.source: 'mcd'` and `attributes.mcdQueriedAt: <ISO>`; parsed wins on overlap.
  - `W2-04` MUST be re-implemented from documented Happy Soup behavior. Zero source copy-paste — original is AGPL-3.0, this fork is Apache-2.0.
  - `W2-05` rebatcher recursion capped at 4 levels with per-ID fallback on exhaustion.
  - `W2-06` composite batches inspect each subrequest's `httpStatusCode` independently — partial-success yields the successes, failures fall through to adaptive bisection.
**Success Criteria** (what must be TRUE when this phase completes):
  1. Architect comparing a CMT OmniProcess to its core counterpart sees signature-divergent pairs flagged with `similarity` score and `divergencePoints[]` separately from canonical matches — and `CANONICAL_OF` pairs never appear as overlap edges.
  2. Engineer ingesting a 10k+ component org sees Layouts, FieldSets, EmailTemplates, Tabs, and Groups/Queues populated in the graph with `attributes.source: 'mcd'` tags and `mcdQueriedAt` freshness stamps; no single MCD query returns exactly 2000 rows undetected.
  3. Engineer querying lookup fields, picklist value sets, and dependent picklists sees synthesized edges that Salesforce MCD silently omits (Happy Soup parity), with `attributes.dynamic: true` on `isDynamicReference` heuristic matches.
  4. Engineer running a Tooling SOQL extractor against a large IN-clause (>300 IDs) or oversized WHERE clause sees auto-bisection succeed within depth-4 recursion, with per-ID fallback as the floor; no HTTP 414/431 surfaces to the user.
  5. Engineer reviewing `metadata.read` traffic sees composite-subrequest batches of 25 issued before the adaptive bisection (`MAX_BISECT_DEPTH=6`) fires; partial-success in a batch yields successful subrequests and rebatches failures.
**Plans**: TBD

### Phase 3: OmniStudio retrieve()
**Goal**: OmniStudio-on-Core components extracted via Metadata API `retrieve()` for full design-time fidelity — without blocking the synchronous ingest path or exhausting org API quotas.
**Depends on**: Phase 1 (W2-02 surfaces quota/partial-retrieval failures via the W1-01 warnings channel). Independent of Phase 2 — can start in parallel as soon as Phase 1 lands, though battle-tested W2-05/W2-06 plumbing reduces W2-02 risk.
**Requirements**: W2-02
**Anti-features that MUST ship from day 1**:
  - Capability-gated: only runs when `connection.metadata` exists AND user has `ModifyMetadata` or `ModifyAllData`. Falls back to existing SOQL path otherwise.
  - Implemented as async ingest job — never blocks the synchronous ingest pipeline on `checkRetrieveStatus()` polling. Polling backoff: 5s → doubling → 60s cap → 30 min abort with recoverable warning.
  - Quota guard via `Sforce-Limit-Info` header: reject retrieve path when within 10% of the 10,000 Metadata API calls/24h org limit.
  - Package.xml chunked at <2,000 components per retrieve (well under documented 5,000 limit).
  - Retrieved ZIP content uses `fs.mkdtemp` + finally-block cleanup; never persisted past ingest. Tokens never serialized to async-job state.
**Success Criteria** (what must be TRUE when this phase completes):
  1. Engineer ingesting an OmniStudio-on-Core org sees design-time fields (`PropertySetConfig`, version strings) populated on graph nodes that were previously invisible via SOQL alone.
  2. Engineer running ingest on an org without retrieve permission sees the extractor degrade gracefully to the existing SOQL path with a structured warning explaining the fallback — never an ingest failure.
  3. Engineer monitoring `get_ingest_job` during a retrieve sees the synchronous ingest complete on its normal timeline (sub-5min for mid orgs); retrieve completes as a separate async job pollable via the same surface.
  4. Engineer ingesting an org within 10% of its daily Metadata API quota sees the retrieve path skipped with a quota-guard warning, not a `REQUEST_LIMIT_EXCEEDED` failure.
**Plans**: TBD

### Phase 4: Rules + SARIF
**Goal**: All 21 YAML rule files conform to a PMD-aligned schema, and rule violations export as GitHub-code-scanning-compatible SARIF 2.1.0 documents with `physicalLocation` populated from Phase 1 edge provenance.
**Depends on**: Phase 1 (SARIF `physicalLocation` requires W1-02 `sourceUri/line/column`). W3-01 strictly precedes W3-02 within this phase — SARIF rule descriptors map 1:1 to PMD rule fields; building the emitter before renaming rules requires double-work.
**Requirements**: W3-01, W3-02
**Build order within phase**: W3-01 first (single-commit migration script touching all 21 YAML files, with Zod schema validator in CI; `legacy_*` aliases preserved for one release cycle). Then W3-02.
**Anti-features that MUST ship from day 1**:
  - SARIF output validated against the OASIS schema via `ajv` at emit time, not just at upload. Every `ruleId` in `results[]` MUST exist in `rules[]`; every result MUST carry `locations[0].physicalLocation.artifactLocation.uri` as a repo-relative path; `level` MUST be in `{none, note, warning, error}`.
  - Absolute filesystem paths (e.g. `/Users/<name>/`) MUST be normalized to repo-relative URIs before emission — no local-path leakage into GitHub Security tab.
  - SARIF emitted to a file path; MCP response returns the path only — never inlines large documents into the `markdown` field.
**Success Criteria** (what must be TRUE when this phase completes):
  1. Architect inspecting any of the 21 YAML rule files sees PMD-aligned field names (`name / message / description / priority / externalInfoUrl / properties / example`); the Zod schema validator enforces the shape in CI and rejects malformed files.
  2. Engineer running `export_sarif` sees a SARIF 2.1.0 document that `ajv` validates against the OASIS schema and that round-trips successfully to GitHub Code Scanning (`processing_status: complete`, results visible in the Security tab).
  3. Engineer viewing a SARIF rule violation in GitHub Code Scanning can jump-to-source via the `physicalLocation` populated from edge `sourceUri/line/column` — repo-relative paths only, no `/Users/<name>/` leakage.
  4. Engineer running rule analysis with >100 findings sees SARIF emitted to a file path returned by the MCP tool, not an inline document in the response markdown.
**Plans**: TBD

### Phase 5: Tools + rename stability
**Goal**: `package.xml` deployable manifests surface as follow-up tools on every impact-flavored MCP tool; glob-pattern node lookups work via `find_nodes`; renames don't destroy the call graph (feature-flagged until validated).
**Depends on**: Phase 1 (find_nodes results carry W1-02 location data). Independent of Phases 2-4. `@salesforce/source-deploy-retrieve` already installed in Phase 3 is reused for W3-03 at zero install cost.
**Requirements**: W3-03, W3-04, W3-05
**Build order within phase**: W3-03 and W3-04 are independent and can parallelize. W3-05 lands last — largest persistence-layer surface area, designated slip candidate if Phase 4 overruns.
**Anti-features that MUST ship from day 1**:
  - `W3-05` ships feature-flagged off by default. Map keyed by composite `(orgId, namespace, serviceId, componentType)` — NEVER by `serviceId` alone (managed-package collisions corrupt the graph silently). On collision, log `serviceIdCollision` warning and fall back to delete+add. Ship `sfgraph reset-elemid-map <orgId>` CLI escape hatch. Composite-key schema must be correct on first commit (retrofitting is high cost).
  - `W3-04` glob selector parsed via `picomatch` AST into parameterized SQLite queries — never string-concatenated into SQL. Implicit `version=latest` filter on `salesforce.Flow.instance.*` globs unless `**` or explicit version suffix present. Hard cap 500 results with `truncated: true` flag.
  - `W3-03` package.xml generated via `@salesforce/source-deploy-retrieve` `ComponentSet#getPackageXml()` — authoritative output; wired as `follow_up_tool` on every impact-flavored tool (`impact_from_git_diff`, `trace_downstream`, and other dependency-impact tools).
**Success Criteria** (what must be TRUE when this phase completes):
  1. Engineer running any impact-flavored MCP tool (`impact_from_git_diff`, `trace_downstream`, etc.) sees `package_xml_export` listed in `follow_up_tools` and can generate a deployable `package.xml` for the resulting impact set in one follow-up call.
  2. Engineer running `find_nodes` with patterns like `apex.Class.Foo.*` or `salesforce.Flow.instance.Lead_*` sees matching nodes returned in sub-second time, capped at 500 results with `truncated: true` when exceeded; Flow-instance globs return latest version per flow by default.
  3. Engineer running a second ingest after renaming an Apex class sees incoming edges rewritten to the new `qualifiedName` (with `attributes.renamedFrom` provenance) rather than dropped via delete+add — feature-flag on.
  4. Engineer with two managed packages installing components of the same `DeveloperName` sees them remain distinct after a rename of one; `serviceIdCollision` warning is emitted instead of silent merge. `sfgraph reset-elemid-map <orgId>` CLI subcommand recovers the map if it gets into a bad state.
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/? | Not started | - |
| 2. Reliability and coverage | 0/? | Not started | - |
| 3. OmniStudio retrieve() | 0/? | Not started | - |
| 4. Rules + SARIF | 0/? | Not started | - |
| 5. Tools + rename stability | 0/? | Not started | - |

## Phase Ordering Rationale

- **W1-01 + W1-02 first above all else (paired PR):** The overlap detector (W2-01), SARIF emitter (W3-02), and `find_nodes` location output (W3-04) all require edge source-location provenance and a warnings channel. Slipping these two cascades across both Wave 2 and Wave 3.
- **Phase 2 must wait for Phase 1:** W2-01 overlap detector needs both the warnings surface (W1-01) to report skipped candidates and edge provenance (W1-02) to cite source coordinates in findings.
- **Phase 3 isolated:** W2-02 is 2-3× the size of any other item and has distinct Metadata API risk (quota, async polling, 5k-component chunking). Isolation protects Phase 2 from its schedule variance and lets it run in parallel with Phase 2 if Phase 1 lands cleanly.
- **W3-01 strictly before W3-02 within Phase 4:** SARIF `reportingDescriptor` maps 1:1 to PMD rule fields. Building the emitter first then renaming rules is double-work.
- **W3-05 last within Phase 5:** Largest persistence-layer surface area; graph corruption from a wrong composite key is costly to recover from. Designated slip candidate.

## Coverage Summary

| Phase | Requirements | Count |
|-------|--------------|-------|
| Phase 1 | W1-01, W1-02, W1-03, W1-04, W1-05, W1-06 | 6 |
| Phase 2 | W2-01, W2-03, W2-04, W2-05, W2-06 | 5 |
| Phase 3 | W2-02 | 1 |
| Phase 4 | W3-01, W3-02 | 2 |
| Phase 5 | W3-03, W3-04, W3-05 | 3 |
| **Total** | — | **17 / 17** ✓ |

---
*Last updated: 2026-05-17 after initial roadmap creation*
