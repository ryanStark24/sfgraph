# Third-Party Notices

`sfgraph` references public upstream projects as standards inputs for the
Vlocity / OmniStudio parsing model.

## Referenced Projects

- `vlocityinc/vlocity_build`
  - used as a behavioral/spec reference for DataPack configuration, matching
    keys, and query-definition concepts
  - upstream license: MIT
- `Codeneos/vlocode`
  - used as a behavioral/spec reference for dynamic datapack info discovery and
    matching-key access patterns
  - upstream license: MIT

## Current Usage Model

The current implementation uses a spec-first reimplementation approach:

- no runtime dependency on upstream repositories
- no direct embedded upstream code required for execution
- bundled local baseline metadata lives in:
  - `src/sfgraph/config/vlocity_standards_baseline.yaml`

If vendored upstream metadata snapshots are added later, this notice should be
expanded with file-level attribution.
