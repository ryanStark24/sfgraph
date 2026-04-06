# Release Checklist

## Pre-release

- [ ] `uv sync --all-extras`
- [ ] `uv run pytest -m "not integration"`
- [ ] `uv build`
- [ ] `uv run sfgraph --help`
- [ ] `uv run sfgraph benchmark <export_dir>`

## Versioning

- [ ] Bump `project.version` in `pyproject.toml`
- [ ] Update changelog/release notes
- [ ] Tag release in git (`vX.Y.Z`)

## Publish

- [ ] Create GitHub release (triggers `publish.yml`)
- [ ] Verify package appears on PyPI
- [ ] Install from clean env and run:
  - [ ] `sfgraph --help`
  - [ ] `sfgraph ingest <export_dir>`
  - [ ] `sfgraph query "what uses Account.Status__c?"`

## Post-release

- [ ] Smoke test MCP tools in client
- [ ] Validate migration runbook for existing users
