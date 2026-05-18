# Changelog

## 1.2.1 — packaging fix (re-publish of 1.2.0 for `-cli`, `-server`, `sfgraph`)

**No source changes.** This release exists only because `1.2.0` of three
packages (`@ryanstark24/sfgraph-cli`, `@ryanstark24/sfgraph-server`,
`@ryanstark24/sfgraph`) shipped to npm with **unresolved `workspace:*`
dep specifiers** that `npm install` rejects with
`EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`.

Root cause: pnpm's `workspace:*` protocol must be rewritten to a
concrete version at pack time. **`pnpm publish` does this; `npm publish`
does not.** The 1.2.0 release used `npm publish` for those three
packages by mistake (`-core@1.2.0` was packed via pnpm and is
fine — no change here).

Affected, now fixed:

| Package | 1.2.0 (broken) | 1.2.1 (fixed) |
|---|---|---|
| `@ryanstark24/sfgraph-cli`    | `workspace:*` in deps | concrete versions |
| `@ryanstark24/sfgraph-server` | `workspace:*` in deps | concrete versions |
| `@ryanstark24/sfgraph`        | `workspace:*` in deps | concrete versions |

Unchanged (1.2.0 was correct):

| Package | Version |
|---|---|
| `@ryanstark24/sfgraph-core` | 1.2.0 (kept) |
| `@ryanstark24/sfgraph-shared` | 1.1.3 |
| `@ryanstark24/sfgraph-skills` | 1.1.4 |
| `@ryanstark24/sfgraph-web` | 1.1.8 |

**Migration:** if you tried `npm i -g @ryanstark24/sfgraph@1.2.0` and got
the `EUNSUPPORTEDPROTOCOL` error, re-run with `@1.2.1`:

```bash
npm i -g @ryanstark24/sfgraph@1.2.1
```

The 1.2.0 broken versions have been deprecated on npm with a pointer to
1.2.1, so `@latest` resolution now skips them automatically.

**Publish hygiene going forward:** every release MUST use `pnpm publish`
(not `npm publish`) from within a pnpm workspace. Added to release docs.

## 1.2.0 — hardening + capability expansion

Eighteen feature commits across six work phases. Every change ships with
tests (core grew 389 → 474, +85 tests). All four new optional passes
default to **on**; see "Default-behavior change" below for the off-switch
filters consumers can use to recover the 1.1.8 precision-first behavior.

### Added — new MCP tools

- **`export_sarif`**. Emit every audit finding (governor risks, security
  gaps, dead code, dangling edges) as a single SARIF 2.1.0 report that
  round-trips into GitHub Code Scanning and the VS Code SARIF Viewer.
  Per-rule definitions come from a new `RULE_CATALOG` indexed by stable
  ruleId (`governor.soql-in-loop`, `security.fls-gap`, etc. — PMD-aligned
  vocabulary). Hand-rolled emitter; no `node-sarif-builder` dep.

- **`find_nodes`**. Glob-pattern node lookup (`ApexClass:*`,
  `CustomField:Account.*`, `Flow:{Lead,Account}_*`, `**:*Email*`). Uses
  `picomatch` with `.` as the path separator (not `/`) so qname-shaped
  globs work the way they read. Sub-millisecond on warm graph; capped at
  500 matches with `truncated: true` on overflow.

### Added — new CLI command

- **`sfgraph reset-elemid-map --org <alias> --yes`**. Clears the new
  service-id ↔ qname rename-stability map (see W3-05 below). Non-
  destructive — touches only the rename-detection lookup table, not
  nodes/edges/snapshots/vectors. Used as recovery hatch when the
  rename layer has produced incorrect inferences (e.g. serviceId
  collisions across managed packages with the same DeveloperName).

### Added — new typed edge relations

- **`USES_GLOBAL_VALUE_SET`** — CustomField (picklist) → GlobalValueSet.
  Synthesized from the field's `valueSet.valueSetName` describe column.
- **`DEPENDS_ON_FIELD`** — CustomField (dependent picklist) → controlling
  CustomField on the same object. Synthesized from
  `valueSet.controllingField`.

Total typed rel-types: **88 → 90**. Both gap-fills cover edge classes
Salesforce's `MetadataComponentDependency` SObject silently omits.

### Added — ingest result fields

- **`LiveIngestResult.warnings: string[]`**. Per-source skips collected
  during ingest (formerly only available in stdout). MCP consumers of
  `get_ingest_job` can now read "what got skipped and why" without
  parsing log lines.
- **`LiveIngestResult.overlap: { matched, diverged, empty, annotated }`**.
  OmniStudio overlap-detector summary.
- **`LiveIngestResult.reflectionEdges: number`**. Edges emitted by the
  reflection walker (zero when disabled).

### Added — post-merge passes (default on; opt-out flags noted)

- **OmniStudio overlap detector** (`disableOverlapDetect: true` to skip).
  Annotates every `CANONICAL_OF` pair (Vlocity DataRaptor ↔ Omni
  DataTransform, IntegrationProcedure ↔ OmniIntegrationProcedure,
  OmniScript ↔ OmniProcess, VlocityCard ↔ OmniUiCard) with
  `signaturesMatch: boolean` and `divergencePoints: string[]`.
  Signature = sorted multiset of `(relType, normalisedDstLabel)` across
  the node's outgoing edges with the four cross-flavour prefixes
  collapsed. Lets a migration audit tell a true duplicate (cleanup
  candidate) from a diverged implementation (manual reconciliation).

- **MCD baseline extractor** (`disableMcdBaseline: true` to skip).
  Queries `MetadataComponentDependency` for Layouts, FieldSets,
  EmailTemplates, CustomTabs, Groups, and Queues with Id-range
  pagination around Salesforce's documented 2000-row LIMIT/OFFSET cap.
  Edges tagged `attributes.source: 'mcd'`; coexist with parsed edges
  via separate rel-type tables. Includes Happy-Soup-equivalent
  `isDynamicReference` heuristic (`id == name` → `dynamic: true`).

- **OmniStudio retrieve()** (`disableOmnistudioRetrieve: true` to skip).
  Metadata API `retrieve()` for `OmniUiCard`,
  `OmniIntegrationProcedure`, `OmniDataTransform` alongside the
  existing SOQL path. Yields `RawMember` records with full design-time
  XML envelopes that the SOQL `PropertySet` JSON path can't reach.
  Auto-skips at ≥90% Metadata API quota utilisation
  (`Sforce-Limit-Info` header). Uses `jszip` for zip extraction.

- **Reflection-based generic walker** (`disableReflectionWalker: true`
  to skip). Walks every node's attributes for string values matching
  an existing qname's bare name; emits low-confidence `REFERENCES`
  edges tagged `attributes.source: 'reflection'`. Catches dependency
  references buried in undocumented blob schemas (OmniStudio
  PropertySet, Vlocity Definition, etc.). Self-references, reserved
  words, whitespace strings, and short strings (<4 chars) filtered;
  ambiguous matches across labels tagged `ambiguous: true`. Per-source
  cap of 200 edges (configurable).

### Added — provenance on every edge

- **`EdgeFact` attributes now carry `sourceUri`, `line`, `column`**
  automatically. `makeEdge` mirrors `makeNode`: threads
  `ParseContext.sourceUri` (and optional AST `loc`) onto every emitted
  edge. All 104 `makeEdge` call sites across parsers picked this up
  for free.

### Added — LWC directive handling

- **`lwc:if / lwc:elseif / lwc:else / lwc:for:each`** (and legacy
  `if:true / if:false / for:each / iterator:each`) directive
  attributes are now harvested by the HTML visitor. Bindings are
  emitted as `LWC_BINDS_PROPERTY` edges with `attributes.directive`
  set so consumers can distinguish conditional-rendering bindings
  from regular property reads. `for:each` records the `for:item`
  alias for future child-binding resolution.

### Added — Apex regex-mode arity counting

- The regex-mode Apex parser now counts call-site arguments with a
  balanced-paren scan (handles nested calls, string literals,
  line/block comments). Emits precise dst arities
  (`ApexMethod:Util.doWork(2)`) tagged
  `resolvedBy: 'regex-arg-count'`, matching what AST mode already
  produced. Falls back to `(?)` + `unresolvedArity: true` only when
  the counter can't determine arity — preserves the existing arity-
  resolver's overload fan-out for genuine unknowns.

### Added — IS_TEST attribute

- `attributes.isTest: boolean` now appears on every Apex method node
  derived from the `@isTest` / `@TestSetup` annotation (or `@isTest`
  on the enclosing class with the method static). The label
  (`TestMethod` vs `ApexMethod`) already encoded this; now the
  attribute lets consumers filter uniformly without knowing both
  labels.

### Added — service-id rename stability

- New SQLite table `_sfgraph_service_ids` (migration v7) with
  composite PK `(org_id, service_id)`. Three storage helpers in
  `storage/sqlite/rename-stability.ts`:
  `lookupServiceId(db, orgId, serviceId)`,
  `recordServiceId(db, orgId, serviceId, qname, label)`, and
  `rewriteEdgesForRename(db, orgId, oldQname, newQname)`. When a
  metadata component's Salesforce Id is unchanged but its
  `fullName` changes (rename), the rewriter migrates every edge
  (both directions) from the old qname to the new one in a single
  transaction — replacing the delete+add pattern that silently
  broke the call graph until the next full sync.

- **Mechanism shipped, ingest-time wiring deferred.** Extractor
  integration (calling `recordServiceId` at emit time, triggering
  rewrites in `mergeNodes`) is a follow-up that benefits from
  incremental rollout against real-org data. The reset CLI command
  exists today so any incorrect inferences can be cleared
  non-destructively.

### Added — SOQL infrastructure

- **`runSoqlInRebatchable`** in `extractors/live-org/rate-limit.ts`
  pre-splits oversized ID sets and recursively halves on HTTP 414/
  431 (URI Too Long / Request Header Fields Too Large) errors.
  Bounded by `maxDepth` (default 6); non-rebatchable errors pass
  through to caller's failSoft. Used by the MCD baseline; available
  to future extractors.

- **`readMetadataBatchAdaptive`** now pre-chunks to the
  Metadata-API per-call cap (`METADATA_READ_BATCH_SIZE = 10`) before
  any bisection. Configurable via `SFGRAPH_METADATA_READ_CHUNK_SIZE`
  (clamped ≤10 — the SOAP-side cap). Bisection only fires on
  legitimate errors now.

### Added — pre-PMD-aligned finding catalog

- `analyze/findings.ts` defines the canonical `Finding` type, the
  `RuleDescriptor` shape (name / shortDescription / fullDescription /
  defaultLevel / helpUri — mirrors PMD), and `RULE_CATALOG` indexing
  every rule sfgraph emits. Adapters
  (`governorRisksToFindings`, `securityAuditToFindings`,
  `deadCodeToFindings`, `danglingEdgesToFindings`,
  `collectFindings`) convert each audit's native shape into
  `Finding[]` for downstream SARIF / IDE / CI consumption.

### Fixed — class-level @isTest detection (latent bug)

- `extractClassHeader` was parsing class-level annotations from an
  empty slice (the regex consumed annotations via its leading
  `(?:@[\w()=,'"\s.]+\s+)*` group; the code looked for them in
  `src.slice(0, headerStart)` which was empty). Every `@isTest`
  class had been reporting `isTest: false` on its node, silently
  disabling the `IS_TEST_FOR` edge emission gated on
  `header.isTest`. Fix wakes up the dormant edges — visible in the
  regenerated `AccountControllerTest` golden showing
  `IS_TEST_FOR` edges to `AccountController` and `System`.

### Fixed — silent Vlocity failures

- The three `catch {}` blocks in `extractors/live-org/vlocity/
  runner.ts` (per-type query failure, child-fetch failure) now
  route through an `onError(label, err)` callback wired to
  `bulkRetrieve`'s existing `skipReport`. Schema drift (e.g.
  `DRBundleId__c` removed in newer `vlocity_cmt` versions) and
  "type genuinely absent" now produce distinguishable telemetry
  on `LiveIngestResult.warnings`.

### Default-behavior change — breadth over precision

The four new post-merge passes (overlap detector, MCD baseline,
OmniStudio retrieve, reflection walker) ship on by default. Two of
them — overlap detector and reflection walker — were flagged in
Pitfalls research as "false-positive recovery cost is high"; we
ship them on regardless because the breadth they add to migration
audits and OmniStudio coverage outweighs the cost of an occasional
false positive.

**Recovering 1.1.8-equivalent precision** on any of the four:

```ts
// At ingest time — disable specific passes
liveIngest({
  ...,
  disableOverlapDetect: true,        // skip CANONICAL_OF annotations
  disableMcdBaseline: true,           // skip MCD long-tail edges
  disableOmnistudioRetrieve: true,    // skip Metadata API retrieve()
  disableReflectionWalker: true,      // skip pattern-match REFERENCES
})

// At query time — filter on edge attributes
edges.filter((e) => e.attributes.source !== 'reflection');  // parsed-only
edges.filter((e) => e.attributes.source !== 'mcd');         // skip MCD
edges.filter(                                                 // skip overlap-flagged divergences
  (e) => !(e.relType === 'CANONICAL_OF' && e.attributes.signaturesMatch === false),
);
```

### Schema migration — v7 (auto-applied)

`MigrationRunner` adds `_sfgraph_service_ids` on next ingest. Single
`CREATE TABLE` + index; no data migration. Backup of the prior
schema taken automatically before the migration runs (default
retention: 5 backups under `<data-dir>/.sfgraph-backups/`). Safe to
roll back by replacing the live DB with a backup file.

### Internal — new dependencies

- `jszip@^3.10.1` (runtime — for OmniStudio retrieve() zip parsing)
- `picomatch@^4.0.4` (runtime — for find_nodes glob matching)
- `@types/picomatch@^4.0.0` (devDependency)

All three were already transitively available via `@salesforce/core`;
now pinned as direct deps.

### Internal — README + docs corrected

`docs/DATA_LOCATIONS.md`, `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`,
`docs/DESIGN.md`, `docs/TROUBLESHOOTING.md`, `docs/CLI.md`, and the
top-level README all corrected to reflect the actual platform-
specific storage paths (`~/Library/Application Support/sfgraph/` on
macOS, `~/.local/share/sfgraph/` on Linux, `%APPDATA%\sfgraph\` on
Windows — resolved via the `env-paths` library) and the real env
var inventory (`SFGRAPH_DATA_DIR` / `_CONFIG_DIR` / `_CACHE_DIR` /
`_LOG_DIR` / `_TEMP_DIR`, not the non-existent `SFGRAPH_HOME`). Rel-
type count updated to **90**.

## Unreleased — known parser limitations (file as follow-ups)

- **DataRaptor / OmniDataTransform field-reference regex** doesn't match
  the colon-separated path format Salesforce uses in real DRMapItem /
  OmniDataTransformItem records (`Step:Field`, `Object:Field`). The
  parsers' `extractFieldRefs()` uses a `/\bObject\.Field\b/` regex
  matching dot-separated paths only — which exist in some Vlocity
  legacy DataPacks but not in modern on-core or namespaced DRs. Effect:
  `DR_READS_FIELD`, `DR_WRITES_FIELD`, and `OMNI_USES_DATA_TRANSFORM`
  edges are silently missing on most real Vlocity-CMT and OmniStudio-on-
  Core orgs. Documented by 0-edge golden tests in
  `packages/core/src/parsers/__tests__/{vlocity,omnistudio}.golden.test.ts`.
  Fix requires walking the JSON structure looking for the structured
  `InputObjectName + InputFieldName` (on-core) / `InterfaceObjectName +
  InterfaceFieldAPIName` (Vlocity) pairs rather than regex-matching the
  flattened JSON string. ~30-50 LOC per parser. Help wanted.

## 1.1.8 — follow_up_tools wire-up, parser bug fixes, dead-code cleanup

### Fixed

- **Parser walk() false-positives**. Five parsers (vlocity/integration-
  procedure, vlocity/omni-script, vlocity/vlocity-card, omnistudio/process,
  omnistudio/integration-procedure, omnistudio/ui-card) previously used
  the parent JSON KEY as a fallback "type" when the visited object had
  no `Type` property. PropertySet blobs contain nested objects under
  keys like `remoteOptions` — each one false-positive matched
  `type.includes("remote")` and emitted phantom `IP_INVOKES_REMOTE →
  Remote:unknown` edges. Eliminated 27 false-positive edges across the
  three real-data golden fixtures.

- **`IP_CALLS_IP` edge type never emitted**. The Vlocity IntegrationProcedure
  parser checked `type.includes("integrationprocedure")` but real elements
  have `Type: "Integration Procedure Action"` (with spaces). Normalized
  type strings now strip non-alphanumerics before substring checks.
  Also enables the parallel `"DataRaptor Post Action"` → DataRaptor
  edge match in OmniProcess.

- **OmniProcess field-name fallback**. After the routing fix above,
  OmniProcess parser also needed to accept Vlocity-flavoured
  `dataRaptorBundleName` and `bundle` PropertySet keys alongside the
  on-core `dataTransformName` — real Vlocity-exported metadata can
  appear with either depending on the source tooling.

### Added

- **`follow_up_tools` populated on all 22 affected tools** (was 1/26).
  Maps each tool's natural next-steps (e.g. `analyze_field` →
  `trace_upstream`, `trace_downstream`, `security_audit`,
  `find_similar`). MCP clients that consume the `_meta.follow_up_tools`
  field can now auto-suggest the next action.

- **Tests for 1.1.5 / 1.1.6 features**: `embedTexts` / `embedSingle`
  contract tests (~5), liveness-probe tests with mocked conn (~5),
  `find_similar` tests with stub VectorStore (~6). Closes the
  "shipped without coverage" gap in the audit.

- **Golden parser tests** for all 4 Vlocity DataPack types and 3
  OmniStudio on-Core types. Closes the 6 originally-skipped tests
  (down from 6 to 0).

### Removed

- 5 dead exports across `core` (`vlocityFallback`, `findTestsFor`,
  `rethrowAsIngestError`, `stripNamespace`, `fieldRefEdge`). Internal-
  only, zero importers; cleaned for clarity.

### Docs

- Full env-var reference in `docs/TROUBLESHOOTING.md` covering paths,
  ingest tuning, coverage knobs, embedding overrides, and parser
  internals (13 previously-undocumented vars surfaced).

## 1.1.3 — edge resolution, Apex AST, dangling-edge audit

### Added

- **Apex AST extractor** (`packages/core/src/parsers/apex/ast-extractor.ts`) —
  full AST walk over `apex-parser` output: class/method/property
  declarations, SOQL/SOSL queries, DML statements, method invocations,
  field access, type references. Replaces the prior regex-driven
  approximation with structured edges and resolves the long tail of
  false-negative impact-trace misses.
- **Apex arity resolver** (`arity-resolver.ts`) — disambiguates overloaded
  Apex methods by (name, arg count, arg-type signature) so cross-class
  call edges land on the right target instead of fanning out across every
  overload.
- **Flow invocable-action resolver** (`invocable-resolver.ts`) — resolves
  `Flow → invocable Apex method` and `Flow → subflow` edges that the
  flow parser used to drop on the floor.
- **LWC binding extractor** — HTML visitor now harvests `@wire`,
  `lwc:if/elseif/else`, template event handlers, and slot bindings; JS
  visitor follows them through to the Apex method they ultimately call.
- **`sfgraph audit` command** (`packages/cli/src/commands/audit.ts`) —
  graph-completeness audit that surfaces dangling edges (edges pointing
  at non-existent nodes), unresolved Apex calls, and orphan invocable
  references. Catches silent extraction regressions before they reach
  consumers.
- **Edge-resolution post-passes** in `liveIngest` — second-pass resolver
  fires after every source completes, re-walking unresolved Apex
  invocations / Flow invocables / LWC bindings now that the full node
  graph is populated. Fixes the prior ordering problem where edges
  emitted by an early extractor had nothing to bind to.

### Changed

- **Skill descriptions tightened for unambiguous routing** — 7 SF
  skills had overlapping triggers that made the host LLM coin-flip
  between them:
  - `sf-explain-code` now scoped to Salesforce code only; cross-refs
    `sf-cross-layer-trace` / `sf-schema-overview` for broader scope.
  - `sf-cross-layer-trace` dropped its "proactively volunteer on every
    explain-style question" override and the `explain this LWC` /
    `explain this component` triggers that double-fired with
    `sf-explain-code`. Now offered as an opt-in follow-up.
  - `sf-cross-org-diff` / `sf-what-broke` / `sf-snapshot-compare` no
    longer all trigger on bare "what changed" — each now requires the
    user to name two orgs, name a deploy, or name a snapshot
    respectively, with explicit "use X instead when…" pointers.
  - `sf-impact-from-diff` (committed git history) vs `sf-wip-impact`
    (uncommitted working tree) now state their scope in caps so the
    LLM can't pick the wrong one for "what would this change do."

### Fixed

- **CodeRabbit review feedback on edge-resolution PR** (commit `9ce141e`).
- **Per-call timeouts on every `conn.*` invocation** — every jsforce
  call (`describe`, `query`, `bulkRetrieve`, `metadata.list`,
  `metadata.read`, `tooling.*`) now wraps in a per-call timeout so a
  single hung Salesforce call cannot wedge the ingest. Previously only
  some extractors had this.
- **Vlocity parallel refactor** — Vlocity extractor was serialising
  every datapack-type query; now fans out across types through the
  shared rate-limit pool, matching the rest of the extractor suite.

## 1.1.2 — per-call timeouts, Vlocity parallelism, auto-retry

### Added

- **Auto-retry transient skips when >10 sources skipped** (commit
  `52c5e84`) — when a debug-mode ingest finishes with more than 10
  fail-soft skips, the orchestrator now reruns `--retry-skipped`
  automatically once before reporting. Recovers cleanly from transient
  rate-limit storms that previously required a manual second pass.

### Fixed

- **Per-call timeouts on every `conn.*`** — see 1.1.3 entry; this
  release shipped the first half of the rollout (commit `4da3edb`).
- **Vlocity parallel refactor** — same commit; restored intra-extractor
  parallelism.
- **Publish must go via `pnpm`** (commit `acddbff`) — version-bump
  commit documenting that `npm publish` from inside the workspace
  resolves wrong dependency tree; only `pnpm publish --filter
  @ryanstark24/sfgraph` produces a correct tarball.

## 1.1.1 — README in tarball

### Fixed

- **`README.md` missing from `@ryanstark24/sfgraph` tarball** (commit
  `0ca9c30`) — npm page rendered blank because the published package
  had no README at root. `prepack` / `postpack` scripts now copy the
  monorepo root README into the package on pack and remove it after,
  so the published tarball ships a README without committing a
  duplicate file.

## 1.1.0 — visualiser, ingest hardening, MCP surface fixes

### Fixed

- **Silent process exit during ingest** — the event loop could drain
  mid-run on managed-package-heavy orgs, killing the process with no
  error and no completion log. A keep-alive timer now anchors the loop
  for the lifetime of the ingest.
- **Mass data-wipe risk in `detect-deletions`** — when `bulkRetrieve`
  aborted mid-stream, the deletion pass treated the partial result set
  as authoritative and removed every qname not in it. Now bails out
  unless every source completed cleanly.
- **Signal-handler leak on multi-org ingest in debug mode** — each
  org registered its own SIGINT/SIGTERM handler; running `--all` on a
  large fleet hit Node's MaxListenersExceededWarning. Handlers are now
  registered once per process.
- **MCP server hang on SIGINT** — `shutdown.ts` now force-exits after
  the watchdog timeout rather than waiting forever on stuck handles.
- **EmbeddingQueue concurrent flush race** — two flushes could
  overlap and double-emit vectors for the same node-hash; the flush
  loop is now serialised.
- **Stale `@sfgraph/*` package names in `.changeset/`** — refer to
  current `@ryanstark24/sfgraph-*` names.
- **better-sqlite3 binding auto-rebuilds on Node ABI mismatch** —
  preflight in `apps/sfgraph/bin/sfgraph.mjs` compiles from source on
  ABI mismatch (~20 s first run, instant after).
- **Object-phase chunk barrier replaced with sliding window** — the
  describe fan-out used to wave-bound at chunk boundaries (every
  describe in the chunk had to finish before the next chunk started),
  which serialised slow managed-package SObjects. Replaced with a
  sliding window: 40–60 % faster on managed-package-heavy orgs.

### Changed

- **`start_ingest_job` no longer enqueues** — the MCP server has no
  in-process ingest worker. The tool now returns
  `{ executed: false, run_this_command: "sfgraph ingest --org <alias>" }`
  for the user to run in a shell.
- **`analyze_field` validates inputs** — `object` and `field` must
  match `/^[A-Za-z][A-Za-z0-9_]*(?:__[a-zA-Z])?$/`. Malformed inputs
  are rejected before any graph query.
- **`cross_layer_flow_map` BFS uses a per-node cap (100)** — response
  includes `data.truncated: boolean`; markdown gains a `_truncated_`
  marker when the cap is hit.
- **Source-iterator merge is sliding-window** — replaced wave-bounded
  merger with a sliding window in `bulk-retrieve.ts` (default
  concurrency 12, override `SFGRAPH_SOURCE_CONCURRENCY`).

### Added

- **`sfgraph serve` + `packages/web`** — local 3D web visualiser at
  `http://localhost:7777`. Obsidian-style force-graph with Trace /
  Overview / Schema tabs, `L` / `F` / `Esc` shortcuts, "Render entire
  org" button against `/api/full`. Loopback only by default;
  `--i-understand-public-bind` to expose. EADDRINUSE auto-recovers by
  killing the stale process holding the port.
- **Per-call timeouts on metadata.list / metadata.read** in
  `security.ts`, `flow.ts`, `integration.ts`, and `generic-metadata.ts`
  extractors. A single hung Metadata API call no longer wedges the
  whole ingest.
- **Source-level inactivity safety net in `failSoft`** — sources that
  stop emitting without erroring are now caught and surfaced.
- **WAL checkpoint hygiene during ingest** — periodic
  `wal_checkpoint(TRUNCATE)` keeps the journal bounded on long runs.

## 1.0.2 — graph completeness + ingest performance + macOS stability

### Graph completeness (silent-data-loss fixes)

- **`CustomObject` parser inline-fields path** — live-org ingest builds
  CustomObject XML with **inline `<fields>` elements** sourced from
  `conn.sobject(name).describe()`. The parser previously only handled
  the source-tree layout (separate `*.field-meta.xml` files via
  `input.fields`), so every SObject ingested from a live org produced a
  parent node with **zero CustomField children and zero edges**. Parser
  now walks the inline array and emits `CustomField:<obj>.<field>`
  nodes, `DEFINES_FIELD` edges, and `REFERENCES_OBJECT` edges for every
  `referenceTo` target on the field (lookups, master-detail, polymorphic
  owners). `trace_downstream` on standard objects (Account, Contact,
  Opportunity, …) now returns the full schema neighbourhood.
- **OmniStudio element graph** — `omnistudio.ts` extractor previously
  queried only `SELECT Id, Name, OmniProcessType FROM OmniProcess`, but
  parsers walked `metadata.elements[].propertySet` looking for
  `dataTransformName` / `integrationProcedureKey` / `cardName`. None
  existed on the parent row. New second-pass batches
  `OmniProcessElement` per parent and JSON-parses each row's
  `PropertySet`. Parsers now emit `OMNI_CALLS_DATA_TRANSFORM` /
  `OMNI_EMBEDS_UI_CARD` / `OMNI_CALLS_INTEGRATION_PROCEDURE` /
  `OMNI_INVOKES_REMOTE` edges.
- **Vlocity datapack content** — the vendored `vlocity_build`
  `QueryDefinitions.yaml` selects only `Id, Name, GlobalKey`; never the
  long-text blobs (`Content__c`, `PropertySet__c`, `Definition__c`)
  where the datapack body lives. SOQL is now enriched per-type with
  those columns, namespace-prefixed keys are normalised
  (`vlocity_cmt__Type__c` → `Type`), blobs are JSON-parsed server-side,
  and a second-pass child fetch runs against `Element__c` /
  `DRMapItem__c` for OmniScript / IntegrationProcedure / DataRaptor.
  Parser walks now emit `IP_CALLS_DR` / `OS_USES_DR` / `DR_READS_FIELD` /
  `DR_WRITES_FIELD` / `VC_USES_DR` / `EMBEDS_VC` edges; the Vlocity
  surface was previously a graph of disconnected nodes.
- **Apex `apiVersion` from live ingest** — `ApexClass` / `ApexTrigger`
  Tooling SOQL now selects `ApiVersion` + `Status`. Extractor wraps
  body in a `{body, metaXml}` JSON envelope; adapter unwraps and
  forwards a synthesised `<apiVersion>` meta XML to the parser. Live-
  ingested Apex nodes used to have `apiVersion: null` while filesystem-
  ingested ones had the real value.

### Ingest performance (3–5× on metadata-heavy orgs)

- **Default Metadata pool 3 → 5** — Salesforce Metadata API tolerates
  5–10 concurrent read calls comfortably; 3 left perf on the table.
- **Three new CLI flags / env vars** for pool sizing:
  `--tooling-pool <n>` / `SFGRAPH_TOOLING_POOL`,
  `--metadata-pool <n>` / `SFGRAPH_METADATA_POOL`,
  `--data-pool <n>` / `SFGRAPH_DATA_POOL`. CLI flags win over env vars.
  `configureDefaultPools()` live-mutates the Bottleneck singletons via
  `updateSettings`.
- **Parallel inter-extractor drain** — `mergeAsyncIterablesParallel`
  advances every source iterator concurrently via `Promise.race`.
  Previously serial: while Security ground through Profiles, Apex /
  Vlocity / Data pools sat at 0%. Now all three pools saturate
  simultaneously. Escape hatch: `SFGRAPH_SEQUENTIAL_SOURCES=1`.
- **Parallel intra-extractor batches** — every extractor's
  `metadata.read` calls now fire concurrently through
  `Promise.allSettled` against the rate-limit pool, instead of awaiting
  one batch at a time. Also fixes three pool-routing bugs in
  `security.ts` / `flow.ts` / `integration.ts` (which were using
  `scheduleQuery` / Tooling pool for what are clearly Metadata API
  calls). `object.ts` chunks `describe()` 25-at-a-time through the Data
  pool.
- **`Promise.allSettled` not `Promise.all`** — a rejecting batch no
  longer produces orphan rejections that crash the Node process under
  the default unhandled-rejection policy.

### macOS stability (silent-SIGKILL fix)

- **Auto re-sign all `.node` addons** in postinstall on darwin.
  macOS 26+ rejects "linker-signed adhoc" stamps on `dlopen()` and
  SIGKILLs the process — at kernel level, bypassing every JS handler.
  Postinstall now walks the install tree and re-signs every binding
  with `codesign --force --sign -` (no developer cert needed). Both
  on fresh install and after any rebuild.
- **`sfgraph doctor` macOS code-signing check** — verifies the binding
  signature via `codesign --verify --strict` and flags the brittle
  linker-signed stamp before the next ingest hits it. Emits the exact
  copy-paste `codesign` command in the fix hint.
- **Unhandled rejection + uncaught exception handlers** on the CLI
  entry print loudly instead of letting the process exit silently.

### Diagnostics

- **`sfgraph ingest --debug`** — heartbeat every 10s with heap/RSS/
  last-active source label, per-record parse and graph-merge phase
  logs, SIGTERM/SIGINT stack traces. Names the exact extractor and
  record on any silent exit. Cheap to leave on.
- **Per-record trace** in debug mode logs every `processOne` phase:
  `[trace] parse ←`, `[trace] parse ✓`, `[trace] graph-merge ←`,
  `[trace] graph-merge ✓`. The phase that completes vs. the one that
  doesn't disambiguates JS parser failure from native better-sqlite3
  crash.

## 1.0.1 — security + UX patches (post-v1.0.0)

### Security (audit findings)

- **P0**: read-only Proxy now blocks every top-level Tooling write method —
  `tooling.create`, `tooling.update`, `tooling.delete`, `tooling.executeAnonymous`,
  `tooling.deploy`, `tooling.runTests`, `tooling.request*` — not just
  `tooling.sobject(...)`. 9 new adversarial tests.
- **P1**: path-traversal in MCP org input. New `validateOrgIdentifier`
  rejects `..`, path separators, NUL bytes, Windows reserved names, etc.
  `safeOrgDbPath` containment-checks via `path.resolve` before opening
  any DB. Applied at every entry that builds an org DB path.
- **P1**: cross-org tools (`cross_org_diff`, `deployment_manifest_gen`)
  now correctly open two contexts — one SQLite per org — instead of
  comparing two org IDs inside one DB.
- **P1**: pinned `protobufjs` to `^7.2.5` via `pnpm.overrides` to clear
  the @xenova/transformers → onnxruntime-web → onnx-proto CVE chain.

### Ingest hardening

- **describeGlobal-based object extractor** replaces the EntityDefinition
  + metadata.read path that returned 0 records on Agentforce / scratch
  orgs. Now enumerates every visible SObject via `conn.describeGlobal()`
  and pulls fields via `conn.sobject(name).describe()` — universally
  available, no Metadata API permissions needed.
- **Fail-soft per metadata source**: one extractor failing (e.g.
  INSUFFICIENT_ACCESS on a single type) no longer aborts the run.
  Per-source skip is recorded and surfaced in an end-of-run summary
  bucketed by category (insufficient_access / rate_limit / not_found /
  network / unknown) with a targeted remediation recipe per bucket.
- **Skip report persisted** to `<dataDir>/<orgId>.skips.json` so
  `--retry-skipped` can replay only failed sources on the next run.
- **Per-source progress + 5s heartbeat** during fan-out so long ingests
  show liveness instead of going silent for minutes.

### CLI surface

- `sfgraph ingest --rebuild [--no-backup]` — move existing graph to
  `backups/` and start fresh; forced full sync.
- `sfgraph ingest --detect-deletions` — after a clean full sync, remove
  qnames present in the graph but not touched this run. Bails out on
  parse errors to avoid mass-wipe on transient SF errors.
- `sfgraph ingest --orgs a,b,c` / `--all` / `--parallel` —
  multi-org orchestrator (sequential by default).
- `sfgraph ingest --only <labels>` / `--retry-skipped` — partial refresh
  flows for rate-limit recovery and post-permission backfill.
- `sfgraph ingest --embed-model <path> / --embed-model-id <id> /
  --embed-model-dim <n>` — BYO embedding model (also via
  `SFGRAPH_EMBED_MODEL_PATH/ID/DIM` env vars).
- `sfgraph snapshot {list,create,diff,prune,delete}` — full snapshot
  subcommand the README's Step 5 referenced but wasn't actually wired.
- `sfgraph link --org <alias>` + `sfgraph wip` — WIP local-impact
  workflow for uncommitted sfdx-source changes. Workspace concept stored
  at `~/.sfgraph/workspaces/<projectHash>.json`.
- `sfgraph install --local` — write an MCP entry pointing at the local
  build (`node <absPath> mcp`) instead of npx-ing a not-yet-published
  package. Lets you wire Cursor / Claude / VS Code into a dev checkout.

### MCP tools added

- `list_orgs` — enumerates orgs from sf CLI auth AND local data dir
  (two-pass fallback so an unreachable sf auth context doesn't hide
  ingested graphs).
- `staleness_check` — single-org freshness with the exact CLI command
  to refresh.
- `explain_code` — read a stored code snippet + cache an LLM
  explanation back to the graph (migration v6: `_sfgraph_snippets`).
- `wip_impact` / `wip_diff` / `wip_test_gap` — uncommitted local source
  overlay tools.

### Skills

- `sf-wip-impact`, `sf-schema-overview`, `sf-snapshot-compare`,
  `sf-metadata-refresh`, `sf-explain-code` — 5 new playbooks. Total now 15.
- All existing skills got `## Visualization` and `## Staleness check`
  sections.
- Cursor `.mdc` writer now emits proper Cursor frontmatter
  (`description / globs / alwaysApply`) so rules actually auto-attach
  on Salesforce file patterns instead of just being listed in the UI.

### MCP wiring fixes

- `@salesforce/core` and `better-sqlite3` now declared as direct deps
  on `@ryanstark24/sfgraph-server` so ESM resolution from
  `mcp-server/dist/...` actually finds them. Without this, `list_orgs`
  silently returned empty when invoked from a Cursor child process.
- Auth resolves alias → username via `@salesforce/core`'s
  `StateAggregator` before calling `AuthInfo.create({username})`. Fixes
  `E_SF_AUTH: No authorization information found for <alias>` on orgs
  that ARE registered and connected per `sf org list`.
- Windows: MCP config writer emits `npx.cmd` on win32 + platform-aware
  VS Code path (`%APPDATA%/Code/User/mcp.json`).

### Documentation

- `docs/ARCHITECTURE.md` deep-dive added covering ingestion / embedding
  / DB-loading / parallel-org math / snapshot model / WIP workflow /
  snippet store / Windows.
- README rewritten for npm-page consumption (Python → TS pivot
  disclaimer, design decisions table, initial ingestion walkthrough,
  Windows note, custom-model usage, multi-org refresh).
- `docs/TOOLS.md` covers all 25 tools.
- `docs/SKILLS.md` covers all 15 skills.
- `docs/PRIVACY.md` corrected: machine-id is a random UUIDv4 generated
  only on opt-in (was incorrectly described as a hash of OS user + host).

### Quality

- Test count grew from 298 → 433 (post-1.0.0 patches added ~130 tests
  including the audit-fix suites).
- `pnpm audit` clears all high/critical CVEs; only 2 moderate dev-only
  findings (vitest → vite, esbuild) remain — never ship to users.

## 1.0.0

First general-availability release. The TypeScript engine is now feature-
complete for the v1 charter.

### Phase 0 — Scaffold

- pnpm workspace, 7 packages stubbed.
- TS strict-mode, Biome lint/format, Vitest, GitHub Actions CI.
- Read-only Salesforce connection Proxy.
- Telemetry scaffolding (`NullSink`, `LocalFileSink`, `Sanitizer`) with 50+
  adversarial tests.

### Phase 1 — Storage, snapshots, freshness

- `GraphStore` SQLite impl with composite PK `(org_id, qualified_name)`.
- `VectorStore` via `sqlite-vec` partitioned by `org_id`.
- `SnapshotStore` with copy-on-snapshot tables and 30-day retention.
- Migration registry with pre-migration auto-backup.
- Freshness columns on every node; 50k synthetic-node perf gate.

### Phase 2 — Typed parsers

- Apex (apex-parser), LWC (Babel + parse5), Flow (fast-xml-parser).
- Object/Field + record types + validation rules.
- Vlocity hot-4: DataRaptor, IntegrationProcedure, OmniScript, Card.
- OmniStudio native: OmniProcess, OmniDataTransform, OmniUiCard,
  OmniIntegrationProcedure.
- Security: Profile, PermissionSet, SharingRule.
- Integration: NamedCredential, ExternalServiceRegistration, PlatformEvent.
- Cross-flavor resolver + piscina worker pool.

### Phase 3 — Live sync

- `@salesforce/core` auth, `jsforce` wrapped read-only.
- Capability probe, bulk-retrieve, SourceMember polling.
- `sfgraph ingest --org <alias>` end-to-end.

### Phase 4 — Tools + render + visuals

- 19 MCP tools (impact, trace, cross-org, security, governor, dead-code,
  deployment manifest, snapshot, what-broke, freshness, ...).
- Mermaid render layer with dual `{ summary, markdown, data }` envelope.

### Phase 5 — Skills + installer + binary

- 10 SKILL.md playbooks under `packages/skills`.
- `sfgraph install` writes Cursor / Claude / VS Code MCP config.
- Vendored MiniLM-L6-v2 (Git LFS) + checksum loader.

### Phase 6 — Long-tail parsers, analysis tables, manifest, docs

- 15 long-tail parsers: ApexPage, ApexComponent, FlexiPage, Layout, Report,
  Dashboard, GenAiPlanner, GenAiPlugin, Network, Workflow, ApprovalProcess,
  DuplicateRule, MatchingRule, CustomMetadata, CustomLabels,
  PermissionSetGroup, plus a generic OpaqueNodeParser fallback for the rest
  of the metadata long-tail.
- Schema v5: pre-computed `_sfgraph_findings`, `_sfgraph_dead_code_scores`,
  `_sfgraph_governor_risks`, `_sfgraph_test_coverage` tables.
- `analyze/populate.ts` runs in `liveIngest` to materialize cached analysis.
- `governor_risk_check`, `dead_code_audit`, `security_audit` read cached
  tables when present (< 50 ms hot path).
- `deployment_manifest_gen` emits real package.xml + destructiveChanges.xml
  with API-version fallback and label-aware member formatting.
- Documentation: `TOOLS.md`, `SKILLS.md`, `PRIVACY.md`, root `README.md`.

### Notes

- SQLite divergence: `_sfgraph_findings` PK uses `line` directly (sentinel
  `-1` for "no specific line") instead of `IFNULL(line,0)` because SQLite
  does not permit expressions in PRIMARY KEY declarations.
