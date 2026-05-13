# sfgraph

A local, privacy-first knowledge graph for Salesforce orgs. Live-syncs an org
to a SQLite graph + vector store on your machine and exposes 19 MCP tools to
Cursor / Claude / VS Code.

## Privacy pillars

1. **No codebase egress.** Graph and vectors stay in `~/.sfgraph/`.
2. **Read-only Salesforce access.** Every connection is wrapped in a Proxy
   that rejects mutating methods.
3. **Failure-only, sanitized telemetry**, default off, local sink only.

See `docs/PRIVACY.md`.

## Quickstart

```bash
pnpm install                       # 1. install workspace
pnpm build                         # 2. build packages
node apps/sfgraph/bin/sfgraph.mjs install   # 3. wire IDE
sfgraph ingest --org my-prod       # 4. live sync
# 5. open Cursor / Claude / VS Code — `sfgraph_*` tools are now available
```

## Package layout

```
packages/
  shared/      cross-cutting types, errors, logger, paths
  core/        engine: storage, parsers, extractors, analyze, render
  mcp-server/  stdio MCP, 19 tools, shutdown discipline
  cli/         install / ingest / snapshot / telemetry CLI
  skills/      10 SKILL.md playbooks
  models/      vendored MiniLM ONNX
apps/
  sfgraph/     unscoped npm binary
legacy/        Python prototype, retained through 1.0.x
```

## Further reading

- `docs/TOOLS.md` — full MCP tool catalog
- `docs/SKILLS.md` — skill playbooks
- `docs/PRIVACY.md` — read-only + sanitizer details
- `docs/MIGRATING_FROM_PYTHON.md` — coming from the legacy prototype
- `docs/ARCHITECTURE.md` — internals
- `CHANGELOG.md` — per-phase release notes
