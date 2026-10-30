# sfgraph 1.7 MCP Tools

Twenty-nine MCP tools ship in `@ryanstark24/sfgraph-server`. Every tool returns a
`{ summary, markdown, data }` envelope; many include a `mermaid` field in
`data` for IDE rendering. Every org-scoped tool takes `org`, either a 15/18-char
orgId or an alias.

**Alias resolution.** An alias is looked up in sfgraph's own data only:
first the local registry (the `_sfgraph_orgs` row of each ingested
`<orgId>.sqlite` in the data dir; exact alias, then case-insensitive, and a
case-insensitive match that hits two orgs is an error), then
`orgs-snapshot.json` (written by `sfgraph install` / `sfgraph refresh-orgs`).
An alias found in neither fails fast with `unknown org alias` and a list of
ingested orgs; no empty `<alias>.sqlite` is created. The sf CLI auth store
(AuthInfo, which can block on a keychain prompt) is consulted only when
`SFGRAPH_ALIAS_SF_FALLBACK=1` (or `true`) is set, and each such lookup is cut
off after `SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS` (default 5000 ms). `list_orgs`
follows the same rule.

## Quick reference

| Tool                              | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `ping`                            | Smoke-test the server.                                   |
| `start_ingest_job`                | Trigger live sync.                                       |
| `get_ingest_job`                  | Poll ingestion progress.                                 |
| `snapshot_create`                 | Take a labeled snapshot.                                 |
| `snapshot_list`                   | List snapshots for an org.                               |
| `point_in_time_diff`              | Diff two snapshots.                                      |
| `freshness_report`                | Bucketed staleness across the org.                       |
| `analyze_field`                   | Read/write fan-out for one field.                        |
| `trace_upstream`                  | Walk dependents.                                         |
| `trace_downstream`                | Walk dependencies.                                       |
| `find_nodes`                      | Glob lookup of node qnames.                              |
| `cross_layer_flow_map`            | LWC -> Apex -> SOQL -> Field path.                       |
| `cross_org_diff`                  | Drift between two orgs.                                  |
| `impact_from_git_diff`            | Map a code diff to graph blast-radius.                   |
| `test_gap_intelligence_from_git_diff` | Suggest tests for changed code.                       |
| `what_broke`                      | Recent changes correlated to a regression.               |
| `governor_risk_check`             | SOQL/DML-in-loop, unbounded query.                       |
| `dead_code_audit`                 | Zero-inbound candidates; freshness grades confidence (high = stale). |
| `security_audit`                  | Sharing, FLS, security findings.                         |
| `export_sarif`                    | All audit findings as one SARIF 2.1.0 report.            |
| `deployment_manifest_gen`         | package.xml + destructiveChanges.xml from cross-org diff.|
| `list_orgs`                       | List ingested orgs with last-sync timestamps.            |
| `staleness_check`                 | Check how old the local ingest is (warns at >=7 days).   |
| `explain_code`                    | Read a stored code snippet; optionally cache an LLM explanation. |
| `resolve_frame`                   | Resolve a Salesforce stack frame to exact, line-aware stored Apex source. |
| `find_similar`                    | Semantic KNN over node embeddings — find similar metadata by qname or by free-text concept. |
| `wip_impact`                      | Blast-radius for uncommitted local changes.              |
| `wip_diff`                        | Compute the WIP overlay vs the ingested baseline.        |
| `wip_test_gap`                    | Test coverage gaps for WIP changes.                      |

## Schemas

All tools take JSON via the MCP protocol. The shared envelope is:

```ts
{
  summary: string;
  markdown: string;
  data: Record<string, unknown>;
}
```

### `ping`

```jsonc
// input
{}
// output
{ summary: "pong", markdown: "pong", data: { ts: 1715000000 } }
```

### `start_ingest_job`

The MCP server has **no in-process ingest worker**. This tool no longer enqueues a job — it refuses to run the ingest and returns the exact shell command the user (or their automation) should run.

```jsonc
// input
{
  "source": { "type": "live-org", "alias": "my-prod" }
  // — or —
  // "source": { "type": "filesystem", "path": "/abs/path/to/sfdx-project" }
  ,
  "mode": "full" | "incremental" | "auto"
}
// output.data
{
  "executed": false,
  "run_this_command": "sfgraph ingest --org my-prod"
}
```

Surface `run_this_command` verbatim to the user. Do not claim the MCP server will execute it.

### `get_ingest_job`

Looks up historical CLI ingest runs from an **in-memory job store** maintained by the MCP server process. Restarting the MCP server clears it. This tool has no relationship to `start_ingest_job` anymore — `start_ingest_job` never enqueues a job, so there is nothing for this tool to find that didn't come from a prior CLI run observed by the same MCP process.

```jsonc
{ "job_id": "ing_..." }
// output.data
{ "state": "running" | "done" | "error", "membersProcessed": 1234 }
```

### `snapshot_create`

```jsonc
{ "org": "alias", "label": "pre-release" }
// output.data: { snapshotId, createdAt }
```

### `snapshot_list`

```jsonc
{ "org": "alias" }
// output.data: { snapshots: [{ id, label, createdAt }] }
```

### `point_in_time_diff`

```jsonc
{ "org": "alias", "from": "snap-id", "to": "snap-id" | "current", "limit": 100 }
// output.data
{
  "componentDiff": { "added": [...], "removed": [...], "changed": [...] },        // component qnames, each <= limit
  "nonComponentChanges": { "added": [...], "removed": [...], "changed": [...], "counts": {...} },
  "nodeDiff": { "added": [...], "removed": [...], "changed": [...] },  // raw, every label, each <= limit
  "edgeDiff": { "added": [...], "removed": [...] },                    // each <= limit
  "counts": { "nodes": {...}, "components": {...}, "nonComponent": {...}, "edges": { "added", "removed" } },
  "truncated": false,      // true when any list was cut to `limit`
  "baselineEmpty": false   // true when `from` was taken before the first ingest
}
```

`componentDiff` is the component answer. Component labels are core
`COMPONENT_LABELS` (code, declarative logic, OmniStudio components with a
dedicated parser, schema definitions, integration endpoints; each label has a
documented reason in `component-scope.ts`). Members roll up to their owner
(`componentOf`, or the name grammar for a removed member): a method is its
class, a FlowVersion its Flow, an LWC bundle its LWC. A unit whose own row is
in the diff takes that row's bucket; a unit reached only through its members
is `changed`. Records and configuration (custom metadata records, Vlocity
DataPack records and other opaque-fallback labels, profiles, permission sets,
layouts, labels, ...) are never dropped: they are in `nonComponentChanges` and
under their own markdown heading.

### `freshness_report`

```jsonc
{ "org": "alias" }
// output.data: { buckets: { hot, current, stale, dead } }
```

### `analyze_field`

```jsonc
{ "org": "alias", "object": "Account", "field": "Industry",
  "include_grants": false, "mermaid": false }
// output.data: { readers: [...], writers: [...], grants: [...], grants_count }
```

Readers/writers cover every `*_READS_FIELD` / `*_WRITES_FIELD` rel (Apex, Flow, LWC, OmniScript, IP, DataRaptor, ...). Profile/PermissionSet grants are hidden unless `include_grants: true`.

**Input validation.** Both `object` and `field` must match the Salesforce API-name pattern
`/^[A-Za-z][A-Za-z0-9_]*(?:__[a-zA-Z])?$/` (alphabetic start, alphanumeric / underscore body, optional managed-package suffix). Malformed inputs are rejected with a 400-style error before any graph query runs.

### `trace_upstream` / `trace_downstream`

```jsonc
{ "org": "alias", "qname": "ApexClass:Foo", "depth": 3,
  "include_security": false, "include_inferred": false,
  "include_structure": false,          // trace_downstream only
  "rel_types": ["CALLS"], "labels": ["ApexClass"], "mermaid": false }
// output.data: { found: true, nodes, edges, reached: [{ qualifiedName, label, hop, relType, hasNode, via?, role? }], pseudo, truncated, filtered }
// unknown qname: summary "node not found: <qname>", data { found: false, qname, nodes: [], edges: [], reached: [], truncated: false },
//                markdown suggests find_nodes { pattern: "*<name>*" }, follow_up_tools ["find_nodes"]
```

Text output is a plain list of full qnames grouped by label, each with its min
hop and the rel it was reached by (dangling edge endpoints are listed as
`(no node)`), capped at 300 entries. `mermaid: true` appends a diagram.

`trace_downstream` defaults: objects and fields are leaves (a reached
CustomObject / CustomField / ValidationRule / RecordType / NamedCredential is
not expanded along DEFINES_FIELD, HAS_VALIDATION_RULE, HAS_RECORD_TYPE,
CONTAINS, field→field READS_FIELD or DEPENDS_ON_FIELD; `include_structure:
true` restores that), and Apex rolls up to class (reaching an ApexMethod also
reaches its ApexClass and the class's other methods at the same hop).
`trace_upstream` is unchanged.

Rows with a `role` are shown but not counted: `root-member` (the root's own
members) and, in `trace_downstream`, `standard-field` (a reached field with no
custom `__<suffix>` such as `__c`, `__pc` or `__s`, e.g.
`CustomField:Account.Name`, listed under its own heading).
`data.pseudo` holds the endpoints that are not org components (`pseudoKind`):
`apex-platform`, `dml`, `lwc-property`, `lwc-event`, `remote-duplicate`, and in
`trace_downstream` `managed-package`: a `ns.Type` target with no node whose
`ns` is a namespace of the org's own `ns__X__c` objects or fields (read from
the graph, no fixed namespace list).

### `find_nodes`

```jsonc
{ "org": "alias", "pattern": "CustomField:Account.*", "label": "CustomField", "limit": 200 }
// output.data: { matches: [{ qualifiedName, label }], total, truncated }
```

The pattern is matched against the whole qualifiedName, case-insensitively.
`*` matches any run of characters, dots included (`**` is the same as `*`),
`?` matches one character, and `{a,b}` lists alternatives. Matching runs in
linear time with no backtracking. The tool accepts at most 256 characters and
4 `*` runs (`**` counts as one); core applies its own length and alternative
caps on top of that. Results are sorted by qname, capped at `limit` (default
200), and `truncated` is set when the cap cut the list.

### `cross_layer_flow_map`

```jsonc
{ "org": "alias", "entry": "LWC:foo" }
// output.data: { participants: [{ id, label, layer, role? }], messages: [{ fromId, toId, label }],
//                pseudo: [{ id, pseudoKind }], truncated: false }
```

`participants[0]` is the entry (`role: "entry"`). Standard fields (no custom
`__<suffix>` such as `__c`, `__pc` or `__s`) are drawn with `role: "standard-field"`; neither is counted in the
summary. A reached member also expands its owner (`componentOf`): reaching
`ApexMethod:C.m` follows class `C`'s other methods too. Platform Apex, DML,
LWC properties/events and managed-package types with no node go to `pseudo`.

The BFS is **capped at 100 visited nodes**. When the cap is hit, `data.truncated` is `true` and the rendered markdown includes a `_truncated_` marker line so downstream agents can detect the partial result.

### `cross_org_diff`

```jsonc
{ "org_a": "prod", "org_b": "uat", "category": "ApexClass" }
// output.data: { onlyInA, onlyInB, changed }
```

### `impact_from_git_diff`

```jsonc
{ "org": "alias", "diff": "<unified diff text>", "depth": 3 }
// output.data
{
  "seedQnames": [...],     // qnames mapped from the changed file paths
  "impacted": [...],       // seeds + their upstream dependents
  "dependents": [...],     // upstream only: what depends on the change (the blast radius)
  "dependencies": [...],   // 1 hop downstream of the seeds: context, not impact
  "notFound": [...],       // seeds that are not in the graph (new or not ingested)
  "truncated": false
}
```

### `test_gap_intelligence_from_git_diff`

```jsonc
{ "org": "alias", "diff": "<unified diff text>" }
// output.data: { gaps: [...], covered: [...], notFound: [...] }
```

### `what_broke`

```jsonc
{ "org": "alias", "since": "snap-id", "limit": 100 }   // since defaults to the latest non-empty auto snapshot
// output.data
{
  "changed": [...], "added": [...], "removed": [...], "atRisk": [...], "covered": [...],  // each <= limit
  "nonComponentChanges": { "changed": [...], "added": [...], "removed": [...] },
  "nonComponentDependents": [...],
  "counts": { "changed", "added", "removed", "atRisk", "covered", "nonComponent": {...} },  // full totals
  "seedsTraced": 200,      // dependents are traced for at most 200 change seeds
  "seedsTruncated": 0,     // change seeds that were not traced
  "untracedSeeds": [...],  // record/config changes (raw qnames) not traced for dependents, <= limit
  "untracedSeedsTotal": 0, // their full count (also in the prose)
  "truncated": false       // true when a list was cut OR seedsTruncated > 0
}
// each dependent is classified once (atRisk or covered), even if several seeds reach it
```

Changes are scoped like `point_in_time_diff`: `changed` lists component units
with members rolled up (a removed method is listed as its class, which is
`changed`, not `removed`), and dependents are traced from component changes
only. Record and configuration changes, and record/config nodes that depend on
a changed component, are kept apart in `nonComponentChanges` and
`nonComponentDependents`; the record/config changes that seeded no dependent
trace are named in `untracedSeeds`. Seeds and dependents roll up with the same
helper (`changeUnitOf`), so an LWC bundle is its LWC on both sides.

### `governor_risk_check`

```jsonc
{ "org": "alias", "limit": 50, "includeTests": false }
// output.data
{
  "risks": [{ "qualifiedName": "ApexClass:Foo", "risk": "soql_in_loop", "evidence": "..." }],
  "total": 1, "truncated": false,
  "source": "live" | "live+cache", "cache": "absent" | "fresh" | "stale" | "unknown",
  "cacheReason": "...",   // when the cache is not fresh
  "excludedTests": 0,     // test-code risks hidden because includeTests is false
  "cached": false         // true when source is live+cache
}
```

Every call scans the graph live. The `_sfgraph_governor_risks` cache is read
only when it is fresh (computed after the last sync), and then only adds risks
the live scan missed. A stale or unverifiable cache is ignored, and the
markdown says so. Test code (TestMethod / `@isTest`) is excluded unless
`includeTests: true`.

### `export_sarif`

```jsonc
{ "org": "alias", "audits": ["governor", "security", "dead-code", "dangling"], "includeTests": false }
// output.data: { report, findings, lintErrors, sources: { governor: "live", ... } }
```

One SARIF 2.1.0 report for the selected audits. As in
`governor_risk_check`, test code is excluded from governor findings by
default; pass `includeTests: true` to keep it. `sources` records, per audit,
whether it was computed live or with a fresh cache. The governor and dead-code
caches are trusted only when fresh (computed after the last sync); a stale or
unverifiable cache is ignored and the audit is recomputed live.

### `dead_code_audit`

Candidates come from core's `deadCodeCandidates`. References from test code
count as references. `dead` lists nodes nothing references; an `@isTest` class
nothing references is dead too, with `isTest: true` and the reason
`test_class`. Production code referenced only by tests is not dead: it is
listed apart in `referencedOnlyByTests` (reason `referenced_only_by_tests`),
since deleting it means deleting those tests too. SARIF dead-code findings are
the `dead` rows.
The score cache is read through core's version-stamped `readDeadCodeScores`,
so rows from an older scorer are never served, and only when fresh (computed
after the last sync). Otherwise the audit is scored live (`cached: false`).
Every `data.dead` row has the same shape,
`{ qualifiedName, isTest, score, confidence, reasons }`, on the cached, live and
unscored-label paths. Unscored labels have `score: null` and `confidence: null`.

```jsonc
{ "org": "alias", "label": "ApexClass", "pattern": "Acme_*", "limit": 50 }
// label / pattern (name prefix or glob) are optional filters; text output is a plain list
// output.data
{
  "dead": [
    { "qualifiedName": "ApexClass:Lonely", "isTest": false, "score": 0.08, "confidence": "high",
      "reasons": ["no_incoming_edges", "stale_freshness"] },
    { "qualifiedName": "ApexClass:LonelyTest", "isTest": true, "score": 0.1, "confidence": "high",
      "reasons": ["no_incoming_edges", "test_class", "stale_freshness"] }
  ],
  "total": 2, "byConfidence": { "high": 2 }, "byLabel": { "ApexClass": 2 },
  "referencedOnlyByTests": [
    { "qualifiedName": "ApexClass:OnlyTested", "score": 0.1, "confidence": "high",
      "reasons": ["referenced_only_by_tests", "stale_freshness"] }
  ],
  "referencedOnlyByTestsTotal": 1,
  "cached": true
}
// labels outside the scored set (e.g. DataRaptor) are listed live by the same rule with
// the same row shape, { qualifiedName, isTest, score: null, confidence: null, reasons: [] },
// plus scored: false and live: true at the top level
```

### `security_audit`

```jsonc
{ "org": "alias", "object": "Account", "field": "CustomField:Account.SSN__c",
  "include_non_fls_fields": false, "limit": 30 }
// output.data (every list is capped at `limit`; *Total fields hold the full counts)
{
  "sharingFullAccess": ["SharingRule:Account.r1"], "sharingFullAccessTotal": 1,
  "flsGaps": ["CustomField:Account.SSN__c"],       "flsGapsTotal": 1,
  "fieldAccessMatrix": [...],                      "fieldAccessMatrixTotal": 0,
  "cachedFindings": [{ "qname": "...", "rule": "sharing.full_access", "message": "..." }],
  "cachedFindingsTotal": 1,
  "limited": false   // true when any list was cut
}
```

### `deployment_manifest_gen`

```jsonc
{ "from_org": "uat", "to_org": "prod", "category": "all" | "ApexClass" | ... }
// output.data
{
  "packageXml": "<?xml ... </Package>\n",
  "destructiveXml": "<?xml ... </Package>\n",
  "summary": { "apiVersion": "60.0", "addedOrChanged": 12, "removed": 1, "byType": { "ApexClass": 3 } }
}
```

API version is read from the source org's stored `apiVersion`; defaults to
`59.0` when unknown.

### `list_orgs`

```jsonc
// input
{}
// output.data
{
  "orgs": [
    { "orgId": "00Dxx0000000ABCEAA", "alias": "my-prod", "username": "...", "instanceUrl": "...",
      "isDefault": true, "ingested": true, "lastSyncedAt": 1715000000000, "ageDays": 1, "stale": false }
  ],
  "defaultAlias": "my-prod"
}
```

By default the list comes from sfgraph's own data: the ingested
`<orgId>.sqlite` graphs plus `orgs-snapshot.json`. It does not read the sf CLI
auth store, so it never triggers a keychain prompt. Set
`SFGRAPH_ALIAS_SF_FALLBACK=1` to also list sf CLI auths and the sf default
org; each sf CLI call is then cut off after
`SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS` (default 5000 ms), and on timeout the list
falls back to sfgraph's own data with a note.

### `staleness_check`

```jsonc
{ "org": "alias" }
// output.data
{ "lastSyncedAt": 1715000000000, "ageDays": 3, "stale": false, "recommendation": "..." }
```

Stale threshold is 7 days.

### `explain_code`

```jsonc
// Read mode
{ "org": "alias", "qname": "ApexMethod:AccountSvc.calculate(2)" }
// output.data
{
  "qname": "ApexMethod:AccountSvc.calculate(2)",
  "sourceFormat": "apex",
  "sourceText": "Decimal total = 0; ...",
  "startLine": 42,
  "endLine": 71,
  "cachedExplanation": null,
  "cachedAt": null,
  "stored": false
}

// Write mode — caches an explanation back
{ "org": "alias", "qname": "ApexMethod:...", "annotation": "Computes the discount..." }
// output.data.stored: true
```

Source comes from the `_sfgraph_snippets` table populated by code parsers
during ingest. Currently emitted for Apex methods; future work covers LWC and
Flow.

### `resolve_frame`

Use this before `explain_code` when a debug log or exception contains a Salesforce frame. It uses
the persistent frame index, not a broad node-name search, and only returns a source when the
stack line falls inside exactly one stored method or trigger range.

```jsonc
// Frame text can be embedded in a longer exception.
{ "org": "alias", "frame": "Class.OrderBillingService.sendInvoice: line 142", "context_lines": 12 }
// Or supply the already-parsed form.
{ "org": "alias", "kind": "class", "class_name": "OrderBillingService", "method": "sendInvoice", "line": 142 }
// output.data (resolved)
{
  "status": "resolved",
  "qname": "ApexMethod:OrderBillingService.sendInvoice(1)",
  "sourceHash": "…",
  "sourceRange": { "startLine": 120, "endLine": 180 },
  "excerpt": { "startLine": 130, "endLine": 154, "focusLine": 142, "sourceText": "…" }
}
```

`status: "not_found"`, `"line_outside_source"`, or `"ambiguous"` is an evidence result, not a
fallback: re-ingest or retrieve current source rather than choosing a plausible method. MCP
freshness is attached separately in response metadata. `resolve_frame` is available in the full
tool profile; it is intentionally excluded from `SFGRAPH_TOOLS=core`.

### `wip_impact`

```jsonc
{ "org": "alias", "diff_base": "origin/main" }
// output.data
{ "changed": [...], "blastRadius": [...], "transient": true }
```

Reads your sfdx-project working tree, parses with the same parsers used in
ingest, joins with the persistent graph in-memory (no writes), and returns
the blast radius for uncommitted changes.

### `wip_diff`

```jsonc
{ "org": "alias", "diff_base": "origin/main" }
// output.data: { added: [...], removed: [...], changed: [...] }
```

### `wip_test_gap`

```jsonc
{ "org": "alias", "diff_base": "origin/main" }
// output.data: { gaps: [...], suggestions: [...] }
```
