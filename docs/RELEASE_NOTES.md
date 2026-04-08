# Release Notes

## 0.1.0-beta.5

This beta focuses on job isolation/cancellation correctness, lower-noise query workflows, and better OmniStudio array-pack ingestion.

### Added

- `ask(question, ...)` MCP entrypoint as the recommended one-call Q&A tool (exact-first auto routing).
- `resume_ingest_job(job_id)` support for checkpoint-aware job resume.
- CI quality comparator script: `bin/compare_sfgraph_vs_native.py`, wired into `.github/workflows/quality-gate.yml`.

### Changed

- Background ingest/refresh/vectorize execution moved to subprocess isolation for stronger cancellation behavior and better API responsiveness.
- `analyze(mode="auto")` now routes to intent analyzers first (`analyze_field`, `analyze_component`, `analyze_object_event`, `analyze_change`) before generic search fallback.
- FastEmbed/ONNX runtime logging is reduced to avoid repetitive offline/noise logs in normal operation.

### Fixed

- Supported non-object Vlocity array families now parse when exports are wrapped in envelope objects (not only top-level arrays), including:
  - `PromotionItems`
  - `PriceListEntries`
  - `InterfaceImplementationDetails`
  - `ProductChildItems`

### Notes

- Legacy tools (`ingest_org`, `refresh`, `vectorize`, `query`) remain for compatibility, but `start_*_job` + `ask/analyze` are the preferred paths.

## 0.1.0-beta.4

This beta is focused on production-scale ingest reliability, broader OmniStudio/Vlocity coverage, and stricter local-only defaults.

### Added

- Generic `VlocityDataPack` fallback parsing so supported Vlocity/OmniStudio JSON types no longer disappear as empty skips.
- Upstream-backed Vlocity type registry seeded from `vlocity_build`'s supported DataPack inventory.
- Live ingest progress support in the MCP/CLI flow from earlier beta work remains included in this release line.

### Changed

- Apex worker ingest now prefers reading files from disk instead of shipping full source bodies over newline-delimited IPC.
- JSON discovery is narrower and more intentional, reducing ingestion of unrelated JSON files.
- Nested repositories inside the export/workspace tree are skipped during discovery instead of being indexed accidentally.
- Local-only runtime behavior is now the default:
  - LLM query-agent calls require `SFGRAPH_ALLOW_NETWORK=1`
  - embedding model downloads require `SFGRAPH_ALLOW_NETWORK=1`

### Fixed

- Parser worker stderr is surfaced in logs for easier diagnosis of worker exits and module-resolution issues.
- Packaged config assets now load correctly from installed distributions.
- Apex parser dependency resolution is more robust in launcher-driven installs.
- Ingestion docs and IDE setup docs now match the enforced runtime behavior.

### Notes

- This release provides baseline support across the upstream Vlocity type inventory, but not every one of those types has rich bespoke graph semantics yet.
- Core metadata parsing and graph storage remain local to the machine by default.
