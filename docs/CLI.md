# CLI reference

```
sfgraph <command> [options]

Commands:
  install                              wire skills + MCP config into IDEs (idempotent)
  ingest                               sync a Salesforce org into the local graph (read-only)
  serve                                start the local web visualiser at http://localhost:7777
  doctor                               end-to-end self-check (Node ABI, native bindings, IDE wiring)
  rebuild-bindings                     rebuild better-sqlite3 native binding for current Node
  refresh-orgs                         re-snapshot `sf`-CLI alias/default-org state for MCP children
  snapshot create | list               manage snapshots manually
  link                                 bind a local project folder to an org (for WIP analysis)
  wip                                  analyse local source for deploy impact (no push)
  mcp                                  start the MCP server over stdio (IDE invokes this)
  telemetry status|enable|disable|...  manage local telemetry (default OFF)
  version                              print sfgraph version
```

## `sfgraph install`

| Option | Default | Description |
|---|---|---|
| `--target <t>` | `all` | `claude`, `cursor`, `vscode`, or `all` |
| `--dry-run` | `false` | Preview without writing |
| `--skills-only` | `false` | Install skill playbooks; skip MCP config |
| `--mcp-only` | `false` | Write MCP config; skip skill playbooks |
| `--local` | `false` | Write MCP config that invokes the local binary directly (`node <absPath> mcp`) instead of `npx @ryanstark24/sfgraph-mcp`. Use during local dev before the package is published to npm. |
| `--pin-node <path>` | — | Absolute path to a node binary to use as the MCP entry's `command`. Pins the IDE child to a Node ABI matching the rebuilt better-sqlite3 binding. |

## `sfgraph ingest`

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
| `--metadata-pool <n>` | `10` | Max concurrent Metadata-API calls. **Highest-leverage knob for slow ingests** — Profile/PermissionSet/Layout fans go through here. Bump higher on orgs with many of those. Also reads `SFGRAPH_METADATA_POOL`. |
| `--data-pool <n>` | `10` | Max concurrent SObject/Bulk SOQL queries. Also reads `SFGRAPH_DATA_POOL`. |
| `--debug` | `false` | Verbose tracing for diagnosing silent ingest deaths: heartbeat every 10s with heap/RSS/last-source label, per-record parse and graph-merge phase logs, SIGTERM/SIGINT stack traces, per-source enter/finalise markers. Also sets `SFGRAPH_DEBUG_INGEST=1`. |
| `--db <path>` | `~/.sfgraph/<orgId>.sqlite` | Override SQLite database path |

Auto-detects default org from `sf config`. Auto-snapshot taken before every sync.

### What the initial ingest looks like

```
ingest: using default org from sf config: my-prod
ingest: resolving auth from ~/.sfdx/                       ← read-only Proxy wrapped here
ingest: probing capabilities…
ingest: capabilities { vlocityNamespaces: ['vlocity_cmt'],
                       omnistudioOncore: true,
                       sourceTracking: false,
                       experienceCloud: true,
                       agentforce: false }
ingest: discovered 187 metadata types via describeMetadata()
ingest: creating pre-sync snapshot (this is what `what_broke` looks back to)
ingest: fan-out — Tooling pool (5), Metadata pool (10), Data pool (10), parallel sources
ingest:   Apex                                ✓ 1248 classes, 89 triggers
ingest:   LWC bundles                         ✓ 234 bundles
ingest:   Flow                                ✓ 412
ingest:   CustomObject                        ✓ 89 standard + 184 custom
ingest:   Profile + PermissionSet             ✓ 47 profiles, 156 perm sets
ingest:   Vlocity (vlocity_cmt)               ✓ 48 DataPack types
ingest:   OmniStudio native                   ✓ 67 OmniProcess + 23 OmniDataTransform
ingest: populating cached analysis tables…
ingest: cross-flavor resolver: 23 CANONICAL_OF edges (Vlocity ↔ OmniStudio)
ingest: embedding queue draining…
ingest: complete mode=full members=12483 deletions=0 parseErrors=2 elapsed=247314ms
```

### Tuning for large orgs

For orgs with 1000+ Profiles or 500+ SObjects, the metadata pool is usually the bottleneck:

```bash
sfgraph ingest --metadata-pool 15 --tooling-pool 6 --data-pool 12
```

Pool caps also read from `SFGRAPH_TOOLING_POOL` / `SFGRAPH_METADATA_POOL` / `SFGRAPH_DATA_POOL` env vars.

### Multi-org ingest

```bash
# Explicit alias list, sequentially:
sfgraph ingest --orgs prod,uat,qa

# Every authenticated org from `sf`, sequentially:
sfgraph ingest --all

# Same, but fan out concurrently (per-org failures don't kill the batch):
sfgraph ingest --orgs prod,uat,qa --parallel
sfgraph ingest --all --parallel
```

Each run prints a per-org results table (Org | Mode | Members | Deletions | ParseErrors | Elapsed | Status). With `--parallel`, the rate-limit pools are shared across orgs in the same process.

### Full rebuild from scratch

```bash
sfgraph ingest --rebuild --org prod
# Existing graph moved to ~/<sfgraph-data>/backups/<orgId>.rebuild-<ISO>.sqlite

sfgraph ingest --rebuild --no-backup --org prod
# Existing graph deleted outright (no backup taken)
```

`--rebuild` forces `mode=full` regardless of Source Tracking and starts from an empty DB. Useful when parser logic has changed or when you suspect the graph has drifted from reality.

### Detect deletions

```bash
sfgraph ingest --detect-deletions --org prod
```

On Source-Tracking-enabled orgs, deletions surface automatically via `SourceMember.IsNameObsolete`. On production orgs without Source Tracking, full syncs only see what currently exists. `--detect-deletions` computes the set of qnames present in the graph before the sync but NOT touched during it, and removes them. **Bails out if any parse error occurred during the run** so a transient SF API hiccup never wipes the graph.

### Recovering from rate-limit or permission skips

Every ingest writes its skip report to `<dataDir>/<orgId>.skips.json`. If some types were rate-limited or permission-gated:

```bash
# Re-fetch ONLY the previously-skipped sources, no full rebuild
sfgraph ingest --org my-prod --retry-skipped

# Or target specific sources by label
sfgraph ingest --org my-prod --only generic:Profile,generic:Layout
```

### Parallel org ingest semantics

Bottleneck rate-limit pools live **per Node process**. That means:

- Multiple `sfgraph ingest` processes for **different orgs** run in parallel and don't fight each other — each has its own pools, and Salesforce's per-org API budgets are also separate.
- Multiple `sfgraph ingest` processes for the **same org** are not supported and will contend on the SQLite write lock. Don't do this.
- A single process can serially ingest several orgs, but throughput is lower than two parallel processes.

### Custom embedding model

sfgraph ships a vendored, quantized **all-MiniLM-L6-v2** model. To point at a different one:

```bash
# CLI flag (per-invocation)
sfgraph ingest --embed-model /path/to/model.onnx

# Or environment variables
export SFGRAPH_EMBED_MODEL_PATH=/path/to/models
export SFGRAPH_EMBED_MODEL_ID=MyOrg/MyModel
export SFGRAPH_EMBED_MODEL_DIM=768
sfgraph ingest --org my-prod
```

The model must produce 384-dimensional vectors to match the existing `vec0` schema unless you override the dim. Checksum verification is skipped for user-supplied models.

## `sfgraph link` + `sfgraph wip`

WIP local-impact analysis against an org's graph without committing or pushing.

```bash
# One-time per sfdx project: bind the folder to an org
sfgraph link --org my-sandbox [--project <path>]

# Then analyse uncommitted local changes against the org graph
sfgraph wip [--depth N] [--mode changed-only|full-folder] [--project <path>] [--org <alias>]
```

`link` writes `~/.sfgraph/workspaces/<projectHash>.json` so the wip command knows which org's graph to overlay your local source against. `wip` parses the sfdx-source tree (`force-app/`), overlays transient nodes onto the org's graph in-memory (never persisted), and runs the same dependent-BFS as `impact_from_git_diff` — but for uncommitted changes. Read-only against the persisted graph.

## `sfgraph snapshot`

```bash
sfgraph snapshot list [--org <alias>]
sfgraph snapshot create --label <name> [--kind manual|scheduled] [--org <alias>]
sfgraph snapshot diff <fromId> <toId|current> [--org <alias>]
sfgraph snapshot prune --retain-days <n> [--org <alias>]
sfgraph snapshot delete <snapshotId> [--org <alias>]
```

Pre-sync auto-snapshots are created automatically by `sfgraph ingest`; these commands are for manual/scheduled snapshots.

## `sfgraph refresh-orgs`

Re-snapshot `sf`-CLI org state (aliases + default-org) into `<dataDir>/orgs-snapshot.json`. Run this after **any** change to your `sf` state — `sf org login web`, `sf alias set`, `sf config set target-org` — so that sandboxed MCP child processes (Cursor on macOS, Claude Desktop) see the new aliases. Sandboxes can't read `~/.sf/` directly, so without this snapshot `list_orgs` shows empty aliases.

```bash
sfgraph refresh-orgs
```

Does NOT touch the graph or MCP config. Idempotent.

## `sfgraph doctor`

End-to-end self-check. Verifies Node version + ABI, the better-sqlite3 native binding, macOS code-signing on the binding (catches the silent-SIGKILL failure mode before your next ingest hits it), data dir permissions, every per-org SQLite, the org snapshot file, `sf` CLI availability, and which IDE MCP configs you currently have wired up. Every failed check prints a copy-paste fix.

```bash
sfgraph doctor
```

## `sfgraph rebuild-bindings`

Rebuild better-sqlite3's native binding for the current Node runtime. Fixes "bindings file not found" / ABI mismatch errors that occur after a Node upgrade or on Node versions without prebuilts yet.

```bash
sfgraph rebuild-bindings
sfgraph rebuild-bindings --dry-run                  # show command without running
sfgraph rebuild-bindings --package-manager npm      # force npm; auto-detected by default
```

Auto-detects whether the install is npm or pnpm, runs the appropriate rebuild from the workspace root, and verifies the rebuilt binding loads under the current ABI. Requires a C++ toolchain (macOS: `xcode-select --install`; linux: `build-essential` + `python3`).

## `sfgraph telemetry`

```bash
sfgraph telemetry status            # default: disabled
sfgraph telemetry enable --local    # opt-in to local JSONL sink
sfgraph telemetry disable
sfgraph telemetry preview           # see a sanitized sample event
sfgraph telemetry purge             # delete the local file
sfgraph telemetry reset-id          # regenerate machine-id
```

Telemetry is local-only. There is no remote sink in the codebase. See [`PRIVACY.md`](PRIVACY.md) for the full data-flow model.
