# Changelog

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
