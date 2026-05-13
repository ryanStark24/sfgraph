# sfgraph

A local, privacy-first knowledge graph for Salesforce orgs.

## Privacy pillars

- **Local-only data.** All ingested metadata is stored on your machine in a per-org SQLite file. Nothing is uploaded.
- **Read-only Salesforce APIs.** The jsforce connection is wrapped in a runtime Proxy that throws on any write operation (DML, metadata deploy, tooling writes, non-GET HTTP). Verified at the call site, not just by convention.
- **Telemetry default off, sanitized when on.** Telemetry is opt-in. When enabled, every emitted event is run through an allowlist-based sanitizer that strips paths, emails, Salesforce hosts, bearer tokens, session ids, UUIDs, and Salesforce record ids before it touches a sink.
- **Zero codebase egress.** Source code, metadata, and query results never leave the host.

## Package layout

```
packages/
  shared/        @sfgraph/shared       cross-cutting: errors, logger, paths, types
  core/          @sfgraph/core         domain, telemetry, extractors, parsers
  models/        @sfgraph/models       vendored embedding model (Git LFS)
  skills/        @sfgraph/skills       SKILL.md playbooks (Phase 5)
  mcp-server/    @sfgraph/mcp-server   stdio MCP server, tool registry
  cli/           @sfgraph/cli          sfgraph CLI commands
apps/
  sfgraph/                             unscoped binary npm package
```

## Status

Phase 0 scaffold. See `docs/PLAN.md` for the full roadmap.
