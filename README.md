# @ryanstark24/sfgraph

[![npm](https://img.shields.io/npm/v/@ryanstark24/sfgraph.svg)](https://www.npmjs.com/package/@ryanstark24/sfgraph)
[![license](https://img.shields.io/npm/l/@ryanstark24/sfgraph.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@ryanstark24/sfgraph.svg)](https://nodejs.org)

A **local, privacy-first knowledge graph for Salesforce orgs**. `sfgraph` live-syncs your org to a SQLite + vector index on your machine and exposes 28 MCP tools to **Cursor, Claude Code/Desktop, and VS Code**, so the AI you already use can reason about Apex, LWC, Flow, Vlocity, OmniStudio, security, and integrations **without your code or schema ever leaving your laptop**.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Cursor / Claude / VS Code   ←──── MCP stdio ────→   sfgraph         │
│                                                                      │
│              read-only Salesforce APIs    ──→    your org            │
│              local SQLite + sqlite-vec    ←──    OS data dir         │
└──────────────────────────────────────────────────────────────────────┘
```

**Privacy in one line.** Nothing leaves your machine — graph, vectors, logs all live under the platform's user-data directory (`~/Library/Application Support/sfgraph/` on macOS, `~/.local/share/sfgraph/` on Linux, `%APPDATA%\sfgraph\` on Windows; see [`docs/DATA_LOCATIONS.md`](docs/DATA_LOCATIONS.md)). Salesforce auth is delegated to the `sf` CLI (token stays in `~/.sfdx/`). Every connection is wrapped in a read-only Proxy. Full threat model: [`docs/PRIVACY.md`](docs/PRIVACY.md).

---

## Install

### 1. Prerequisites

| | How |
|---|---|
| **Node.js ≥ 20** | [nodejs.org](https://nodejs.org) or `brew install node` |
| **`sf` CLI** | `npm install -g @salesforce/cli` |
| **At least one `sf` login** | `sf org login web --alias my-org && sf config set target-org=my-org` |

Verify:

```bash
node --version          # v20+ (v22 LTS recommended)
sf org list             # at least one org marked as default
```

### 2. Install sfgraph

```bash
npm install -g @ryanstark24/sfgraph
```

Or run on-demand via `npx @ryanstark24/sfgraph <command>` without installing.

After install, `sfgraph` is on your PATH.

### 3. Wire it into your editor

```bash
sfgraph install
```

Idempotent. Copies 20 skill playbooks into `~/.claude/skills/` + `~/.cursor/rules/` and adds a `sfgraph` entry to your editor's MCP config. Existing MCP entries are preserved. Use `--target=claude|cursor|vscode` to wire only one, or `--dry-run` to preview. Start with **`sf-graph-router`** — it routes intent to the right skill and enforces grounding answers in the org graph before generating Salesforce code.

#### Using a different IDE or LLM client?

`sfgraph install` writes config for Claude / Cursor / VS Code automatically. For **any other MCP-compatible client** (Windsurf, Zed, Continue, Cline, an OpenAI- or Gemini-based agent with MCP support, your own custom host, etc.), add this entry to the client's MCP config file manually:

```json
{
  "mcpServers": {
    "sfgraph": {
      "command": "npx",
      "args": ["-y", "@ryanstark24/sfgraph", "mcp"]
    }
  }
}
```

On Windows, use `"npx.cmd"` instead of `"npx"`.

**Pinning the Node binary.** Some hosts (sandboxed Electron apps, IDE extensions) ship with a bundled Node whose ABI differs from your shell's. If that bundled Node lacks a matching `better-sqlite3` prebuilt, the MCP child fails to load. Pin to your shell's Node:

```json
{
  "mcpServers": {
    "sfgraph": {
      "command": "/Users/you/.nvm/versions/node/v22.21.1/bin/node",
      "args": ["/usr/local/bin/sfgraph", "mcp"]
    }
  }
}
```

Use `which node` and `which sfgraph` to fill in the paths. Same effect as `sfgraph install --local --pin-node "$(which node)"` but written by hand into a client we don't have a built-in target for.

**Where each known client keeps its MCP config:**

| Client | Config path |
|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Win) |
| Claude Code (CLI) | `~/.claude.json` (user) or `.mcp.json` (project) |
| Cursor | `~/.cursor/mcp.json` |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` (macOS) · `%APPDATA%\Code\User\mcp.json` (Win) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `~/.config/zed/settings.json` (under `context_servers`) |
| Continue (VS Code) | `~/.continue/config.json` (under `mcpServers`) |
| Cline (VS Code) | `~/.cline/cline_mcp_settings.json` |

After editing the file, fully restart the client so it re-reads the MCP server list. Then ask the agent something like *"list orgs from sfgraph"* to confirm the tools are visible.

The skill playbooks (`sf-impact-from-diff`, `sf-security-audit`, etc.) are Claude/Cursor-specific. On other clients, the agent still has direct access to all 28 MCP tools — it just routes by tool name instead of by skill trigger.

### 4. Verify the install

```bash
sfgraph doctor
```

End-to-end self-check: Node ABI, native bindings, code-signing (macOS), data dir, org DBs, `sf` CLI, IDE MCP configs. Each failed check prints a copy-paste fix.

If you see a `bindings file not found` / ABI mismatch (common after a Node upgrade or on a brand-new Node release with no prebuilts yet):

```bash
sfgraph rebuild-bindings
```

---

## First ingest

The first sync of an org takes **2–6 minutes** on a typical 50K-node sandbox. Subsequent syncs on Source-Tracking-enabled orgs are incremental (<30 s).

```bash
# Default org from `sf config target-org`
sfgraph ingest

# Or pick an org explicitly
sfgraph ingest --org my-prod
```

The graph lands in `<data-dir>/<orgId>.sqlite` (macOS: `~/Library/Application Support/sfgraph/`, Linux: `~/.local/share/sfgraph/`, Windows: `%APPDATA%\sfgraph\`). From this point every MCP tool reads only from that file — no network calls.

**Keep it fresh.** Re-run `sfgraph ingest` whenever you want current data. Skills warn the agent when the graph is older than 7 days.

For tuning, large-org options, multi-org ingest, and rebuild flags, see [`docs/CLI.md`](docs/CLI.md#sfgraph-ingest).

---

## Use it from your editor

Restart your IDE so it picks up the new MCP entry. Then in any project ask the agent:

- *"What does this PR break?"*
- *"Who reads `Account.Status__c`?"*
- *"What changed in prod since last week?"*
- *"Show me how `accountTile` flows from UI to DB."*

The agent routes to the right tool automatically via the installed skill playbooks. A short worked example:

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

       Recommend adding test coverage for BillingSvc.run(2) before merging.
```

More worked examples: [`docs/SAMPLES.md`](docs/SAMPLES.md).

---

## Optional: web visualiser

```bash
sfgraph serve          # http://localhost:7777
```

A 3D force-graph explorer for the ingested org. Loopback-only by default. See [`docs/WEB.md`](docs/WEB.md).

---

## Reliability

### Wedge isolation (Phase 1.5)

A slow or hung source no longer blocks neighbors. When the per-source watchdog (90s first-yield, 5min inactivity) fires, the source's slot is released and the next queued source runs. The wedge runs to completion in the background; late records are drained with `attributes.lateYield: true`.

You will see warnings of the form `wedge:<source>:<reason>:...` in the ingest run summary — these are now *informational* (the run continues), not fatal.

**Socket-leak caveat (honest disclosure).** The underlying HTTP request to Salesforce is NOT cancelled (jsforce 3.10.15 does not expose `AbortController`). Wedged sockets are reaped by Node's idle-timeout (~10min). Worst-case memory: 4 wedges × ~1MB ≈ 4MB per ingest, garbage-collected at process exit. The cap is `SFGRAPH_MAX_BACKGROUND_WEDGES` (default 4).

### Detect-deletions drop-ratio guard (Phase 1.5)

When run with `--detect-deletions --rebuild`, sfgraph refuses to wipe a label whose drop ratio exceeds `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO` (default `0.30`). A wedge-induced empty stream emits a `wedge:detect-deletions:refuse:label=<L>:reason=empty-stream` warning instead of silently destroying the label. Refused labels keep their previous `last_seen_at` so the staleness clock keeps ticking — staleness reports will still surface them.

---

## Diagnostics

When ingest reports skips you don't understand, use the diagnose subcommand:

```bash
sfgraph diagnose <orgId>
```

`diagnose` forces source / Tooling / Metadata / Data pool concurrency to 1 and writes a structured JSON report capturing per-source timing, wedge events, capability probes, and detect-deletions refusals. By default it writes to a temporary graph DB so your main org graph is untouched.

> **Note:** wall-clock is NOT comparable to a production run — diagnose names wedges, it does not predict prod throughput.

**Default report path** (platform-aware, under the same data dir as the graph):

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/sfgraph/diagnostics/<orgId>-<ISO-timestamp>.json` |
| Linux | `~/.local/share/sfgraph/diagnostics/<orgId>-<ISO-timestamp>.json` |
| Windows | `%APPDATA%\sfgraph\diagnostics\<orgId>-<ISO-timestamp>.json` |

**Flags:**

| Flag | Default | Effect |
|---|---|---|
| `--output <path>` | (auto) | Override the default report path. |
| `--max-duration <seconds>` | `600` | Overall diagnose timeout (10 min). |
| `--verbose` | `false` | Stream per-source timing to stdout in addition to the JSON report. |
| `--keep-graph` | `false` | Write to the real org graph DB instead of a temp DB. |

---

## MCP staleness signal

Every MCP tool response carries a `_meta.staleness` block:

```ts
{
  generation: number,            // monotonic per-org sync counter
  in_progress: boolean,          // true if an ingest is currently rewriting the graph
  started_at: string | null,     // ISO timestamp of the in-progress ingest
  last_sync_at: string | null    // ISO timestamp of the most recent completed sync
}
```

**Reader-side contract.** MCP clients should check `staleness.in_progress === true` to warn users that the graph is being rewritten and results may reflect partial state. Tools that don't carry an `orgId` argument (e.g. `ping`, `list_orgs`) omit the block instead of guessing.

---

## Environment variables

Authoritative inventory — every `SFGRAPH_*` env var read at runtime, sorted alphabetically. Verified via `grep -rn "process.env.SFGRAPH_" packages/ --include="*.ts"`.

| Name | Type | Default | Purpose | Since |
|---|---|---|---|---|
| `SFGRAPH_ALLOW_ANY_DB` | bool (`1`) | unset | Bypass the "graph DB must live under data dir" safety check. | 1.0 |
| `SFGRAPH_APEX_PARSER` | string | `regex` | Apex class parser strategy (`regex` is the default; other values reserved). | 1.0 |
| `SFGRAPH_AUTO_RETRY_THRESHOLD` | int | `10` | Skip-count threshold above which `ingest` auto-retries the wedged sources. | 1.0 |
| `SFGRAPH_BISECT_MAX_DEPTH` | int | `6` | Tooling SOQL adaptive bisection depth cap. | 1.0 |
| `SFGRAPH_CACHE_DIR` | path | platform default | Override OS cache directory. | 1.0 |
| `SFGRAPH_CONFIG_DIR` | path | platform default | Override OS config directory. | 1.0 |
| `SFGRAPH_DATA_DIR` | path | platform default | Override OS data directory (where `<orgId>.sqlite` lives). | 1.0 |
| `SFGRAPH_DATA_POOL` | int | varies | Data API pool concurrency. | 1.0 |
| `SFGRAPH_DEBUG_INGEST` | bool (`1`) | unset | Verbose ingest logging (per-source counters, dispatch table, etc.). | 1.0 |
| `SFGRAPH_DEBUG_POOLS` | bool (`1`) | unset | Print pool-counter snapshots during ingest. | 1.0 |
| `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO` | float | `0.30` | Per-label drop-ratio threshold above which `--detect-deletions` sweep refuses to act. | 1.5 |
| `SFGRAPH_EMBED_MODEL_DIM` | int | model default | Embedding model dimensionality override. | 1.0 |
| `SFGRAPH_EMBED_MODEL_ID` | string | model default | Embedding model identifier override. | 1.0 |
| `SFGRAPH_EMBED_MODEL_PATH` | path | (auto) | Local path to a custom embedding model file. | 1.0 |
| `SFGRAPH_INCLUDE_ALL_GENERIC` | bool (`1`) | unset | Disable `GENERIC_TYPE_WHITELIST` filter — route every discovered metadata type through the generic extractor. | 1.0 |
| `SFGRAPH_INCLUDE_ALL_SOBJECTS` | bool (`1`) | unset | Skip the `EntityDefinition.IsCustomizable` filter and include every queryable SObject. | 1.0 |
| `SFGRAPH_INCLUDE_MANAGED` | bool (`1`) | unset | Include managed-namespace components globally (Apex body, generic metadata, LWC source). | 1.0 |
| `SFGRAPH_INCLUDE_MANAGED_LWC` | bool (`1`) | unset | LWC-only override for managed-namespace inclusion (independent of the global flag). | 1.0 |
| `SFGRAPH_INCLUDE_SYSTEM_SOBJECTS` | bool (`1`) | unset | Include platform telemetry SObjects (`ApexLog`, `EventLogFile`, etc.). | 1.0 |
| `SFGRAPH_LATE_DRAIN_BUDGET_MS` | int (ms) | (impl default) | Per-wedge late-yield drain budget — how long the background runner gets to drain late records before being abandoned. | 1.5 |
| `SFGRAPH_LOG_DIR` | path | platform default | Override OS log directory. | 1.0 |
| `SFGRAPH_MAX_BACKGROUND_WEDGES` | int | `4` | Cap on simultaneous background wedges per ingest. | 1.5 |
| `SFGRAPH_METADATA_POOL` | int | varies | Metadata API pool concurrency. | 1.0 |
| `SFGRAPH_METADATA_READ_CHUNK_SIZE` | int | `10` | `metadata.read` composite batch size. | 1.0 |
| `SFGRAPH_NO_AUTO_RETRY` | bool (`1`) | unset | Disable automatic retry on watchdog wedge / skip cascade. | 1.0 |
| `SFGRAPH_NO_LIVENESS_PROBE` | bool (`1`) | unset | Skip the pre-ingest liveness probe. | 1.0 |
| `SFGRAPH_SEQUENTIAL_SOURCES` | bool (`1`) | unset | Force serial source execution (debug aid; bypasses the sliding-window merger). | 1.0 |
| `SFGRAPH_SKIP_LWC` | csv | unset | Skip specific LWC bundle `DeveloperName`s (also accepts `1` to skip the source entirely). | 1.0 |
| `SFGRAPH_SKIP_SOBJECT` | csv | unset | Skip specific SObjects by `QualifiedApiName` (escape hatch for `describe()`-crashing tables). | 1.0 |
| `SFGRAPH_SKIP_THRESHOLD` | int | (impl default) | Skip-count threshold for `ingest`-level retry/abort behavior. | 1.0 |
| `SFGRAPH_SOURCE_CONCURRENCY` | int | `12` | Concurrency of the sliding-window source merger in `bulk-retrieve.ts`. | 1.0 |
| `SFGRAPH_TEMP_DIR` | path | platform default | Override OS temp directory. | 1.0 |
| `SFGRAPH_TOOLING_POOL` | int | `5` | Tooling API pool concurrency. | 1.0 |
| `SFGRAPH_TRAVERSAL_NODE_CAP` | int | (impl default) | Cap on nodes visited by dependents / dependencies traversal in the analysis layer. | 1.0 |
| `SFGRAPH_WATCHDOG_FIRST_YIELD_MS` | int (ms) | `90000` | Per-source first-yield watchdog timeout. | 1.5 |
| `SFGRAPH_WATCHDOG_INACTIVITY_MS` | int (ms) | `300000` | Per-source inactivity watchdog timeout (5 min). | 1.5 |

---

## Honest disclosures — known limitations

sfgraph aims to be honest about gaps. Read this section before relying on it for security or compliance audits.

- **Security model gaps.** Profile / PermissionSet / SharingRules are ingested as first-class nodes with `GRANTS_*` edges. However, **PermissionSetGroup, MutingPermissionSet, ProfileSessionSetting, ProfilePasswordPolicy** are ingested as opaque generic nodes WITHOUT `GRANTS_*` or `DENIES_*` edges — they exist as nodes but their security semantics are not modeled. Audits that rely on these edges will not surface findings for those types until a future Security phase.
- **Security analysis caps.** The analysis layer caps results at 5000 per label (`SECURITY_PER_LABEL_CAP`). On orgs with more than 5k Profiles or PermissionSets, analysis is truncated with a `truncated: true` flag — **but graph storage is complete**.
- **Generic-type whitelist.** sfgraph dispatches ~80 of the ~327 metadata types Salesforce returns from `describeMetadata()` to the parsed extractor path. The rest are recorded only as opaque generic nodes when matched by the whitelist; everything else is filtered out. Set `SFGRAPH_INCLUDE_ALL_GENERIC=1` to override (every discovered type runs through the generic extractor — longer ingest, more opaque nodes). The full type list is documented in [`docs/COVERAGE.md`](docs/COVERAGE.md).
- **LWC empty-bundle behavior change (Phase 1.5).** Prior versions yielded a stub `RawMember` with `files: {}` on per-bundle resource-fetch failure, creating empty bundle nodes in the graph. Phase 1.5 emits a `wedge:lwc:bundleFetchFailed:...` warning and **no record**. Users who upgrade may see previously-recorded empty LWC bundles disappear from their graph on the next re-ingest. **This is correct.**
- **Socket leak on wedged HTTP requests.** When the per-source watchdog fires, sfgraph releases the slot but the underlying jsforce HTTP request is NOT cancelled (no `AbortController` exposed by jsforce 3.10.15). The socket is reaped by Node's idle-timeout (~10min). Worst case: `SFGRAPH_MAX_BACKGROUND_WEDGES` (default 4) × ~1MB ≈ 4MB transient memory per ingest, GC'd at process exit. Tracked as future hardening; an upstream jsforce PR or fork is needed for true in-flight HTTP cancellation.

---

## Coverage

sfgraph mixes deep parsing (Apex, LWC, Flow, Object, Profile/PermissionSet, NamedCredential, Vlocity, OmniStudio) with opaque-node fallback for the long tail of metadata types. Coverage is **dynamic, not hardcoded** — at ingest start, `conn.metadata.describe(apiVersion)` asks the org for its full supported type list, which automatically includes types added by managed packages or future Salesforce releases. Each type is routed to a named extractor, the generic opaque-node path, or filtered out.

See [`docs/COVERAGE.md`](docs/COVERAGE.md) for the full status matrix: every type, the edges it emits, known limitations, and the source file that implements it.

---

## Documentation

| | |
|---|---|
| [`docs/CLI.md`](docs/CLI.md) | Full CLI reference — every command, every flag |
| [`docs/TOOLS.md`](docs/TOOLS.md) | The 28 MCP tools — schemas, examples, algorithms |
| [`docs/SKILLS.md`](docs/SKILLS.md) | The 20 skill playbooks installed into your editor |
| [`docs/SAMPLES.md`](docs/SAMPLES.md) | Worked agent-conversation examples |
| [`docs/COVERAGE.md`](docs/COVERAGE.md) | Metadata coverage matrix and SObject classification logic |
| [`docs/WEB.md`](docs/WEB.md) | Local web visualiser |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Diagnose and fix common install / ingest issues |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Architecture decisions, analysis pipeline, TS rewrite rationale |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Storage model + ingestion pipeline deep-dive |
| [`docs/PRIVACY.md`](docs/PRIVACY.md) | Read-only enforcement, sanitizer, telemetry threat model |
| [`docs/DATA_LOCATIONS.md`](docs/DATA_LOCATIONS.md) | What lives where on your machine |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Build, test, contribute |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-release notes |

---

## License

MIT
