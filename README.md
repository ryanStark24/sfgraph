# @ryanstark24/sfgraph-mcp

[![npm](https://img.shields.io/npm/v/@ryanstark24/sfgraph-mcp.svg)](https://www.npmjs.com/package/@ryanstark24/sfgraph-mcp)
[![license](https://img.shields.io/npm/l/@ryanstark24/sfgraph-mcp.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@ryanstark24/sfgraph-mcp.svg)](https://nodejs.org)

A **local, privacy-first knowledge graph for Salesforce orgs**. `sfgraph` live-syncs your org to a SQLite + vector index on your machine and exposes 25 MCP tools to **Cursor, Claude Code/Desktop, and VS Code**, so the AI you already use can reason about Apex, LWC, Flow, Vlocity, OmniStudio, security, and integrations **without your code or schema ever leaving your laptop**.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Cursor / Claude / VS Code   ←──── MCP stdio ────→   sfgraph         │
│                                                                      │
│              read-only Salesforce APIs    ──→    your org            │
│              local SQLite + sqlite-vec    ←──    ~/.sfgraph/         │
└──────────────────────────────────────────────────────────────────────┘
```

> **Disclaimer — v1.0 is a from-the-ground-up TypeScript rewrite.**
> The Python prototype (`sfgraph@0.1.x`) is retired. The new implementation is in TypeScript, runs as an MCP server, ships per-org SQLite + vector storage, and exposes a stable tool surface. **See [Why we pivoted from Python to TypeScript](#why-we-pivoted-from-python-to-typescript) below for the rationale.** If you were on the Python version, install fresh; there is no auto-migration path because the storage backend is incompatible.

## Privacy pillars

1. **No codebase egress.** Graph, vectors, embeddings, logs — all in `~/.sfgraph/`. Nothing is uploaded anywhere by this tool.
2. **Read-only Salesforce access.** Every `jsforce`/`@salesforce/core` connection is wrapped in a Proxy that throws `ReadOnlyViolationError` synchronously on every mutating method (`create`, `update`, `delete`, `deploy`, …). Verified by 41 adversarial tests.
3. **Telemetry default OFF.** If you ever enable it, an allowlist + sanitizer scrubs paths, emails, SF hosts, bearer tokens, UUIDs, and SF Ids before anything is written. **Local file sink only — there is no remote endpoint.** See [`docs/PRIVACY.md`](docs/PRIVACY.md) for the full threat model.
4. **No credentials handled.** Auth is delegated to the `sf` CLI (`~/.sfdx/`). `sfgraph` never sees a password and never persists an access token.

---

## Quickstart for a brand-new install

### Prerequisites you install yourself (3 things)

| | Why | How |
|---|---|---|
| **Node.js ≥ 20** | sfgraph is a Node CLI + MCP server | [nodejs.org](https://nodejs.org) or `brew install node` |
| **`sf` CLI** (Salesforce CLI) | Read-only org auth — we never see your password; the token stays in `~/.sfdx/` | `npm install -g @salesforce/cli` |
| **At least one `sf` login** | We need an org to read from | `sf org login web --alias my-prod && sf config set target-org=my-prod` |

Verify both with:

```bash
node --version          # v20+ (v22+ recommended)
sf --version            # @salesforce/cli/2.x
sf org list             # should show at least one org marked as default
```

### Dependencies sfgraph brings in automatically

`npm install -g @ryanstark24/sfgraph-mcp` pulls these transitively. You don't install them yourself — listed so you know what's running:

| Package | Why sfgraph uses it |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server protocol (stdio transport) |
| `@salesforce/core` | Org auth + alias resolution from `~/.sfdx/` (token never touches our process) |
| `jsforce` | Salesforce HTTP client — every connection wrapped in our read-only Proxy |
| `better-sqlite3` ⚠ native | Per-org SQLite graph + vector store. Postinstall auto-rebuilds the binding for your Node version. |
| `sqlite-vec` | `vec0` virtual tables for partition-pruned KNN |
| `@xenova/transformers` + `onnxruntime` | Local embedding model (MiniLM L6 v2, vendored, runs offline) |
| `bottleneck` + `p-limit` | Three rate-limit pools so we never exceed Salesforce API limits |
| `fast-xml-parser`, `@babel/parser`, `parse5`, `apex-parser` | Metadata parsing (XML, LWC JS/HTML, Apex AST) |
| `piscina` | Worker pool for parsing + embedding side-streams |
| `commander` | CLI |
| `zod` + `zod-to-json-schema` | MCP tool input validation |

The two native modules (`better-sqlite3`, optional `onnxruntime`) trigger a compile-or-prebuilt step on install. We auto-handle the common ABI-mismatch case via a postinstall verifier (see [Troubleshooting](#troubleshooting)).

**Windows note.** sfgraph runs on Windows 10/11 under Node ≥ 20. Install via `npm install -g @ryanstark24/sfgraph-mcp`; the `sfgraph install` command writes the MCP host config with `npx.cmd` (not `npx`) so Claude Code / Cursor on Windows invoke the right binary. Make sure Git LFS is installed before `npm install` so the vendored embedding model resolves on first ingest.

### Step 1 — Install sfgraph

```bash
npm install -g @ryanstark24/sfgraph-mcp
# or use it on-demand via npx (no install):
#   npx @ryanstark24/sfgraph-mcp <command>
```

After global install, the binary is available as `sfgraph` on your PATH.

### Step 2 — Wire it into Cursor / Claude Code / VS Code

```bash
sfgraph install
```

This is **idempotent and reversible**. It does two things:
- Copies 10 skill playbooks (`SKILL.md` files) into `~/.claude/skills/` and `~/.cursor/rules/`.
- Adds a `sfgraph` entry to your editor's MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `~/.cursor/mcp.json`, `~/.config/Code/User/mcp.json`). Existing MCP entries are preserved.

Use `sfgraph install --dry-run` to see what would be written without writing. Use `--target=claude` (or `cursor`/`vscode`) to wire only one editor.

### Step 3 — Run the **initial ingestion** of your org

This is the part new users always ask about. The first ingest does a **full sync** of every metadata type the org exposes. On a 50K-node sandbox it takes about **2–6 minutes** depending on which packages are installed (Vlocity-CMT and OmniStudio-on-Core add records-heavy retrievals). Subsequent ingests on a Source-Tracking-enabled org are **incremental** and finish in under 30 seconds.

```bash
# Uses the default org from `sf config get target-org`
sfgraph ingest

# Or explicitly pick an org
sfgraph ingest --org my-prod

# Sandbox vs prod? Just run it twice with different aliases:
sfgraph ingest --org my-sandbox
sfgraph ingest --org my-prod
```

What you'll see during initial ingest (annotated):

```
ingest: using default org from sf config: my-prod
ingest: resolving auth from ~/.sfdx/                       ← read-only Proxy wrapped here
ingest: probing capabilities…
ingest: capabilities { vlocityNamespaces: ['vlocity_cmt'],
                       omnistudioOncore: true,
                       sourceTracking: false,              ← prod usually has this off
                       experienceCloud: true,
                       agentforce: false }
ingest: discovered 187 metadata types via describeMetadata()
ingest: creating pre-sync snapshot (this is what `what_broke` looks back to)
ingest: fan-out — Tooling pool (5), Metadata pool (5), Data pool (10), parallel sources
ingest:   Apex                                ✓ 1248 classes, 89 triggers
ingest:   LWC bundles                         ✓ 234 bundles
ingest:   Flow                                ✓ 412
ingest:   CustomObject                        ✓ 89 standard + 184 custom
ingest:   Profile + PermissionSet             ✓ 47 profiles, 156 perm sets
ingest:   Vlocity (vlocity_cmt)               ✓ 48 DataPack types
ingest:   OmniStudio native                   ✓ 67 OmniProcess + 23 OmniDataTransform
ingest: populating cached analysis tables…
ingest: cross-flavor resolver: 23 CANONICAL_OF edges (Vlocity ↔ OmniStudio)
ingest: embedding queue draining…             ← runs in parallel to parsing
ingest: complete mode=full members=12483 deletions=0 parseErrors=2 elapsed=247314ms
```

The result lands in `~/.sfgraph/<orgId>.sqlite`. From here on, every MCP tool reads from this file — no network calls.

### Step 4 — Open Cursor / Claude / VS Code and ask questions

Restart your IDE so it picks up the new MCP entry. Then in any project, ask the agent:

- *"What does this PR break?"* — agent invokes `sf-impact-from-diff`
- *"Who can edit `Account.Status__c`?"* — agent invokes `sf-security-audit`
- *"What changed in prod since last week?"* — agent invokes `sf-cross-org-diff`
- *"Show me how `accountTile` flows from UI to DB"* — agent invokes `sf-cross-layer-trace`

### Step 5 — Keep the graph fresh

The graph is a snapshot of what the org looked like at last ingest. Re-run `sfgraph ingest` periodically (or before any analysis where staleness matters). Skills warn you when the data is **older than 7 days**.

```bash
sfgraph ingest                       # re-sync; incremental on Source-Tracking orgs
sfgraph snapshot list                # see all snapshots
sfgraph snapshot create --label "before-mass-deploy"   # take a labeled snapshot
```

#### Refreshing multiple orgs at once

```bash
# Explicit alias list, sequentially:
sfgraph ingest --orgs prod,uat,qa

# Every authenticated org from `sf`, sequentially:
sfgraph ingest --all

# Same, but fan out concurrently (per-org failures don't kill the batch):
sfgraph ingest --orgs prod,uat,qa --parallel
sfgraph ingest --all --parallel
```

Each run prints a per-org results table (Org | Mode | Members | Deletions | ParseErrors | Elapsed | Status). With `--parallel`, the rate-limit pools (Tooling 5 / Metadata 5 / Data 10) are shared across orgs in the same process — Bottleneck handles concurrent `schedule()` calls and the conservative budget stays well under per-token SF limits.

#### Full rebuild from scratch

```bash
sfgraph ingest --rebuild --org prod
# Existing graph moved to ~/<sfgraph-data>/backups/<orgId>.rebuild-<ISO>.sqlite

sfgraph ingest --rebuild --no-backup --org prod
# Existing graph deleted outright (no backup taken)
```

`--rebuild` forces `mode=full` regardless of Source Tracking and starts from an empty DB. Useful when parser logic has changed and you want a clean reparse, or when you suspect the graph has drifted from reality.

#### Snapshot management

```bash
sfgraph snapshot list                                       # all snapshots for current org
sfgraph snapshot create --label "before-deploy-v42"         # labelled manual snapshot
sfgraph snapshot create --label "nightly-2026-01-15" --kind scheduled
sfgraph snapshot diff snap_abc123 current                   # diff a snap vs. current graph
sfgraph snapshot diff snap_abc123 snap_def456               # diff two snaps
sfgraph snapshot prune --retain-days 30                     # delete auto-snapshots older than 30d
sfgraph snapshot delete snap_abc123                         # delete a specific snapshot
```

Pre-sync auto-snapshots are created automatically by `sfgraph ingest`; the CLI commands above are for manual / scheduled snapshots.

#### Detect deletions on a full sync

```bash
sfgraph ingest --detect-deletions --org prod
```

On Source-Tracking-enabled orgs, deletions surface automatically via `SourceMember.IsNameObsolete` during incremental sync. On production orgs without Source Tracking, full syncs don't see what's gone — they only see what currently exists. `--detect-deletions` computes the set of qnames present in the graph before the sync but NOT touched during it, and removes them. **Bails out if any parse error occurred during the run** so a transient SF API hiccup never wipes the graph.

### Custom embedding model

sfgraph ships a vendored, quantized **all-MiniLM-L6-v2** model that runs locally via `@xenova/transformers` (WASM, zero network). If you need a different model — a domain-tuned one, a multilingual variant, or your own internal embedding — point sfgraph at it:

```bash
# CLI flag (per-invocation)
sfgraph ingest --embed-model /path/to/model.onnx

# Environment variable (persistent)
export SFGRAPH_EMBED_MODEL=/path/to/model.onnx
```

The model must produce 384-dimensional vectors to match the existing `vec0` schema. The first embed of an ingest loads the model lazily; subsequent ingests of unchanged content short-circuit on the cached `content_hash` and never re-embed.

### Parallel org ingest

Bottleneck rate-limit pools live **per Node process**. That means:

- Multiple `sfgraph ingest` processes for **different orgs** run in parallel and don't fight each other — each has its own Tooling/Metadata/Data pools, and Salesforce's per-org API budgets are also separate. Spawn one process per org.
- Multiple `sfgraph ingest` processes for the **same org** are not supported and will contend on the SQLite write lock. Don't do this.
- A single process can serially ingest several orgs (`sfgraph ingest --org A && sfgraph ingest --org B`), but throughput is lower than two parallel processes.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full ingestion-pipeline deep-dive.

---

## Why we pivoted from Python to TypeScript

`sfgraph` started as a Python project (`sfgraph@0.1.x` on PyPI). v1.0 is a clean-room TypeScript rewrite. Four reasons drove the pivot:

1. **MCP-native tooling.** [Anthropic's Model Context Protocol](https://modelcontextprotocol.io) has first-class SDK support in TypeScript. The `@modelcontextprotocol/sdk` package gives us stdio transport, schema validation, and tool dispatch for free. The Python MCP ecosystem exists but trails the TypeScript one in stability and feature parity. For a tool whose primary surface *is* MCP, picking the better-supported language was a one-way decision.
2. **Salesforce ecosystem alignment.** The official `@salesforce/cli`, `@salesforce/core`, and `jsforce` libraries are all TypeScript. Running on the same runtime as the user's `sf` CLI means we read `~/.sfdx/` auth state with zero translation, no wrapper, and no separate token cache.
3. **Single-binary distribution via npm.** A Salesforce developer almost always has Node.js installed (it powers `sf`, Vlocity Build, Codey, sfdx-source-deploy). Asking them to also install Python 3.12 + a virtualenv + `uv` was friction. `npx @ryanstark24/sfgraph-mcp install` runs on any machine that already has `sf` working.
4. **Strict typing for a graph engine.** sfgraph's value depends on the integrity of `NodeFact` / `EdgeFact` shapes across ~25 metadata categories. TypeScript with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax` catches at compile-time the same class of bugs that Python's `mypy --strict` catches at lint time — and the rest of the stack (Biome, Vitest, Changesets) was already in that ecosystem.

The Python codebase is retired; no v0.x branches are maintained. If you're upgrading, install the npm package and re-ingest. There is no data migration because the storage layer changed from DuckDB / FalkorDB to SQLite + sqlite-vec (see [Design decisions](#design-decisions-in-v10) below).

---

## Design decisions in v1.0

Major architectural choices and why they were made. Each one was a deliberate decision, not a default.

| Decision | Choice | Why |
|---|---|---|
| **Storage backend** | SQLite + sqlite-vec, one file per org | Zero-install. Survives reboots. WAL journaling. vec0 partitions by `org_id` so cross-org search never spills into the wrong org. DuckDB was faster on some scans but added a 60MB native binary and concurrency complexity for stdio servers. |
| **Schema model** | Per-label node tables + per-rel-type edge tables, lazy CREATE | Composite PKs `(org_id, qualified_name)` on nodes, reverse-traversal index `(org_id, dst_qname)` on edges. "Who depends on X?" is as cheap as "what does X depend on?". |
| **Embeddings** | MiniLM-L6-v2 quantized ONNX, vendored via Git LFS, run in-process by transformers.js | No external embedding service. 384-dim vectors. ~30 MB binary that ships once. Batched inference in a side-stream queue so parsing never blocks. |
| **Parser dispatch** | `conn.metadata.describe()` at ingest start → runtime type registry | No hardcoded type list. New Salesforce releases or installed packages surface immediately. Unknown types route to a generic opaque-node parser; the graph is never blind. |
| **Code parsers vs. rules** | 6 code parsers (Apex/LWC/Flow/Object + 4 Vlocity JSON), 21 YAML rule files for the rest | Apex AST and LWC bundle work are too complex for declarative rules. Everything else (Profile, Layout, Workflow, Report, …) is field/edge mapping that fits in 30 lines of YAML. |
| **Vlocity coverage** | Vendor `vlocity_build/QueryDefinitions.yaml` (MIT), probe all 5 industry namespaces | Vlocity is in maintenance mode; the registry is stable. Vendoring is a 50-line file, not a runtime dependency on the `vlocity` npm package (which is a CLI binary, not a library). |
| **Cross-flavor resolver** | Post-pass that emits `CANONICAL_OF` edges between Vlocity-CMT and OmniStudio-on-Core duplicates | Many orgs are mid-migration. The agent treats `DataRaptor:X` and `OmniDataTransform:X` as the same logical asset without forcing the user to disambiguate. |
| **Live sync auth** | Delegated to `sf` CLI / `@salesforce/core` | We never see passwords. Token lives in `~/.sfdx/`. Re-using the user's existing login means zero new credentials to manage. |
| **Read-only enforcement** | Runtime Proxy, not just convention | Every mutating method on `jsforce` throws synchronously. Verified by 41 adversarial tests against the full method surface. Belt and braces vs. "we promise we don't write." |
| **Telemetry sink** | `LocalFileSink` only; no remote endpoint exists in the codebase | The pipeline has a slot for an HTTP sink reserved for v1.1, but it's not implemented. Local-only is a code-level guarantee, not a config flag. |
| **Rate limiting** | Three independent Bottleneck pools (Tooling 5 / Metadata 5 / SObject 10), drained in parallel | Salesforce throttles per-API. Separate budgets let us hit ~20 concurrent calls without violating any single limit. Source iterators are advanced concurrently so all three pools saturate at once — set `SFGRAPH_SEQUENTIAL_SOURCES=1` to revert to the legacy one-extractor-at-a-time drain. |
| **MCP tool envelope** | `{ summary, markdown, data, follow_up_tools? }` | Agents read `summary`. Humans read `markdown`. Programmatic consumers read `data`. `follow_up_tools` lets skills compose. |
| **Incremental sync** | `SourceMember` polling on Source-Tracking-enabled orgs | One Tooling SOQL, refetch only changed members. Sub-30s on sandboxes. Falls back to full sync on production orgs without source tracking. |

### What v1.0 brings that v0.x didn't

- **Real MCP server** instead of a CLI-only Python tool — works natively with Claude Code, Cursor, and VS Code without shell-out tricks.
- **Multi-org** as a first-class concept — every row in storage is partitioned by `org_id`; cross-org diff is one graph query.
- **Typed semantic edges** (`READS_FIELD`, `CALLS_DR`, `INVOKES_REMOTE_ACTION`, `GRANTS_FIELD_ACCESS`, …) replace the v0 heuristic walker's generic `REFERENCES`. ~80 typed relationship types now.
- **Snapshots + point-in-time diff** built into the storage layer. v0 had no notion of "what did the org look like an hour ago".
- **Cross-flavor resolver** for Vlocity ↔ OmniStudio. v0 treated them as separate worlds.
- **Capability-driven dispatch**: new metadata types ship with Salesforce releases and are picked up automatically. v0's parser dispatch was hardcoded per type.
- **Declarative rule engine** for parser authoring — adding support for a new type is a YAML file, not a Python module.
- **Vendored embedding model** (transformers.js + MiniLM-L6 ONNX) — v0 hit Qdrant / FastEmbed which required a separate service. v1 is process-local.

---

## CLI reference

```
sfgraph <command> [options]

Commands:
  install                              wire skills + MCP config into IDEs (idempotent)
  ingest                               sync a Salesforce org into the local graph (read-only)
  snapshot create | list               manage snapshots manually
  link                                 bind a local project folder to an org (for WIP analysis)
  wip                                  analyse local source for deploy impact (no push)
  mcp                                  start the MCP server over stdio (IDE invokes this)
  telemetry status|enable|disable|...  manage local telemetry (default OFF)
  version                              print sfgraph version
```

### `sfgraph install`

| Option | Default | Description |
|---|---|---|
| `--target <t>` | `all` | `claude`, `cursor`, `vscode`, or `all` |
| `--dry-run` | `false` | Preview without writing |
| `--skills-only` | `false` | Install skill playbooks; skip MCP config |
| `--mcp-only` | `false` | Write MCP config; skip skill playbooks |
| `--local` | `false` | Write MCP config that invokes the local binary directly (`node <absPath> mcp`) instead of `npx @ryanstark24/sfgraph-mcp`. Use during local dev before the package is published to npm. |

### `sfgraph link` + `sfgraph wip` (WIP local-impact analysis)

```bash
# One-time per sfdx project: bind the folder to an org
sfgraph link --org my-sandbox [--project <path>]

# Then analyse uncommitted local changes against the org graph
sfgraph wip [--depth N] [--mode changed-only|full-folder] [--project <path>] [--org <alias>]
```

`link` writes `~/.sfgraph/workspaces/<projectHash>.json` so the wip
command knows which org's graph to overlay your local source against.
`wip` parses the sfdx-source tree (`force-app/`), overlays transient
nodes onto the org's graph in-memory (never persisted), and runs the
same dependent-BFS as `impact_from_git_diff` — but for uncommitted
changes. Read-only against the persisted graph.

### `sfgraph ingest`

| Option | Default | Description |
|---|---|---|
| `--org <alias>` | `sf config target-org` | Salesforce alias/username from `sf` CLI |
| `--orgs <a,b,c>` | — | Comma-separated alias list (ignores `--org`) |
| `--all` | `false` | Iterate every authenticated org from `sf` (ignores `--org`) |
| `--parallel` | `false` | With `--orgs`/`--all`, run all orgs concurrently |
| `--mode <mode>` | `auto` | `full`, `incremental`, or `auto` |
| `--rebuild` | `false` | Move existing graph to `backups/`, open fresh DB, force full sync |
| `--no-backup` | — | With `--rebuild`, delete existing graph instead of backing it up |
| `--detect-deletions` | `false` | After full sync, delete qnames present in the graph but not touched this run |
| `--only <labels>` | — | Comma-separated source labels to fetch (e.g. `apex,generic:Profile`). Merges into the existing graph; no rebuild. |
| `--retry-skipped` | `false` | Re-fetch only sources skipped in the previous run (reads `<dataDir>/<orgId>.skips.json`). |
| `--embed-model <path>` | — | Absolute path to a custom embedding model dir (overrides the vendored MiniLM). Also reads `SFGRAPH_EMBED_MODEL_PATH`. |
| `--embed-model-id <id>` | `Xenova/all-MiniLM-L6-v2` | Model id under that dir. Also reads `SFGRAPH_EMBED_MODEL_ID`. |
| `--embed-model-dim <n>` | `384` | Embedding dimension. Also reads `SFGRAPH_EMBED_MODEL_DIM`. |
| `--tooling-pool <n>` | `5` | Max concurrent Tooling-API calls. Also reads `SFGRAPH_TOOLING_POOL`. |
| `--metadata-pool <n>` | `5` | Max concurrent Metadata-API calls. **Highest-leverage knob for slow ingests** — Profile/PermissionSet/Layout fans go through here. Bump to `8`–`10` on orgs with many of those. Also reads `SFGRAPH_METADATA_POOL`. |
| `--data-pool <n>` | `10` | Max concurrent SObject/Bulk SOQL queries. Also reads `SFGRAPH_DATA_POOL`. |
| `--db <path>` | `~/.sfgraph/<orgId>.sqlite` | Override SQLite database path |

Auto-detects default org from `sf config`. Auto-snapshot taken before every sync.

#### Recovering from rate-limit or permission skips

Every ingest writes its skip report to `<dataDir>/<orgId>.skips.json`. If
some types were rate-limited or permission-gated, wait for the quota to
refresh (or get the perm), then:

```bash
# Re-fetch ONLY the previously-skipped sources, no full rebuild
sfgraph ingest --org my-prod --retry-skipped

# Or target specific sources by label
sfgraph ingest --org my-prod --only generic:Profile,generic:Layout
```

#### BYO embedding model

```bash
# Point at any transformers.js-compatible model on disk
sfgraph ingest --org my-prod \
  --embed-model /path/to/models \
  --embed-model-id MyOrg/MyModel \
  --embed-model-dim 768

# Or via env (set once, sticks across runs)
export SFGRAPH_EMBED_MODEL_PATH=/path/to/models
export SFGRAPH_EMBED_MODEL_ID=MyOrg/MyModel
export SFGRAPH_EMBED_MODEL_DIM=768
sfgraph ingest --org my-prod
```

Checksum verification is skipped for user-supplied models (it's your
model, not ours to validate). The vendored MiniLM still verifies.

### `sfgraph snapshot`

```bash
sfgraph snapshot list [--org <alias>]
sfgraph snapshot create --label <name> [--kind manual|scheduled] [--org <alias>]
sfgraph snapshot diff <fromId> <toId|current> [--org <alias>]
sfgraph snapshot prune --retain-days <n> [--org <alias>]
sfgraph snapshot delete <snapshotId> [--org <alias>]
```

### `sfgraph telemetry`

```bash
sfgraph telemetry status            # default: disabled
sfgraph telemetry enable --local    # opt-in to local JSONL sink
sfgraph telemetry disable
sfgraph telemetry preview           # see a sanitized sample event
sfgraph telemetry purge             # delete the local file
sfgraph telemetry reset-id          # regenerate machine-id
```

---

## The 25 MCP tools (summary)

Every tool returns `{ summary, markdown, data, follow_up_tools? }`. The `markdown` includes a Mermaid block when a diagram aids comprehension.

| Category | Tools |
|---|---|
| **Inventory & freshness** | `ping`, `start_ingest_job`, `get_ingest_job`, `snapshot_create`, `snapshot_list`, `point_in_time_diff`, `freshness_report` |
| **Impact analysis** | `analyze_field`, `trace_upstream`, `trace_downstream`, `cross_layer_flow_map`, `cross_org_diff`, `impact_from_git_diff`, `test_gap_intelligence_from_git_diff`, `what_broke` |
| **Quality, security, deployment** | `governor_risk_check`, `dead_code_audit`, `security_audit`, `deployment_manifest_gen` |

Per-tool input/output samples and the algorithm each one uses live in [`docs/TOOLS.md`](docs/TOOLS.md). The "How the analysis actually works" section below explains the dispatch flow.

---

## The 15 skill playbooks

When you `sfgraph install`, 15 `SKILL.md` files land in `~/.claude/skills/` and `~/.cursor/rules/`. They route LLM intent to tool sequences so the agent picks up the right tool without you having to name it.

| Skill | Triggers like… | Tools used |
|---|---|---|
| `sf-impact-from-diff` | "what does this PR break", "impact of this diff" | `impact_from_git_diff`, `test_gap_intelligence_from_git_diff` |
| `sf-wip-impact` | "what does my WIP touch", "before I commit" | `wip_impact`, `wip_diff`, `wip_test_gap` |
| `sf-what-broke` | "what broke", "post-deploy regression", "since deploy" | `what_broke`, `point_in_time_diff` |
| `sf-cross-layer-trace` | "how does this LWC reach the DB", "end-to-end path" | `cross_layer_flow_map`, `analyze_field` |
| `sf-dead-code-audit` | "what can I delete", "unused", "dead code" | `dead_code_audit`, `freshness_report`, `trace_upstream` |
| `sf-governor-risk-fix` | "SOQL in loop", "will this scale", "performance review" | `governor_risk_check` |
| `sf-flow-impact` | "which flows use this field", "flow impact" | `analyze_field`, `trace_upstream` |
| `sf-security-audit` | "FLS", "who has access", "sharing rules" | `security_audit`, `analyze_field` |
| `sf-cross-org-diff` | "sandbox vs prod", "what changed in prod" | `cross_org_diff`, `point_in_time_diff` |
| `sf-deployment-manifest` | "generate package.xml", "deploy these changes" | `deployment_manifest_gen`, `cross_org_diff` |
| `sf-omnistudio-migration-audit` | "Vlocity → OmniStudio status", "migration audit" | `cross_org_diff` + direct queries |
| `sf-schema-overview` | "describe this org's schema", "object topology" | `analyze_field`, `trace_upstream` |
| `sf-snapshot-compare` | "compare these snapshots", "what changed between releases" | `snapshot_list`, `point_in_time_diff` |
| `sf-metadata-refresh` | "re-ingest", "refresh the graph" | `start_ingest_job`, `get_ingest_job`, `staleness_check` |
| `sf-explain-code` | "explain `Foo.bar`", "walk me through this method" | `explain_code`, `trace_downstream`, `staleness_check` |

Every skill includes a **Visualization** section specifying the Mermaid diagram type the agent should render (flowchart LR for impact, sequenceDiagram for cross-layer trace, erDiagram for schema questions, gitGraph for point-in-time). Skills also chain to each other via `follow_up_tools`.

See [`docs/SKILLS.md`](docs/SKILLS.md) for each playbook in full.

---

## Metadata coverage

Coverage is **dynamic, not hardcoded**. At ingest start, `conn.metadata.describe(apiVersion)` asks the org for its full supported type list — which automatically includes any types added by installed managed packages or by new Salesforce releases. Each type is routed to either a code parser, a declarative YAML rule, or the generic opaque-node fallback.

**Code parsers (6, complex AST work)**: Apex, LWC, Flow, Object, 4 Vlocity JSON content parsers.

**Declarative rules (21 YAML files)**: Profile, PermissionSet, SharingRule, NamedCredential, ExternalServiceRegistration, PlatformEvent, ApexPage, ApexComponent, Layout, LightningPage, Report, Dashboard, GenAiPlanner, GenAiPlugin, Network, Workflow, ApprovalProcess, DuplicateRule, MatchingRule, CustomMetadataType, CustomLabel, PermissionSetGroup.

**Vlocity legacy industry clouds** — all 5 namespaces covered by a single vendored registry (`vlocity_build`'s `QueryDefinitions.yaml`, MIT, 48 DataPack types):

| Namespace | Industry cloud(s) |
|---|---|
| `vlocity_cmt` | Communications, Media, Energy & Utilities |
| `vlocity_ins` | Insurance |
| `vlocity_hc` | Health |
| `vlocity_ps` | Public Sector |
| `vlocity_fs` | Financial Services (legacy) |

**Anything else** — types `describeMetadata()` lists but no rule covers — emits an opaque NodeFact with raw fields so the agent can still answer "does X exist?". Zero-day coverage.

---

## How the analysis actually works

Every tool answers a question by traversing a typed property graph stored locally in SQLite. The graph is built ingest-time by capability-driven parsers; analysis at query-time is mostly bounded graph traversal plus a few cached scores.

### The underlying graph

- **Nodes** (`NodeFact`): one per metadata entity. Keyed by `(org_id, qualified_name)`. Stored in per-label SQLite tables (`_sfg_n_apexclass`, `_sfg_n_lwc`, `_sfg_n_customfield`, …) created lazily on first ingest.
- **Edges** (`EdgeFact`): typed relationships. Keyed by `(org_id, src_qname, dst_qname)` per rel-type table. Each edge table has a reverse-traversal index `(org_id, dst_qname)`.
- **Snapshots**: copy-on-snapshot into `_sfgraph_node_snapshots` / `_sfgraph_edge_snapshots`. Diff is set arithmetic over `qualified_name`.
- **Vectors**: 384-dim embeddings in `vec0(org_id PARTITION KEY, embedding float[384])`. KNN is `MATCH ? AND k = ?`, partition-pruned by org.

Everything is partition-keyed on `org_id`. Same-org queries never read another org's rows.

### How parsers get picked at ingest start

1. **`probeCapabilities()`** detects installed managed packages (Vlocity-CMT and the other 4 industry namespaces, OmniStudio-on-Core, Agentforce, Experience Cloud, Source Tracking).
2. **`conn.metadata.describe(apiVersion)`** asks the org for its full supported type list.
3. The **dispatch table** maps each type to a fetch strategy:
   - `toolingSoql` for code metadata (Apex, LWC, Aura, StaticResource)
   - `metadataReadList` for XML configuration (Profile, Layout, Workflow, …)
   - `vlocityRunner` for legacy DataPacks (gated on `caps.vlocityLegacy`)
4. The **parser registry** routes each fetched record to either a code parser or a declarative rule. Unknown types fall through to a generic-opaque rule.

### Live sync algorithm

1. **Auth** via `@salesforce/core` from `~/.sfdx/`. Connection is wrapped in `wrapConnectionReadOnly()`.
2. **Capability probe** — parallel `describe` calls.
3. **Discover metadata types** — `conn.metadata.describe(apiVersion)` returns the org's supported type list.
4. **Load rule files** — `loadAllRules()` zod-validates and registers all `*.yml` in `parsers/rules/`.
5. **Build dispatch table** — per-type fetch strategy.
6. **Pre-sync snapshot** — `is_auto=true` snapshot; this is what `what_broke` looks back to.
7. **Decide mode** — incremental if `caps.sourceTracking && org.last_synced_at` exists, else full.
8. **Fan out across three pools** — toolingPool (5), metadataPool (3), dataPool (10). Each has its own 429+Retry-After handler.
9. **For each member** → parser → `mergeNodes` / `mergeEdges`. Content-hash short-circuit: unchanged records skip the write.
10. **Embedding queue (side-stream)** — push `{ qname, text }` per new node; queue batches 16-at-a-time and invokes transformers.js MiniLM. Vectors land in `vec0`.
11. **Cross-flavor resolver** — emits `CANONICAL_OF` edges between Vlocity ↔ OmniStudio duplicates.
12. **Populate analysis tables** — governor risks, dead-code scores, test coverage, security findings.
13. **Touch sync timestamp** and **drain embedding queue + prune snapshots**.

### Why this design is fast

- **Reverse-edge index** makes "who depends on X?" as cheap as "what does X depend on?".
- **Composite PKs partition every table by org_id** — SQLite range-scans only the rows for the org in question.
- **Content-hash short-circuit** on merge means no write amplification on unchanged metadata.
- **Cached analysis tables** turn governor / dead-code / security audits from full-table scans into single SELECTs.
- **vec0 partition key** prunes vector search to one org.

---

## Sample agent conversations

### Before merging a PR

```
User: I'm about to merge this PR. Anything I should worry about?

Agent: *invokes sf-impact-from-diff*
       → impact_from_git_diff(diff="…", depth=3)
       → test_gap_intelligence_from_git_diff(diff="…")

       Your diff touches 3 nodes. 9 dependents at 3 hops:
         • 4 covered by tests (green)
         • 5 at-risk (no IS_TEST_FOR):
             - LWC:opportunityTile
             - ApexMethod:BillingSvc.run(2)
             - ApexMethod:BillingSvc.dryRun(0)
             - Flow:Order_Status_Update
             - LWC:invoiceTile

       [Mermaid: changed=red, at_risk=yellow, covered=green]

       Recommend adding test coverage for BillingSvc.run(2) before merging.
```

### Picking an org for cross-org compare

```
User: What's different between sandbox and prod?

Agent: *invokes sf-cross-org-diff*
       → first checks: which orgs are authenticated via sf CLI?

       I see these orgs in your `sf` config:
         • my-prod (default)        last ingested 6 days ago
         • my-sandbox               last ingested 2 hours ago
         • integration-uat          NOT yet ingested

       Want to compare my-prod ↔ my-sandbox?
       [user: yes]

       → cross_org_diff(org_a='my-prod', org_b='my-sandbox', category='all')

       Differences:
         • Only in my-sandbox: 12 ApexClasses, 3 Flows, 2 CustomFields
         • Only in my-prod:    1 deprecated trigger
         • Changed (different hash): 7 nodes

       Note: my-prod ingest is 6 days old. Run `sfgraph ingest --org my-prod`
       for a fresher comparison.

       Tip: to refresh both at once, run
         `sfgraph ingest --orgs my-prod,my-sandbox --parallel`
       (or `sfgraph ingest --all --parallel` to refresh every authenticated org).
```

### Initial onboarding

```
User: I just installed sfgraph. Where do I start?

Agent: 1. Check the `sf` CLI is authenticated:
          `sf org list` — should show at least one org marked default.
       2. Run initial ingest (this is the slow step; ~2-6 min):
          `sfgraph ingest`
       3. Restart your IDE so the MCP server picks up the new tools.
       4. Ask me a question. Examples:
          - "Show me a schema overview of the Account object."
          - "Who reads Account.Status__c?"
          - "What's the cross-layer path from accountTile to the DB?"
```

---

## Where data lives on your machine

| Path | Contents |
|---|---|
| `~/.sfgraph/<orgId>.sqlite` | Per-org graph + vectors (single file) |
| `~/.sfgraph/backups/*.sqlite` | Pre-migration backups (rolling, last 5) |
| `~/.sfgraph/workspaces/<projectHash>.json` | Project-to-org binding for WIP analysis |
| `~/.config/sfgraph/sfgraph.json` | Telemetry config (default off) |
| `~/.config/sfgraph/machine-id` | Random UUID — only created if you enable telemetry |
| `~/.claude/skills/sf-*` | 10 SKILL.md playbooks for Claude |
| `~/.cursor/rules/sf-*.mdc` | Same, Cursor flavor |
| `<MCP-config>.json` | MCP server entry (per editor) |

What is **never** stored locally by `sfgraph`: passwords, access tokens (they stay in `~/.sfdx/` owned by `sf`), or your codebase content (telemetry events are field-allowlisted).

---

## Package layout (monorepo)

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
  mcp-server/                           # stdio MCP, 25 tools, shutdown discipline
  cli/                                  # install, ingest, link, wip, mcp, telemetry, version
  skills/                               # 10 SKILL.md playbooks + installer
  models/                               # vendored MiniLM ONNX + loader
```

Workspace packages (only the binary is what most users install):

| Package | Purpose |
|---|---|
| [`@ryanstark24/sfgraph-mcp`](https://www.npmjs.com/package/@ryanstark24/sfgraph-mcp) | The CLI binary. What 99% of users install. |
| `@ryanstark24/sfgraph-core` | Engine library. Use if you're embedding sfgraph in custom tooling. |
| `@ryanstark24/sfgraph-server` | MCP server library. |
| `@ryanstark24/sfgraph-cli` | CLI as a library. |
| `@ryanstark24/sfgraph-skills` | Skill playbooks + installer. |
| `@ryanstark24/sfgraph-shared` | Shared types and errors. |
| `@ryanstark24/sfgraph-models` | Vendored embedding model (MiniLM L6 v2 quantized, ~30 MB via Git LFS). |

---

## Development

```bash
git clone https://github.com/ryanStark24/sfgraph
cd sfgraph
pnpm install
pnpm build          # build all packages
pnpm test           # 346 tests
pnpm typecheck      # strict TS
pnpm lint           # Biome
```

Required: Node ≥ 20, pnpm 10.

To refresh the vendored Vlocity registry (quarterly):

```bash
pnpm vlocity:refresh
```

To re-fetch the vendored embedding model:

```bash
pnpm models:refresh
```

---

## Troubleshooting

### `NODE_MODULE_VERSION` / `Module did not self-register` on startup

This is a `better-sqlite3` ABI mismatch — the prebuilt native binding was
compiled against a different Node ABI than the one currently running. It
commonly happens when an IDE (Cursor, VS Code, Claude Desktop) spawns the
MCP server with its own bundled Node binary while you ran
`pnpm install` / `pnpm rebuild` from a shell using a different Node.

Diagnose:

```bash
sfgraph doctor
```

Fix:

```bash
npm rebuild better-sqlite3    # or: pnpm rebuild better-sqlite3
```

If the rebuild "works" but the IDE still errors, the IDE's Node ABI
differs from your shell's. Re-run the rebuild from inside the IDE's
integrated terminal, or pin an absolute Node path:

```bash
sfgraph install --local --pin-node "$(which node)"
```

### MCP server shows no tools / agent ignores sfgraph

1. Fully restart the IDE — MCP clients cache the tool list until reconnect.
2. Verify the config was written:
   ```bash
   sfgraph install --target cursor --dry-run
   cat ~/.cursor/mcp.json
   ```
3. Run `sfgraph doctor` and confirm the `IDE MCP configs` row lists your IDE.

### `sfgraph ingest` hangs or seems silent

Ingest emits a heartbeat every ~5s. If you don't see any output for longer
than that, check `sf org list` works first (auth issues are the most common
cause). For a noisier run, drop `--mode auto` and use `--mode full` so the
sync starts from scratch.

### `list_orgs` returns empty / "0 orgs"

Either the `sf` CLI can't auth from the MCP child process (Cursor often
inherits a stripped `PATH`), or no orgs have been ingested yet. Confirm
with:

```bash
sfgraph doctor      # check "sf CLI" and "org databases" rows
sf org list         # from the same shell
```

If `sf org list` works but `list_orgs` from the MCP client returns empty,
the data-dir fallback kicked in but found nothing — run
`sfgraph ingest --org <alias>` once to populate it.

---

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — storage model, ingestion pipeline, embedding strategy, snippet store, Windows support
- [`docs/TOOLS.md`](docs/TOOLS.md) — full MCP tool reference (schemas, examples, algorithms)
- [`docs/SKILLS.md`](docs/SKILLS.md) — skill playbooks
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — read-only enforcement, sanitizer, telemetry flow
- [`docs/PLAN.md`](docs/PLAN.md) — Phase 7 architecture plan
- [`CHANGELOG.md`](CHANGELOG.md) — per-phase release notes

---

## License

MIT
