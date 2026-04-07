# Release Notes

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
