# sfgraph

[![npm](https://img.shields.io/npm/v/sfgraph.svg)](https://www.npmjs.com/package/sfgraph)
[![license](https://img.shields.io/npm/l/sfgraph.svg)](LICENSE)
[![node](https://img.shields.io/node/v/sfgraph.svg)](https://nodejs.org)

A **local, privacy-first knowledge graph for Salesforce orgs**. `sfgraph` live-syncs your org to a SQLite + vector index on your machine and exposes 19 MCP tools to **Cursor, Claude Code/Desktop, and VS Code**, so the AI you already use can reason about Apex, LWC, Flow, Vlocity, OmniStudio, security, and integrations without your code ever leaving your laptop.

```
┌────────────────────────────────────────────────────────────────┐
│  Cursor / Claude / VS Code   ←──── MCP stdio ────→   sfgraph   │
│                                                                │
│              read-only Salesforce APIs    ──→    your org      │
│              local SQLite + sqlite-vec    ←──    ~/.sfgraph/   │
└────────────────────────────────────────────────────────────────┘
```

## Privacy pillars

1. **No codebase egress.** Graph, vectors, embeddings, logs — all in `~/.sfgraph/`. Nothing is sent anywhere.
2. **Read-only Salesforce access.** Every `jsforce` connection is wrapped in a Proxy that throws `ReadOnlyViolationError` synchronously on every mutating method (`create`, `update`, `delete`, `deploy`, …). Verified by 41 adversarial tests.
3. **Telemetry default OFF.** If you ever enable it, an allowlist + sanitizer scrubs paths, emails, SF hosts, bearer tokens, UUIDs, and SF Ids before anything is written. Local file sink only — there is no remote endpoint.
4. **No credentials handled.** Auth is delegated to the `sf` CLI (`~/.sfdx/`). `sfgraph` never sees a password and never persists an access token.

See [`docs/PRIVACY.md`](docs/PRIVACY.md) for the full threat model.

---

## Quickstart

### Prerequisites
- Node.js ≥ 20
- `sf` CLI authenticated against at least one org (`sf org login web --alias my-prod`)

### Install + wire up in three commands

```bash
# 1. Wire MCP config + skills into Cursor, Claude Code/Desktop, and VS Code
npx sfgraph install

# 2. Set a default org once (or pass --org each time)
sf config set target-org=my-prod

# 3. Sync the org into the local graph (auto-detects default org)
npx sfgraph ingest
```

That's it. Open Cursor / Claude Code / VS Code in any project and the `sfgraph_*` tools are available. Ask the agent things like *"what does this PR break?"* or *"who can edit Account.Status__c?"*.

### First-time output (annotated)

```
$ npx sfgraph install
  → wrote 10 skills to ~/.claude/skills/
  → wrote 10 skills to ~/.cursor/rules/
  → added "sfgraph" entry to ~/Library/Application Support/Claude/claude_desktop_config.json
  → added "sfgraph" entry to ~/.cursor/mcp.json
  → added "sfgraph" entry to ~/.config/Code/User/mcp.json

$ npx sfgraph ingest
  ingest: using default org from sf config: my-prod
  ingest: starting alias=my-prod db=~/.sfgraph/00D...sqlite
  ingest: capabilities { vlocityCmt: false, omnistudioOncore: true, sourceTracking: true, ... }
  ingest: complete mode=full members=12483 deletions=0 parseErrors=2 elapsed=247314ms
```

The second `sfgraph ingest` switches automatically to **incremental** mode via SourceMember polling and finishes in seconds.

---

## CLI reference

```
sfgraph <command> [options]

Commands:
  install                                 wire skills + MCP config into IDEs
  ingest                                  sync a Salesforce org into the local graph (read-only)
  mcp                                     start the MCP server over stdio (used by IDE configs)
  telemetry <status|enable|disable|...>   manage local telemetry (default off)
  version                                 print sfgraph version
```

### `sfgraph install`

| Option | Default | Description |
|---|---|---|
| `--target <t>` | `all` | `claude`, `cursor`, `vscode`, or `all` |
| `--dry-run` | `false` | Show what would be written without writing |
| `--skills-only` | `false` | Install skill playbooks; skip MCP config |
| `--mcp-only` | `false` | Write MCP config; skip skill playbooks |

Idempotent — re-running replaces the `sfgraph` MCP entry without touching other servers you've configured.

### `sfgraph ingest`

| Option | Default | Description |
|---|---|---|
| `--org <alias>` | `sf config target-org` | Salesforce alias/username from `sf` CLI |
| `--mode <mode>` | `auto` | `full`, `incremental`, or `auto` (chooses based on SourceTracking support and prior sync) |
| `--db <path>` | `~/.sfgraph/<orgId>.sqlite` | Override SQLite database path |

Auto-detects the default org from `sf config get target-org` (also supports the older `defaultusername`). Pass `--org` to override.

Auto-snapshot is taken **before every sync** (kind `pre-sync`); pruned to the retention window after the sync completes.

### `sfgraph telemetry`

```bash
sfgraph telemetry status            # show current state (default: disabled)
sfgraph telemetry enable --local    # opt-in to local file sink (~/.config/sfgraph/events.jsonl)
sfgraph telemetry disable           # turn off
sfgraph telemetry preview           # show what a sample event would look like after sanitization
sfgraph telemetry purge             # delete the local sink file
sfgraph telemetry reset-id          # regenerate the random machine-id (only when enabled)
```

---

## The 19 MCP tools

Every tool returns `{ summary, markdown, data, follow_up_tools? }`. The `markdown` field includes a Mermaid block when a diagram aids comprehension; the `data` field is the structured payload your IDE or agent script can consume programmatically.

### Inventory & freshness

| Tool | Purpose |
|---|---|
| `ping` | Smoke-test the server. |
| `start_ingest_job` | Queue a live sync from the agent (alternative to CLI). |
| `get_ingest_job` | Poll ingestion progress. |
| `snapshot_create` | Take a labeled snapshot of the current graph. |
| `snapshot_list` | List snapshots for an org. |
| `point_in_time_diff` | Diff between two snapshots (or snapshot ↔ current). |
| `freshness_report` | Bucketed staleness across the org (hot / current / stale / dead). |

### Impact analysis

| Tool | Purpose |
|---|---|
| `analyze_field` | Radial view of who reads, writes, and has FLS access to one field. |
| `trace_upstream` | Walk reverse edges from a node (who depends on this?). |
| `trace_downstream` | Walk forward edges from a node (what does this depend on?). |
| `cross_layer_flow_map` | LWC → Apex → SOQL → Field sequence diagram. |
| `cross_org_diff` | Drift between two orgs, filterable by category. |
| `impact_from_git_diff` | Map a unified diff to changed graph nodes and their N-hop blast radius. |
| `test_gap_intelligence_from_git_diff` | Same impact set, filtered to dependents without `IS_TEST_FOR` coverage. |
| `what_broke` | Diff against latest pre-sync snapshot, then bucket dependents as red/yellow/green. |

### Quality, security, deployment

| Tool | Purpose |
|---|---|
| `governor_risk_check` | Cached SOQL/DML-in-loop, missing-LIMIT, recursive-trigger findings. |
| `dead_code_audit` | Confidence-ranked candidates with reasons. |
| `security_audit` | Sharing-with-full-access rules, FLS gaps, profile/permset matrix. |
| `deployment_manifest_gen` | Generate `package.xml` + `destructiveChanges.xml` from a cross-org diff. |

---

## Tool details + samples

### `ping`

```jsonc
// input
{}
// output.data
{ "ok": true, "ts": 1715000000 }
```

### `start_ingest_job`

```jsonc
// input
{ "source": { "type": "live-org", "alias": "my-prod" }, "mode": "auto" }
// output.data
{ "jobId": "ing_8a7b…", "state": "queued", "queuePosition": 0 }
```

`source.type` can be `"live-org"` (jsforce, recommended) or `"filesystem"` (path to an sfdx-source tree).

### `get_ingest_job`

```jsonc
// input
{ "job_id": "ing_8a7b…" }
// output.data
{
  "state": "running",      // queued | running | done | error
  "membersProcessed": 1234,
  "startedAt": 1715000010,
  "finishedAt": null,
  "errors": []
}
```

### `snapshot_create`

```jsonc
// input
{ "org": "my-prod", "name": "pre-release-2026.05", "kind": "manual" }
// output.data
{ "snapshotId": "snap_…", "createdAt": 1715000020, "isAuto": false }
```

### `snapshot_list`

```jsonc
// input
{ "org": "my-prod" }
// output.data
{ "snapshots": [ { "id": "snap_…", "label": "pre-release-2026.05", "createdAt": …, "isAuto": false }, … ] }
```

### `point_in_time_diff`

```jsonc
// input
{ "org": "my-prod", "from": "snap_a", "to": "current" }
// output.data
{
  "added":   [ /* NodeFact-shaped */ ],
  "removed": [ /* NodeFact-shaped */ ],
  "changed": [ { "before": { … }, "after": { … } } ],
  "edges":   { "added": [ … ], "removed": [ … ] }
}
```

### `freshness_report`

```jsonc
// input
{ "org": "my-prod", "bucket": "dead" }   // bucket optional: hot | current | stale | dead
// output.data
{
  "buckets": {
    "hot":     [ … ],
    "current": [ … ],
    "stale":   [ … ],
    "dead":    [ { "qualifiedName": "ApexClass:LegacyController", "freshness": 0.04, "lastModified": "2022-03-12" } ]
  }
}
```

### `analyze_field`

```jsonc
// input
{ "org": "my-prod", "object": "Account", "field": "Status__c" }
// output.data
{
  "node": { "qualifiedName": "CustomField:Account.Status__c", … },
  "readers":  [ "ApexMethod:AccountSvc.fetch(1)", "Flow:Account_Update_Status", … ],
  "writers":  [ "ApexMethod:AccountSvc.setStatus(2)", … ],
  "fls":      [ { "profile": "System_Administrator", "readable": true, "editable": true }, … ],
  "mermaid":  "flowchart LR\n  Field([\"Status__c\"]) --> …"
}
```

### `trace_upstream` / `trace_downstream`

```jsonc
// input
{ "org": "my-prod", "qname": "ApexClass:AccountController", "depth": 3 }
// output.data
{ "nodes": [ … ], "edges": [ … ], "mermaid": "flowchart TD\n  …" }
```

### `cross_layer_flow_map`

```jsonc
// input
{ "org": "my-prod", "entry": "LWC:accountTile" }
// output.data
{
  "sequence": [
    { "from": "LWC:accountTile", "to": "ApexMethod:AccountCtrl.getById(1)", "via": "CALLS_APEX_FROM_LWC" },
    { "from": "ApexMethod:AccountCtrl.getById(1)", "to": "CustomObject:Account", "via": "EXECUTES_SOQL" },
    { "from": "ApexMethod:AccountCtrl.getById(1)", "to": "CustomField:Account.Status__c", "via": "READS_FIELD" }
  ],
  "mermaid": "sequenceDiagram\n  …"
}
```

### `cross_org_diff`

```jsonc
// input
{ "org_a": "prod", "org_b": "uat", "category": "ApexClass" }   // category optional, default "all"
// output.data
{ "onlyInA": [ … ], "onlyInB": [ … ], "changed": [ … ] }
```

### `impact_from_git_diff`

```jsonc
// input
{ "org": "my-prod", "diff": "<unified diff text>", "depth": 3 }
// output.data
{
  "changed":      [ "ApexClass:AccountController", "LWC:accountTile" ],
  "blastRadius":  [ { "qualifiedName": "ApexClass:AccountControllerTest", "hops": 1 }, … ],
  "mermaid":      "flowchart LR\n  …"
}
```

### `test_gap_intelligence_from_git_diff`

```jsonc
// input
{ "org": "my-prod", "diff": "<unified diff text>" }
// output.data
{
  "gaps": [
    { "qualifiedName": "ApexMethod:AccountSvc.bulkUpdate(2)", "reason": "no IS_TEST_FOR edge" }
  ],
  "suggestions": [ "Add a test class covering AccountSvc.bulkUpdate" ]
}
```

### `what_broke`

```jsonc
// input
{ "org": "my-prod", "since": "snap_pre-deploy-2026-05-13" }   // since optional, defaults to latest pre-sync snapshot
// output.data
{
  "changed":  [ { "qualifiedName": "ApexClass:AccountController", "kind": "modified" } ],
  "at_risk":  [ { "qualifiedName": "LWC:accountTile", "depends_on": ["ApexClass:AccountController"] } ],
  "covered":  [ { "qualifiedName": "ApexClass:AccountControllerTest", "depends_on": [...] } ],
  "mermaid":  "flowchart LR\n  classDef changed fill:#E74C3C\n  …"
}
```

### `governor_risk_check`

```jsonc
// input
{ "org": "my-prod" }
// output.data
{
  "risks": [
    { "qualifiedName": "ApexMethod:BulkSvc.processAll(0)", "risk": "soql_in_loop", "line": 42, "evidence": "for (Account a : …)" }
  ],
  "cached": true   // true when read from precomputed table (<50ms); false when computed inline
}
```

### `dead_code_audit`

```jsonc
// input
{ "org": "my-prod" }
// output.data
{
  "dead": [
    {
      "qualifiedName": "ApexClass:LegacyHelper",
      "score": 0.92,
      "confidence": "high",      // high | medium | low
      "reasons": ["no_incoming_edges", "stale_freshness:0.04", "no_recent_dependents"]
    }
  ],
  "cached": true
}
```

### `security_audit`

```jsonc
// input
{ "org": "my-prod" }
// output.data
{
  "sharingFullAccess":  [ "SharingRule:Account.Public_Read_Write" ],
  "flsGaps":            [ "CustomField:Account.SSN__c" ],
  "fieldAccessMatrix":  [ { "profile": "Sales_User", "field": "Account.Discount__c", "readable": true, "editable": false } ],
  "cachedFindings":     [ { "qname": "…", "rule": "SEC_SHARING_FULL_ACCESS", "severity": "high", "message": "…" } ]
}
```

### `deployment_manifest_gen`

```jsonc
// input
{ "from_org": "uat", "to_org": "prod", "category": "ApexClass" }   // category optional
// output.data
{
  "packageXml":     "<?xml version=\"1.0\"?>\n<Package …>\n  <types>\n    <members>AccountController</members>\n    <name>ApexClass</name>\n  </types>\n  <version>60.0</version>\n</Package>\n",
  "destructiveXml": "<?xml version=\"1.0\"?>\n<Package …>\n</Package>\n",
  "summary": { "apiVersion": "60.0", "addedOrChanged": 12, "removed": 1, "byType": { "ApexClass": 3, "CustomField": 9 } }
}
```

Run the result yourself: `sf project deploy start --manifest package.xml`. `sfgraph` never deploys.

---

## The 10 skill playbooks

When you `sfgraph install`, ten `SKILL.md` files land in `~/.claude/skills/` and `~/.cursor/rules/`. They route LLM intent to tool sequences so the agent picks up the right tool without you having to name it.

| Skill | Triggers like… | Tools used |
|---|---|---|
| `sf-impact-from-diff` | "what does this PR break", "impact of this diff" | `impact_from_git_diff`, `test_gap_intelligence_from_git_diff` |
| `sf-what-broke` | "what broke", "post-deploy regression", "since deploy" | `what_broke`, `point_in_time_diff` |
| `sf-cross-layer-trace` | "how does this LWC reach the DB", "end-to-end path" | `cross_layer_flow_map`, `analyze_field` |
| `sf-dead-code-audit` | "what can I delete", "unused", "dead code" | `dead_code_audit`, `freshness_report`, `trace_upstream` |
| `sf-governor-risk-fix` | "SOQL in loop", "will this scale", "performance review" | `governor_risk_check` |
| `sf-flow-impact` | "which flows use this field", "flow impact" | `analyze_field`, `trace_upstream` |
| `sf-security-audit` | "FLS", "who has access", "sharing rules" | `security_audit`, `analyze_field` |
| `sf-cross-org-diff` | "sandbox vs prod", "what changed in prod" | `cross_org_diff`, `point_in_time_diff` |
| `sf-deployment-manifest` | "generate package.xml", "deploy these changes" | `deployment_manifest_gen`, `cross_org_diff` |
| `sf-omnistudio-migration-audit` | "Vlocity → OmniStudio status", "migration audit" | `cross_org_diff` + direct queries |

See [`docs/SKILLS.md`](docs/SKILLS.md) for each playbook in full.

---

## Sample agent conversation

```
User: I'm about to merge this PR. Anything I should worry about?

Agent: *invokes sf-impact-from-diff skill*
       → calls impact_from_git_diff(diff="…", depth=3)
       → calls test_gap_intelligence_from_git_diff(diff="…")

       Your diff touches 3 nodes: AccountController, accountTile, and
       Order_Event__e. 9 dependents at 3 hops:
         • 4 have test coverage (green)
         • 5 are at-risk:
             - LWC:opportunityTile  (no IS_TEST_FOR)
             - ApexMethod:BillingSvc.run(2)  (no IS_TEST_FOR)
             - ApexMethod:BillingSvc.dryRun(0)  (no IS_TEST_FOR)
             - Flow:Order_Status_Update  (no test coverage exists for Flows)
             - LWC:invoiceTile  (no IS_TEST_FOR)

       [Mermaid: changed=red, at_risk=yellow, covered=green]

       Recommend adding test coverage for BillingSvc.run(2) before merging.
```

---

## Metadata coverage

`sfgraph` ships typed parsers for **~50 Salesforce metadata types** emitting **~80 typed edge types**. A generic opaque-node fallback captures everything else so nothing is invisible.

| Category | Types covered |
|---|---|
| Apex | `ApexClass`, `ApexInterface`, `ApexMethod`, `ApexTrigger`, `TestMethod` |
| Lightning | `LWC`, `LWCBundle`, `AuraComponent`, `LightningPage` (FlexiPage) |
| Flow | `Flow`, `FlowVersion` |
| Schema | `CustomObject`, `CustomField`, `RecordType`, `ValidationRule`, `PlatformEvent` |
| Vlocity DataPacks | `DataRaptor`, `IntegrationProcedure`, `OmniScript`, `VlocityCard` (+ generic for long tail) |
| OmniStudio native | `OmniProcess`, `OmniDataTransform`, `OmniUiCard`, `OmniIntegrationProcedure` |
| Security | `Profile`, `PermissionSet`, `PermissionSetGroup`, `SharingRule` |
| Integration | `NamedCredential`, `ExternalServiceRegistration`, `PlatformEvent` |
| Visualforce | `ApexPage`, `ApexComponent` |
| UI | `Layout`, `CompactLayout`, `CustomTab`, `CustomApplication` |
| Reporting | `Report`, `Dashboard`, `ReportType` |
| GenAI | `GenAiPlanner`, `GenAiPlugin`, `GenAiFunction` |
| Experience Cloud | `Network`, `ExperienceBundle` |
| Automation | `Workflow`, `ApprovalProcess`, `DuplicateRule`, `MatchingRule` |
| Other | `CustomMetadataType`, `CustomLabel`, `StaticResource`, `Group`, `Queue`, `Role` |
| Cross-flavor | `CANONICAL_OF` edges automatically join Vlocity-CMT ↔ OmniStudio-on-Core duplicates |

Cross-flavor resolver runs as a post-pass and emits `CANONICAL_OF` edges so the agent treats `DataRaptor:X` and `OmniDataTransform:X` as the same logical asset.

---

## Performance

Measured locally on a synthetic workload (Phase 1 perf test):

| Workload | Time | Target |
|---|---|---|
| 50K nodes + 50K edges merge + snapshot + diff | **565 ms** | < 5 s |

Estimated on a real org (verify on your sandbox):

| Workload | Target |
|---|---|
| Full sync of a 50K-node sandbox | < 6 min |
| Incremental sync via SourceMember polling | < 30 s |
| Tool p95 latency (cached: governor_risk_check, dead_code_audit, security_audit) | < 50 ms |
| Tool p95 latency (analyze_field, what_broke) | < 500 ms |
| Tool p95 latency (impact_from_git_diff depth=3) | < 1 s |

Storage is content-hash short-circuited — re-parsing an unchanged Apex class doesn't write to SQLite at all.

---

## Where data lives on your machine

| Path | Contents |
|---|---|
| `~/.sfgraph/<orgId>.sqlite` | Per-org graph + vectors (single file) |
| `~/.sfgraph/backups/*.sqlite` | Pre-migration backups (rolling, last 5) |
| `~/.config/sfgraph/sfgraph.json` | Telemetry config (default off) |
| `~/.config/sfgraph/machine-id` | Random UUID — only created if you enable telemetry |
| `~/.claude/skills/sf-*` | 10 SKILL.md playbooks for Claude |
| `~/.cursor/rules/sf-*.mdc` | Same, Cursor flavor |
| `~/Library/Application Support/Claude/claude_desktop_config.json` | MCP server entry for Claude Desktop |
| `~/.cursor/mcp.json` | MCP server entry for Cursor |
| `~/.config/Code/User/mcp.json` | MCP server entry for VS Code |

What is **never** stored: passwords, access tokens (they stay in `~/.sfdx/`, owned by the `sf` CLI), or your codebase content (telemetry events are field-allowlisted).

---

## Package layout (monorepo)

```
apps/
  sfgraph/              # the unscoped npm binary (this is `npx sfgraph`)
packages/
  shared/               # cross-cutting types, errors, logger, paths
  core/                 # engine: storage, parsers, extractors, analyze, render
  mcp-server/           # stdio MCP, 19 tools, shutdown discipline
  cli/                  # install, ingest, mcp, telemetry, version
  skills/               # 10 SKILL.md playbooks + installer
  models/               # vendored MiniLM ONNX + loader
```

Each package publishes independently:

| Package | Purpose |
|---|---|
| [`sfgraph`](https://www.npmjs.com/package/sfgraph) | The CLI binary. What 99% of users install. |
| [`@sfgraph/core`](https://www.npmjs.com/package/@sfgraph/core) | Engine library. Use if you want to embed sfgraph in your own tooling. |
| [`@sfgraph/mcp-server`](https://www.npmjs.com/package/@sfgraph/mcp-server) | MCP server. Useful if you're building a custom MCP host. |
| [`@sfgraph/cli`](https://www.npmjs.com/package/@sfgraph/cli) | CLI as a library. |
| [`@sfgraph/skills`](https://www.npmjs.com/package/@sfgraph/skills) | Skill playbooks + installer. |
| [`@sfgraph/shared`](https://www.npmjs.com/package/@sfgraph/shared) | Shared types and errors. |
| [`@sfgraph/models`](https://www.npmjs.com/package/@sfgraph/models) | Vendored embedding model (MiniLM L6 v2 quantized, ~30 MB via Git LFS). |

---

## Development

```bash
git clone https://github.com/ryanStark24/sfgraph
cd sfgraph
pnpm install
pnpm build          # build all packages
pnpm test           # 298 tests
pnpm typecheck      # strict TS
pnpm lint           # Biome
```

Required: Node ≥ 20, pnpm 10.

### Publishing

```bash
pnpm changeset                  # describe the change
pnpm changeset version          # bumps versions across packages
pnpm build && pnpm test
pnpm changeset publish
```

---

## Further reading

- [`docs/TOOLS.md`](docs/TOOLS.md) — full MCP tool reference (schemas, examples)
- [`docs/SKILLS.md`](docs/SKILLS.md) — skill playbooks
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — read-only enforcement, sanitizer, threat model
- [`CHANGELOG.md`](CHANGELOG.md) — per-phase release notes

---

## License

MIT
