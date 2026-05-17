# STATE: sfgraph hardening + capability expansion

**Initialized:** 2026-05-17

## Project Reference

**Core Value:** Every edge in the graph carries enough provenance that "why does X depend on Y" is answerable from the data alone — and every ingest failure is loud, named, and recoverable.

**Current Focus:** Roadmap complete; awaiting Phase 1 planning.

## Current Position

- **Phase:** — (not started; Phase 1 is next)
- **Plan:** —
- **Status:** Roadmap created; ready for `/gsd:plan-phase 1`
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

### Schema-Irreversible Decisions (must be right on first commit)
- W1-02: `EdgeFact.sourceUri` interned via `sources(id, uri)` FK table — never inline string per edge.
- W1-01: `LiveIngestResult.warnings[]` carries structured `{stage, code, message, count}` objects, capped at 200 entries with `warningsTruncated` flag.
- W1-04: Preserve existing `ambiguous: true` over-approximation edges alongside new precise edges via `attributes.resolved: 'exact' | 'ambiguous'`.
- W2-03: Per-`(MetadataComponentType, RefMetadataComponentType)` chunking from day 1; treat `records.length === 2000` as truncation signal.
- W3-05: Map keyed by composite `(orgId, namespace, serviceId, componentType)` — never `serviceId` alone.

### Feature Flags (ship off by default until validated)
- W2-01 overlap detector: `disableOverlapDetect: true` default.
- W3-05 ElemID rename stability: off by default with `sfgraph reset-elemid-map <orgId>` escape hatch.

### Todos
- [ ] Plan Phase 1 (`/gsd:plan-phase 1`)
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

**Last session:** 2026-05-17 — roadmap created; 5 phases mapped to 17 v1 requirements with 100% coverage.

**Next session:** Run `/gsd:plan-phase 1` to decompose Foundation phase into executable plans. Start with the W1-01 + W1-02 paired PR (keystone).

**Files to re-read on resume:**
- `.planning/ROADMAP.md` — phase structure and success criteria
- `.planning/REQUIREMENTS.md` — traceability table
- `.planning/research/ARCHITECTURE.md` — file:line integration targets for Phase 1 surgical fixes
- `.planning/research/PITFALLS.md` — schema-irreversible decisions checklist

---
*Last updated: 2026-05-17 after roadmap creation*
