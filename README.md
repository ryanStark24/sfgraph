# @ryanstark24/sfgraph

[![npm](https://img.shields.io/npm/v/@ryanstark24/sfgraph.svg)](https://www.npmjs.com/package/@ryanstark24/sfgraph)
[![license](https://img.shields.io/npm/l/@ryanstark24/sfgraph.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@ryanstark24/sfgraph.svg)](https://nodejs.org)

A **local, privacy-first knowledge graph for Salesforce orgs**. `sfgraph` live-syncs your org to a SQLite + vector index on your machine and exposes 26 MCP tools to **Cursor, Claude Code/Desktop, and VS Code**, so the AI you already use can reason about Apex, LWC, Flow, Vlocity, OmniStudio, security, and integrations **without your code or schema ever leaving your laptop**.

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

Idempotent. Copies 17 skill playbooks into `~/.claude/skills/` + `~/.cursor/rules/` and adds a `sfgraph` entry to your editor's MCP config. Existing MCP entries are preserved. Use `--target=claude|cursor|vscode` to wire only one, or `--dry-run` to preview.

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

The skill playbooks (`sf-impact-from-diff`, `sf-security-audit`, etc.) are Claude/Cursor-specific. On other clients, the agent still has direct access to all 26 MCP tools — it just routes by tool name instead of by skill trigger.

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

## Documentation

| | |
|---|---|
| [`docs/CLI.md`](docs/CLI.md) | Full CLI reference — every command, every flag |
| [`docs/TOOLS.md`](docs/TOOLS.md) | The 26 MCP tools — schemas, examples, algorithms |
| [`docs/SKILLS.md`](docs/SKILLS.md) | The 17 skill playbooks installed into your editor |
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
