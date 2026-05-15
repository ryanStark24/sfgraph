# Contributing to sfgraph

Thanks for digging in. This monorepo ships `@ryanstark24/sfgraph-*` packages — a Salesforce metadata knowledge graph (CLI + MCP server + local web visualiser).

## Prerequisites

- **Node.js ≥ 20** (v22 recommended)
- **pnpm ≥ 10** (`npm install -g pnpm`)
- **Git LFS** — the vendored embedding model lives in LFS. Initialise it **before** the first `pnpm install` so the `.onnx` binaries actually resolve:

  ```bash
  git lfs install
  git lfs pull
  ```

- **`sf` CLI** with at least one authenticated org — needed for any live-ingest test against a real org.

## First-time setup

```bash
git clone https://github.com/ryanStark24/sfgraph
cd sfgraph
git lfs install && git lfs pull
pnpm install
pnpm -r build
pnpm -r test
pnpm -r lint
```

If `better-sqlite3` errors with `NODE_MODULE_VERSION` / `Module did not self-register`, the auto-rebuild in `apps/sfgraph/bin/sfgraph.mjs` will recover on the next CLI invocation. To force it manually: `pnpm rebuild better-sqlite3`.

## Workflow

- Branch off `master`. Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
- Run the full triplet before opening a PR: `pnpm -r build && pnpm -r test && pnpm -r lint`.
- Add a changeset for any user-visible change: `pnpm changeset`.
- Never commit secrets. The repo is read-only against Salesforce by design — don't introduce write paths.

## Adding a parser rule

Declarative parsers live in `packages/core/src/parsers/rules/` as `*.yml`. Each rule file describes how to map one Salesforce metadata type to nodes + edges. Schema in brief:

```yaml
name: my-rule
metadataType: MyMetadataType
node:
  label: MyLabel
  qnameFrom: $.fullName
edges:
  - relType: REFERENCES_OBJECT
    direction: out
    targetFrom: $.referencedObject
```

`loadAllRules()` zod-validates every YAML file at ingest start; a malformed rule fails fast. Add a fixture under `packages/core/src/parsers/rules/__tests__/` covering at least one happy-path and one missing-field case.

## Adding a skill

Skills live at `packages/skills/skills/<name>/SKILL.md` with frontmatter:

```yaml
---
name: sf-my-skill
description: One-line intent.
triggers:
  - "natural-language trigger phrase"
tools_used:
  - some_mcp_tool
when_to_use: short rubric for the agent
---
```

Body: playbook, response shape, visualisation choice, "don't"s. Then update `packages/skills/src/__tests__/installer.test.ts` if you've changed the skill count, and add the row to `docs/SKILLS.md` and the README skill table.

## Adding an MCP tool

1. Implement in `packages/mcp-server/src/tools/<your-tool>.ts`. Return the standard envelope `{ summary, markdown, data, follow_up_tools? }`.
2. Register in `packages/mcp-server/src/tools/index.ts` (input schema via zod, dispatch).
3. Add a test under `packages/mcp-server/src/tools/__tests__/`.
4. Document it in `docs/TOOLS.md` and add the row to the README MCP-tools table.

## Running the web visualiser in dev

```bash
pnpm --filter @ryanstark24/sfgraph-web build
cd packages/web && node dist/index.js
# or, after `pnpm -r build`:
sfgraph serve
```

The visualiser is vanilla JS + `3d-force-graph` + three.js — no React, no bundler. Edit `packages/web/src/` and rebuild.

## Source of truth

Notion is the single source of truth for tasks, decisions, and progress. Plan changes there before writing code. See the user-level `CLAUDE.md` for the full standards.
