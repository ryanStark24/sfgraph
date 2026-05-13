# sfgraph 1.0 MCP Tools

Nineteen MCP tools ship in `@ryanstark24/sfgraph-server`. Every tool returns a
`{ summary, markdown, data }` envelope; many include a `mermaid` field in
`data` for IDE rendering. All tools require `--org` (alias or 15/18-char org id).

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
| `cross_layer_flow_map`            | LWC -> Apex -> SOQL -> Field path.                       |
| `cross_org_diff`                  | Drift between two orgs.                                  |
| `impact_from_git_diff`            | Map a code diff to graph blast-radius.                   |
| `test_gap_intelligence_from_git_diff` | Suggest tests for changed code.                       |
| `what_broke`                      | Recent changes correlated to a regression.               |
| `governor_risk_check`             | SOQL/DML-in-loop, unbounded query.                       |
| `dead_code_audit`                 | Low-freshness, orphan candidates with confidence.        |
| `security_audit`                  | Sharing, FLS, security findings.                         |
| `deployment_manifest_gen`         | package.xml + destructiveChanges.xml from cross-org diff.|

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

```jsonc
// input
{ "org": "my-prod", "mode": "full" | "incremental" | "auto" }
// output.data
{ "jobId": "ing_...", "mode": "full" }
```

### `get_ingest_job`

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
{ "org": "alias", "from": "snap-id", "to": "snap-id" }
// output.data: { onlyInA, onlyInB, changed }
```

### `freshness_report`

```jsonc
{ "org": "alias" }
// output.data: { buckets: { hot, current, stale, dead } }
```

### `analyze_field`

```jsonc
{ "org": "alias", "field": "Account.Industry" }
// output.data: { readers: [...], writers: [...] }
```

### `trace_upstream` / `trace_downstream`

```jsonc
{ "org": "alias", "qname": "ApexClass:Foo", "hops": 3 }
// output.data: { nodes, edges, mermaid }
```

### `cross_layer_flow_map`

```jsonc
{ "org": "alias", "from": "LightningComponentBundle:foo" }
// output.data: { paths: [...] }
```

### `cross_org_diff`

```jsonc
{ "org_a": "prod", "org_b": "uat", "category": "ApexClass" }
// output.data: { onlyInA, onlyInB, changed }
```

### `impact_from_git_diff`

```jsonc
{ "org": "alias", "base_ref": "main", "head_ref": "HEAD" }
// output.data: { changed: [...], blastRadius: [...] }
```

### `test_gap_intelligence_from_git_diff`

```jsonc
{ "org": "alias", "base_ref": "main", "head_ref": "HEAD" }
// output.data: { gaps: [...], suggestions: [...] }
```

### `what_broke`

```jsonc
{ "org": "alias", "since_iso": "2025-05-01T00:00:00Z" }
// output.data: { suspects: [...] }
```

### `governor_risk_check`

```jsonc
{ "org": "alias" }
// output.data
{
  "risks": [{ "qualifiedName": "ApexClass:Foo", "risk": "soql_in_loop", "evidence": "..." }],
  "cached": true
}
```

Reads `_sfgraph_governor_risks` when populated (cached path is < 50 ms);
falls back to inline scan otherwise.

### `dead_code_audit`

```jsonc
{ "org": "alias" }
// output.data
{
  "dead": [
    { "qualifiedName": "ApexClass:Lonely", "score": 0.08, "confidence": "high",
      "reasons": ["no_incoming_edges", "stale_freshness"] }
  ],
  "cached": true
}
```

### `security_audit`

```jsonc
{ "org": "alias" }
// output.data
{
  "sharingFullAccess": ["SharingRule:Account.r1"],
  "flsGaps": ["CustomField:Account.SSN__c"],
  "fieldAccessMatrix": [...],
  "cachedFindings": [{ "qname": "...", "rule": "sharing.full_access", "message": "..." }]
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
