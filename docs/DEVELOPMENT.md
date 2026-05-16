# Development

```bash
git clone https://github.com/ryanStark24/sfgraph
cd sfgraph
git lfs install && git lfs pull   # required — pulls the vendored embedding model binaries
pnpm install
pnpm build          # build all packages
pnpm test           # full test suite
pnpm typecheck      # strict TS
pnpm lint           # Biome
```

Required: Node ≥ 20, pnpm 10. Git LFS must be initialised before `pnpm install` so the MiniLM ONNX weights resolve.

## Refresh vendored assets

To refresh the vendored Vlocity registry (quarterly):

```bash
pnpm vlocity:refresh
```

To re-fetch the vendored embedding model:

```bash
pnpm models:refresh
```

## Package layout

```
apps/
  sfgraph/                              # the published npm binary
packages/
  shared/                               # cross-cutting types, errors, logger, paths, workspace
  core/                                 # engine
    src/storage/                        #   SQLite + sqlite-vec graph/vector/snapshot stores
    src/extractors/live-org/            #   capability probe + describeMetadata dispatch
      vlocity/                          #     vendored QueryDefinitions.yaml (5 namespaces)
    src/extractors/filesystem/          #   walks sfdx-source for WIP local analysis
    src/parsers/
      apex/ lwc/ flow/ object/ vlocity/ #     code parsers (complex AST work)
      rules/                            #     21 YAML rule files (declarative parsers)
    src/embedding/                      #   batched transformers.js queue
    src/analyze/                        #   dependents, freshness, governor, dead-code, ...
    src/render/mermaid/                 #   diagram generators
  mcp-server/                           # stdio MCP, 26 tools, shutdown discipline
  cli/                                  # install, ingest, link, wip, mcp, telemetry, version
  skills/                               # 17 SKILL.md playbooks + installer
  web/                                  # local 3D web visualiser (`sfgraph serve`)
  models/                               # vendored MiniLM ONNX + loader
```

## Published packages

Only the binary is what most users install. The engine and server libraries are exposed for downstream tooling.

| Package | Purpose |
|---|---|
| [`@ryanstark24/sfgraph`](https://www.npmjs.com/package/@ryanstark24/sfgraph) | The CLI binary. What 99% of users install. |
| `@ryanstark24/sfgraph-core` | Engine library. Use if you're embedding sfgraph in custom tooling. |
| `@ryanstark24/sfgraph-server` | MCP server library. |
| `@ryanstark24/sfgraph-cli` | CLI as a library. |
| `@ryanstark24/sfgraph-skills` | Skill playbooks + installer. |
| `@ryanstark24/sfgraph-shared` | Shared types and errors. |
| `@ryanstark24/sfgraph-models` | Vendored embedding model (MiniLM L6 v2 quantized, ~30 MB via Git LFS). |
