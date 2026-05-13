# Privacy

sfgraph is local-only and read-only by design.

## Three pillars

1. **No codebase egress.** Source content never leaves your machine. The graph
   and vector store are SQLite files under `~/.sfgraph/`. The MCP server
   listens on stdio only.
2. **Read-only Salesforce access.** Every `jsforce`/`@salesforce/core` call is
   wrapped in a `ReadOnlyProxy` that throws on any mutating method
   (`create`, `update`, `delete`, `upsert`, `destroy`, `*sobject().create`,
   etc.). The proxy is verified by a unit test that enumerates every method
   on a connection mock.
3. **Failure-only, sanitized telemetry.** Default is `NullSink`. Opt-in users
   get `LocalFileSink` writing JSONL under
   `~/.sfgraph/telemetry/`. Every event passes through `Sanitizer` which
   - strips Salesforce IDs, org URLs, usernames, emails, tokens, JWTs, file
     paths under `$HOME`, and stack-trace user-paths;
   - allowlists only the keys declared in `event-schema.ts`;
   - hashes the machine ID once (SHA-256 of OS user + hostname) so the same
     install can be correlated without revealing identity.

## What the local sink stores

Failure events only. Each line is one JSON object with:

```jsonc
{
  "ts": 1715000000000,
  "kind": "tool_error" | "ingest_error" | "parser_error" | ...,
  "tool": "governor_risk_check",
  "code": "E_SF_QUERY",
  "durationMs": 412,
  "machineId": "sha256:..."
}
```

No qualified names, no source, no error messages from external systems.

## HTTP sink

Deferred to 1.1. Until then, there is no path that sends data off-host even
if `telemetry.enabled = true`.

## Verifying

- `network-egress.test.ts` asserts that importing `@sfgraph/core` and
  constructing the MCP server resolves no external DNS.
- `read-only-proxy.test.ts` asserts every mutating method on a mock
  Connection throws.
- `sanitizer.test.ts` runs 50+ adversarial inputs.
