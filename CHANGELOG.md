# Changelog

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
