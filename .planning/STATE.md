# STATE: sfgraph hardening + capability expansion

**Initialized:** 2026-05-17

## Project Reference

**Core Value:** Every edge in the graph carries enough provenance that "why does X depend on Y" is answerable from the data alone — and every ingest failure is loud, named, and recoverable.

**Current Focus:** Phase 1.5 plan revised round 2 (independent analyst review folded in — added W1.5-07 deletion-sweep guard + W1.5-08 MCP staleness signal; 8 backlog/rejection items recorded). Awaiting Phase 1 planning. Phase 1.5 is dependency-free and can land in parallel with Phase 1.

## Current Position

- **Phase:** Phase 1.5 plan revised round 2; awaiting Phase 1 planning
- **Plan:** `.planning/phase-1.5/PLAN.md` (revised round 2, 2026-05-18)
- **Status:** Roadmap created; Phase 1.5 plan PASS WITH CONCERNS → revisions applied round 1; analyst review folded in round 2 (W1.5-07 + W1.5-08 added)
- **Progress:** [□□□□□] 0 / 5 phases complete

## Performance Metrics

- **Phases complete:** 0 / 5
- **Requirements mapped:** 17 / 17
- **Requirements complete:** 0 / 17

## Accumulated Context

### Decisions
- This monorepo IS the fork; `packages/core/src` is source of truth (no upstream PR dependency).
- Scope = all three waves in one milestone (Wave 1 → 2a → 2b → 3a → 3b).
- W1-01 (silent catch) and W1-02 (edge provenance) get top priority within Wave 1 — keystones for every downstream wave.
- Wave 1 must land before Wave 2 (overlap detector needs warnings + provenance).
- Sequencing inside Wave 2: W2-01 first, then W2-05/06 (HTTP hardening), then W2-03 → W2-04 (MCD baseline before gap-fills); W2-02 isolated in Phase 3.
- W3-01 PMD rename strictly before W3-02 SARIF emitter.
- No global atomic ingest transaction — per-resolver try/catch isolation is correct.
- Read-only org access is a load-bearing safety property; no mutation API.
- Local-only privacy posture is the single strongest commercial wedge; no SaaS deployment.

### Phase 1.5 design decisions (added 2026-05-18, revision round 1)
- **Stop-waiting (not in-flight HTTP abort) as the wedge close primitive.** Verified at `node_modules/.pnpm/jsforce@3.10.15_@types+node@22.19.19/node_modules/jsforce/lib/request.js:55,128,180`: jsforce 3.10.15 constructs its `AbortController` internally and never exposes it; `conn.tooling.query()` returns a `Promise`, not an abortable `Request`. True in-flight socket cancellation is impossible without forking jsforce or monkey-patching. Phase 1.5 ships stop-waiting semantics: the merger releases the slot within 100ms via a local "abandon" signal; the underlying jsforce request continues until network-layer timeout (~10min default). A wedged source may hold a TCP socket and ~1–10MB of buffered memory until reap. Accepted as a Phase 1.5 bound. Upstream PR / fork tracked as future hardening item below. Queue-cancel path (signal aborts before `pool.schedule` invokes the factory) remains clean and is the W1.5-02 cap-eviction "happy" path.
- **Namespaced-string warnings on the current `string[]` surface (not structured).** Phase 1.5 emits colon-delimited namespaced strings (`wedge:<sourceLabel>:<stage>:<detail>`) on the existing `LiveIngestResult.warnings: string[]` field at `packages/core/src/ingest/live-ingest.ts:161`. This makes Phase 1.5 dependency-free on Phase 1 / W1-01. The strings are forward-compatible with W1-01's eventual `{stage, code, message, count, attributes}[]` shape via a bijective mapping documented in `packages/core/src/ingest/warning-schema.ts`. When W1-01 lands, its migration parser consumes the namespaced strings and emits structured records. Phase 1 and Phase 1.5 can land in either order or in parallel.
- **Soft-isolate with late-yield drain as the default wedge handling.** When a source wedges, the default behavior is to release the slot semantically; the iterator continues running in the background; records yielded after slot release are merged into the output stream as long as the pipeline is open, tagged with `attributes.lateYield: true` and `attributes.wedgeReleasedAt: <ISO>`. Stop-waiting cancel via the in-flight path is reserved for the case where `SFGRAPH_MAX_BACKGROUND_WEDGES` (default 4) is exceeded — at which point the oldest active background wedge is evicted. Rationale: cascade fix doesn't require hard cancellation; late-drain prevents silent data loss.
- **LWC window=8 (vs. Vlocity window=4).** Picked to saturate the 5-concurrent Tooling pool with bundles in flight while leaving slack for retries. Managed-namespace LWC fast-path bypasses the window scheduler.
- **Diagnostics report path `~/Library/Application Support/sfgraph/diagnostics/`.** Matches existing sfgraph user-data conventions; diagnose mode is for naming wedges, not predicting production wall-clock (pool concurrency forced to 1).

### Phase 1.5 design decisions (added 2026-05-18, revision round 2)
- **W1.5-07 design decision: deletion-sweep guard refuses, doesn't merge.** The `--detect-deletions` sweep at `live-ingest.ts:789-819` today only skips when `streamAborted === true`; a wedged source completes with `streamAborted === false` and an empty `touchedQnames`, causing the sweep to wipe every node of that label. W1.5-07 adds a per-label drop-ratio guard: refuse the deletion when `priorCount > 0 && touchedCount === 0` (empty stream) or when `(priorCount - touchedCount) / priorCount > 0.30` (drop ratio). Refused-label nodes keep their `last_seen_at` so staleness reports still surface them — staleness clock keeps ticking, which is the right behavior. Default drop-ratio 0.30 chosen as conservative; tuning data needed before adjusting. Env-var override `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO=1.0` preserves the old behavior for users who explicitly accept the risk. Cross-references W1.5-02: wedged sources release their slot with `touchedCount === 0` → automatically caught by W1.5-07. Two fixes together ensure no wedge ever causes data loss.
- **W1.5-08 design decision: staleness signaled via INTEGER counter, not snapshot isolation.** Add `sync_generation INTEGER` (and `sync_in_progress` flag or parity sentinel) to `_sfgraph_orgs`. Increment at ingest start/end inside the existing `touchSync()` call with try/finally semantics. MCP server surfaces `staleness: { generation, in_progress, last_sync_at }` on every tool response. Per-connection WAL snapshots already give technical isolation; this is purely about **communicating** "sync not done yet" to readers so they can react sensibly. No global ingest transaction; no DB file atomic-swap; no snapshot-based reads — those are larger and deferred. Smallest possible surface that closes the user-visible inconsistency.
- **Performance work deferred (analyst items #1 and #2).** Parallel parse via `p-limit(4-8)` and per-record SQLite write buffering require profiling proof first. Profiling task captured as backlog item 2 in PLAN.md. Speculative claim of 3-5× throughput rejected without per-record timing data on PLDT_DEV_Anshul. Triggers to revisit documented per backlog entry: revisit parallel parse if >50% wall-clock is inside `processOne` (CPU-bound parsing); revisit write buffering if >20% wall-clock is in SQLite merge calls.
- **Analyst item #11 (reflection walker streaming) rejected.** Existing 50k-per-label cap is sufficient; V8 string compression makes the actual heap cost smaller than implied. Re-evaluate only if heap profiling proves it bites in production. Not on the backlog; not a planned future item.

### Schema-Irreversible Decisions (must be right on first commit)
- W1-02: `EdgeFact.sourceUri` interned via `sources(id, uri)` FK table — never inline string per edge.
- W1-01: `LiveIngestResult.warnings[]` carries structured `{stage, code, message, count}` objects, capped at 200 entries with `warningsTruncated` flag. **Migration parser MUST handle Phase 1.5's namespaced colon-delimited strings (`wedge:<source>:<stage>:<detail>`) via the bijective schema in `packages/core/src/ingest/warning-schema.ts`.**
- W1-04: Preserve existing `ambiguous: true` over-approximation edges alongside new precise edges via `attributes.resolved: 'exact' | 'ambiguous'`.
- W1.5-08: `sync_generation` column on `_sfgraph_orgs` is monotonically increasing INTEGER, incremented exactly once per successful ingest. Either a separate `sync_in_progress BOOLEAN` column OR parity-sentinel encoding (odd = in-progress, even = complete) — pick one and stick with it; both are equivalent semantically but downstream MCP serialization depends on which encoding is chosen.
- W2-03: Per-`(MetadataComponentType, RefMetadataComponentType)` chunking from day 1; treat `records.length === 2000` as truncation signal.
- W3-05: Map keyed by composite `(orgId, namespace, serviceId, componentType)` — never `serviceId` alone.

### Feature Flags (ship off by default until validated)
- W2-01 overlap detector: `disableOverlapDetect: true` default.
- W3-05 ElemID rename stability: off by default with `sfgraph reset-elemid-map <orgId>` escape hatch.

### Known limitations / future work
- **jsforce in-flight abort.** jsforce 3.10.15 does not expose its `AbortController` to callers. Phase 1.5 accepts a stop-waiting socket-leak window of up to ~10 minutes per wedged source. Future hardening item: file an upstream PR adding `signal` parameter to `Connection.query` / `Connection.tooling.query`, or fork jsforce in this monorepo. Tracked here, not blocking.

### Deferred / Backlog (recorded 2026-05-18, round 2 — from independent analyst review of `live-ingest.ts`)
- **Backlog item 1: Per-record SQLite write buffering** (analyst #2). Deferred pending profiling. Trigger: >20% wall-clock in SQLite merge calls (`mergeNodes`, `mergeEdges`, snippet upsert). Estimated 10–30s win on a 482s ingest.
- **Backlog item 2: Parallel `processOne` via `p-limit(4-8)`** (analyst #1). Deferred pending profiling. Trigger: >50% wall-clock inside `processOne` (CPU-bound parsing). Profile per-record CPU vs await time on PLDT_DEV_Anshul before committing. Compounds with backlog item 1 — combined refactor is one architectural change.
- **Backlog item 3: Move MCD baseline into bulkRetrieve sliding-window merge** (analyst #6). Deferred pending verification that MCD-edge writes and parsed-edge writes do not race on shared rows in the `edges` table. Expected 30–90s win.
- **Backlog item 4: De-duplicate `discoverMetadataTypes` + `probeCapabilities`** (analyst #9). Trivial; ~5s win; bundle into next general ingest-entry PR.
- **Backlog item 5: OmniStudio double-ingest dedup** (analyst #10). Five-line dispatch change when `disableOmnistudioRetrieve === false`. Bundle into Phase 3.
- **Backlog item 6: Incremental-mode deletion safety net** (analyst #5). Periodic full syncs every Nth incremental run; relies on W1.5-07 as underlying safety mechanism. Defer to milestone v1.3.
- **Backlog item 7: Post-merge pass parallelization** (analyst #7). Group `resolveFlowApexMethods`, `resolveApexMethodArity`, audit into `Promise.all`. 5–15s win. Bundle into a future PR.
- **Backlog item 8 (REJECTED): Reflection walker index streaming** (analyst #11). Existing 50k-per-label cap is sufficient; V8 string compression keeps real heap cost low. Not on the backlog; re-evaluate only if heap profiling proves it bites.

### Todos
- [ ] Plan Phase 1 (`/gsd:plan-phase 1`)
- [ ] Execute Phase 1.5 (no Phase 1 dependency; now 8 requirements W1.5-01..W1.5-08)
- [ ] Plan Phase 2
- [ ] Plan Phase 3
- [ ] Plan Phase 4
- [ ] Plan Phase 5

### Blockers
- None.

### Active Research Flags (from research/SUMMARY.md)
- Phase 2 / W2-01: Validate `PropertySet` JSON schema across OmniStudio process types against real CMT fixture before locking signature hash design.
- Phase 3 / W2-02: Validate `Sforce-Limit-Info` header behavior + 5,000-component limit against a real OmniStudio-on-Core sandbox before committing to quota guard implementation.
- Phase 4 / W3-01: Validate PMD canonical field list against the `EmptyCatchBlock` canonical rule before writing the migration script.
- Phase 5 / W3-05: Validate ElemID semantics across managed namespaces against a managed-package fixture before enabling by default.

## Session Continuity

**Last session:** 2026-05-18 — Phase 1.5 plan revised round 2 in response to independent analyst review of `live-ingest.ts` (12 issues identified). Two new requirements added: W1.5-07 (per-label drop-ratio guard on `--detect-deletions` sweep — second-line defense closing a catastrophic-but-latent bug where one wedge + `--detect-deletions=true` would wipe every Profile and PermissionSet from the graph) and W1.5-08 (MCP sync-generation staleness signal for concurrent readers — cheap, complementary, no global transaction). 8 backlog/rejection items captured. Anti-features expanded to explicitly defer parallel parsing and buffered writes pending profiling proof. ROADMAP.md updated to 8 requirements (25 total: 17 v1 + 8 hardening). PLAN.md gained `## Deferred / Backlog` and `## Verification round 2` sections.

**Previous session (round 1):** 2026-05-18 — Phase 1.5 plan revised round 1 in response to verifier `PASS WITH CONCERNS`. 7 revisions applied: W1.5-03 reframed as stop-waiting (jsforce 3.10.15 limitation verified); Phase 1.5 → Phase 1 dependency dropped (now ships against current `string[]` warnings surface via namespaced strings); W1.5-02 late-yield drain policy committed; env var typo `SFGRAPH_SOURCES_CONCURRENCY` → `SFGRAPH_SOURCE_CONCURRENCY` fixed; env var inventory expanded from 7 to ≥12; EVIDENCE.md measurement schema pinned; fictitious `watchdogClockMisaligned` reference removed.

**Next session:** Either `/gsd:plan-phase 1` to plan Phase 1, or `/gsd:execute-phase 1.5` since Phase 1.5 is now dependency-free with 8 requirements.

**Files to re-read on resume:**
- `.planning/ROADMAP.md` — phase structure and success criteria (Phase 1.5 now 8 requirements)
- `.planning/phase-1.5/PLAN.md` — revised plan with `## Deferred / Backlog` and `## Verification round 2` summary at bottom
- `.planning/phase-1.5/VERIFICATION.md` — round-1 verifier output
- `.planning/REQUIREMENTS.md` — traceability table
- `.planning/research/ARCHITECTURE.md` — file:line integration targets for Phase 1 surgical fixes
- `.planning/research/PITFALLS.md` — schema-irreversible decisions checklist

---
*Last updated: 2026-05-18 — Phase 1.5 revisions round 2 applied (W1.5-07 + W1.5-08 added; 8 backlog/rejection items recorded).*
