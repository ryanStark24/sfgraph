# Roadmap: sfgraph hardening + capability expansion

**Created:** 2026-05-17
**Depth:** standard
**Core Value:** Every edge in the graph carries enough provenance that "why does X depend on Y" is answerable from the data alone — and every ingest failure is loud, named, and recoverable.
**Coverage:** 17 / 17 v1 requirements mapped + 8 hardening requirements (Phase 1.5)

## Phases

- [ ] **Phase 1: Foundation** — Wave 1 in-place fixes: silent-failure surface, edge provenance, LWC directives, arity precision, IS_TEST annotation, README correctness
- [ ] **Phase 1.5: Wedge isolation + watchdog correctness + promise reconciliation** — Hardening interjection: watchdog clock at slot-acquired, soft-isolate wedged sources with late-yield drain, stop-waiting iterator close, LWC parallel fetch, `sfgraph diagnose` CLI, README/COVERAGE reconciliation, deletion-sweep safety guard, MCP sync-generation staleness signal
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
  - `LiveIngestResult.warnings[]` MUST carry structured `{stage, code, message, count}` objects, capped at 200 entries with `warningsTruncated` flag — not raw strings. **When W1-01 lands, its migration parser converts Phase 1.5's pre-existing namespaced strings (`wedge:<source>:<stage>:<detail>`) into structured form via the bijective schema documented in `packages/core/src/ingest/warning-schema.ts`.**
  - `W1-04` MUST preserve existing `ambiguous: true` over-approximation edges alongside new precise edges via `attributes.resolved: 'exact' | 'ambiguous'`.
**Success Criteria** (what must be TRUE when this phase completes):
  1. Engineer running ingest against a Vlocity-CMT + managed-namespace org sees per-skipped-type structured warnings (`{stage, code, message, count}`) on `LiveIngestResult.warnings[]` rather than zero-output silence — including the three previously-swallowed sites at `vlocity/runner.ts:76,188,246`.
  2. Engineer querying any graph edge sees `sourceUri`, `line`, `column` populated whenever the originating parser had AST position information; SQLite file size grows <20% on the largest test fixture (verifies `sources` FK interning shipped correctly).
  3. Engineer inspecting an LWC component using `lwc:if` / `lwc:elseif` / `lwc:else` / `lwc:for:each` sees USES edges emitted for every identifier bound inside the conditional or loop expression.
  4. Engineer running `find_callers` on an overloaded Apex method sees both precise edges (`attributes.resolved: 'exact'`) where arguments are statically typed AND fallback `ambiguous: true` edges where they aren't — the 21 existing YAML rule golden outputs are unchanged.
  5. Engineer reading the README sees accurate self-description: 88 edges, 11 typed extractors + 21 rules + opaque-fallback, 15–120s timeout band, env-paths storage, name+arity+argTypes arity resolver.
**Plans**: TBD

### Phase 1.5: Wedge isolation + watchdog correctness + promise reconciliation
**Goal**: A real-org ingest never reports a metadata type as "skipped" because of a wedge in an unrelated source. The watchdog stops waiting on the wedge so queued neighbors get their slot, even if the wedge's underlying request continues until network-layer reap. README accurately reflects what ships. `--detect-deletions` is fortified with a second-line drop-ratio guard so no wedge can ever cause label-wide data loss; MCP readers see a `staleness` signal on every tool response.
**Depends on**: Nothing. Phase 1.5 ships against the current `LiveIngestResult.warnings: string[]` surface using namespaced colon-delimited strings (`wedge:<sourceLabel>:<stage>:<detail>`). These are forward-compatible with Phase 1's W1-01 structured refactor via a bijective schema documented in `packages/core/src/ingest/warning-schema.ts`. Phase 1 and Phase 1.5 can land in either order, or in parallel.
**Requirements**: W1.5-01, W1.5-02, W1.5-03, W1.5-04, W1.5-05, W1.5-06, W1.5-07, W1.5-08
**Build order**: W1.5-01 + W1.5-02 first as a paired keystone (watchdog clock + slot release with late-yield drain). W1.5-03 stop-waiting iterator close (queue-cancel + in-flight stop-waiting + AbortError surface) lands alongside or just before. W1.5-04 LWC parallelization in parallel with the watchdog work, merged after for clean real-org verification. W1.5-07 deletion-sweep drop-ratio guard parallelizes with the keystone (different files). W1.5-08 sync-generation column parallelizes with anything. W1.5-05 `sfgraph diagnose` CLI after the runtime fixes (consumes W1.5-07 refusal records). W1.5-06 README + `docs/COVERAGE.md` reconciliation last.
**Anti-features that MUST ship from day 1**:
  - No raising of timeout literals (60s SOQL, 120s `metadata.read` unchanged). The fix is correctness, not bigger numbers.
  - Soft-isolate with late-yield drain as default; stop-waiting (not real in-flight abort) is the bounded fallback only when `SFGRAPH_MAX_BACKGROUND_WEDGES` (default 4) is exceeded.
  - No Bulk API migration. The diagnosis showed correctness-of-watchdog + serial-per-bundle SOQL, not API paradigm choice.
  - No `SECURITY_PER_LABEL_CAP` removal. Documented in `docs/COVERAGE.md` as a known limitation.
  - No new YAML rule files for `PermSetGroup` / `MutingPermissionSet` / `ProfileSessionSetting` / `ProfilePasswordPolicy`. Documented as a gap in `docs/COVERAGE.md`, deferred.
  - No re-architecting of the source registration model. Fix is `startedAt` at slot-acquired plus semantic slot release.
  - No real in-flight HTTP cancellation. jsforce 3.10.15 does not expose its `AbortController` to callers (verified at `node_modules/.pnpm/jsforce@3.10.15.../jsforce/lib/request.js:55,128,180`). Stop-waiting + documented socket-leak window (~10min until network-layer reap) is the accepted bound. Upstream PR / fork is a future hardening item.
  - No global ingest transaction. W1.5-08 communicates staleness; it does NOT introduce a single transaction wrapping the whole ingest. Per-resolver try/catch isolation preserved.
  - No `--detect-deletions` default flip. W1.5-07 makes the flag SAFER but does not promote it to default-on.
  - No parallel parsing (analyst #1) and no buffered writes (analyst #2). Both deferred pending profiling proof; backlog items 1 and 2 in PLAN.md.
**Success Criteria** (what must be TRUE when this phase completes):
  1. Engineer running `sfgraph ingest --rebuild` against a Vlocity-CMT org sees zero `source watchdog (first-yield 90s)` skips for sources that never actually executed — every skip is attributable to a real wedge in THAT source (verified by `lastYielded=<own-source>` in the namespaced warning string).
  2. Engineer reading the run summary sees namespaced warnings naming the specific wedged source(s) — `wedge:<sourceLabel>:firstYield:90s:lastYielded=<qualifiedName>` — rather than a fan-out of unrelated victim skips.
  3. Engineer running `sfgraph diagnose <orgId>` gets a JSON report at `~/Library/Application Support/sfgraph/diagnostics/<orgId>-<timestamp>.json` with per-source timing, slow-call list (>10s threshold), wedge timeline, capability probes, deletion-guard refusal records, and `diagnosticMode: true`.
  4. Engineer reading README sees: accurate MCP tool count, honest disclosure of security model gaps (`PermSetGroup` / `MutingPermissionSet` opaque), documented env var inventory (≥13 vars including `SFGRAPH_MAX_BACKGROUND_WEDGES` and `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO`; final count reconciled at execution time via grep), and the MCP staleness block.
  5. Engineer reading `docs/COVERAGE.md` sees every ingested metadata type with status (`Full` / `Partial` / `Generic-Only` / `Unsupported`) and known limitations — including the jsforce stop-waiting socket-leak window, the deletion-guard refusal behavior, and the MCP staleness block — no surprises in the graph.
  6. EVIDENCE.md at `.planning/phase-1.5/EVIDENCE.md` shows AFTER skip count ≤ 10% of BEFORE on the same org / run conditions, every AFTER skip has `lastYielded` in its own source label, and drift guards show no significant org change between runs.
  7. Engineer running `sfgraph ingest --detect-deletions --rebuild` against any org sees zero label-level deletions on a wedge-induced empty-stream condition; `wedge:detect-deletions:refuse:label=*` warnings name the protected labels.
  8. MCP client polling any tool response sees `staleness: { generation: N, in_progress: bool, last_sync_at: ISO }`. During an active ingest, `in_progress: true`; after completion, `generation` incremented by 1 and `in_progress: false`.
**Plans**: `.planning/phase-1.5/PLAN.md`

### Phase 2: Reliability and coverage
**Goal**: Long-tail metadata coverage matches Happy Soup; Tooling SOQL paths are operationally robust at scale; cross-flavor OmniStudio overlaps are detected with explicit signature divergence reporting.
**Depends on**: Phase 1 (overlap detector needs warnings surface + edge provenance; without W1-01/W1-02, overlap findings are unactionable). Recommended to land after Phase 1.5 as well — real-org verification of W2-03/W2-05 is only meaningful once the watchdog cascade is fixed.
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
| 1.5. Wedge isolation + watchdog correctness | 0/8 | Planned (revised round 2) | - |
| 2. Reliability and coverage | 0/? | Not started | - |
| 3. OmniStudio retrieve() | 0/? | Not started | - |
| 4. Rules + SARIF | 0/? | Not started | - |
| 5. Tools + rename stability | 0/? | Not started | - |

## Phase Ordering Rationale

- **W1-01 + W1-02 first above all else (paired PR):** The overlap detector (W2-01), SARIF emitter (W3-02), and `find_nodes` location output (W3-04) all require edge source-location provenance and a warnings channel. Slipping these two cascades across both Wave 2 and Wave 3.
- **Phase 1.5 is dependency-free and can land in parallel with Phase 1:** Real-org evidence (PLDT_DEV_Anshul Vlocity-CMT ingest) showed a single LWC bundle wedge cascading 37 unrelated metadata-type skips and 19,166 dangling edges. The watchdog-clock fix (W1.5-01) and slot-release model (W1.5-02) are correctness fixes that do not require Phase 1's structured-warnings refactor — they ship against the current `string[]` warnings surface using namespaced colon-delimited strings (`wedge:<source>:<stage>:<detail>`) that W1-01's eventual migration parser will convert to the structured shape via a documented bijective schema. W1.5-07 (deletion-sweep drop-ratio guard) and W1.5-08 (MCP staleness signal) round out Phase 1.5 with a catastrophic-bug fix and a cheap concurrent-reader signal; both are independent of the keystone work and parallelize freely. Phase 1 and Phase 1.5 can land in either order or in parallel.
- **Phase 2 must wait for Phase 1 (and ideally Phase 1.5):** W2-01 overlap detector needs both the warnings surface (W1-01) to report skipped candidates and edge provenance (W1-02) to cite source coordinates in findings. Real-org W2-03/W2-05 verification additionally needs Phase 1.5's cascade fix.
- **Phase 3 isolated:** W2-02 is 2-3× the size of any other item and has distinct Metadata API risk (quota, async polling, 5k-component chunking). Isolation protects Phase 2 from its schedule variance and lets it run in parallel with Phase 2 if Phase 1 lands cleanly.
- **W3-01 strictly before W3-02 within Phase 4:** SARIF `reportingDescriptor` maps 1:1 to PMD rule fields. Building the emitter first then renaming rules is double-work.
- **W3-05 last within Phase 5:** Largest persistence-layer surface area; graph corruption from a wrong composite key is costly to recover from. Designated slip candidate.

## Coverage Summary

| Phase | Requirements | Count |
|-------|--------------|-------|
| Phase 1 | W1-01, W1-02, W1-03, W1-04, W1-05, W1-06 | 6 |
| Phase 1.5 | W1.5-01, W1.5-02, W1.5-03, W1.5-04, W1.5-05, W1.5-06, W1.5-07, W1.5-08 | 8 |
| Phase 2 | W2-01, W2-03, W2-04, W2-05, W2-06 | 5 |
| Phase 3 | W2-02 | 1 |
| Phase 4 | W3-01, W3-02 | 2 |
| Phase 5 | W3-03, W3-04, W3-05 | 3 |
| **Total** | — | **17 v1 + 8 hardening = 25** ✓ |

---
*Last updated: 2026-05-18 — Phase 1.5 revised round 2: added W1.5-07 (deletion-sweep drop-ratio guard, second-line defense against label-extinction on wedge + `--detect-deletions`) and W1.5-08 (MCP sync-generation staleness signal for concurrent readers). Recorded 8 backlog/rejection items from independent analyst review (parallel parse and buffered writes deferred pending profiling proof; reflection walker streaming rejected).*
