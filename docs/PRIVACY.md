# Privacy

sfgraph keeps its graph and vector store on your machine and is designed to only read from Salesforce. The sections below say exactly what is enforced and where the limits are.

## Three pillars

1. **No codebase egress.** Source content never leaves your machine. The graph
   and vector store are SQLite files under the platform's user-data directory
   (`~/Library/Application Support/sfgraph/` on macOS, `~/.local/share/sfgraph/`
   on Linux, `%APPDATA%\sfgraph\` on Windows — see
   [`DATA_LOCATIONS.md`](DATA_LOCATIONS.md)). The MCP server listens on stdio
   only.
2. **Read-only Salesforce access.** Two layers, both in
   `packages/core/src/extractors/live-org/`:
   - *Read facade* (`read-facade.ts`). Extractors never see a `jsforce`
     object. They get a typed facade with only the read calls sfgraph makes
     (SOQL query/queryMore on REST and Tooling, describe, identity, Metadata
     `list`/`read`/`describe`/`retrieve`). It has no write methods, no generic
     `request`, and no back-reference to the connection.
   - *Transport guard* (`transport-guard.ts`), installed on the real
     connection. It refuses any request that is not GET or HEAD, except
     Metadata API SOAP calls whose envelope operation is `listMetadata`,
     `readMetadata`, `describeMetadata`, `retrieve`, `checkStatus` or
     `checkRetrieveStatus`. It also refuses the Tooling GET endpoints that
     execute Apex (`executeAnonymous`, `runTests*`). A refused call throws
     `ReadOnlyViolationError` naming the method and URL before anything is
     sent.

   Limits: this covers every request made through the connection objects
   sfgraph creates (`resolveOrg`). Code that calls jsforce internals directly,
   such as its transport prototype, is outside the guard; sfgraph does not do
   that and extractors only receive the read facade.
   The OAuth token refresh that `@salesforce/core` does with its own client is
   outside the guard; it exchanges a refresh token and does not read or write
   org data. A new read that needs POST must be added to the allow-list
   deliberately. sfgraph still sends queries to your org and receives
   metadata and source from it; "read-only" describes what it asks the org to
   do, not network silence.
3. **Failure-only, sanitized telemetry.** Default is `NullSink`. Opt-in users
   get `LocalFileSink` writing JSONL under `<log-dir>/telemetry/` (resolved
   via env-paths; macOS: `~/Library/Logs/sfgraph/telemetry/`). Every event
   passes through `Sanitizer` which
   - strips Salesforce IDs, org URLs, usernames, emails, tokens, JWTs, file
     paths under `$HOME`, and stack-trace user-paths;
   - allowlists only the keys declared in `event-schema.ts`;
   - includes a machine ID that is a random UUIDv4 generated only on opt-in
     (no hash of OS user / hostname; just a UUID stored locally at
     `<config-dir>/machine-id`) so the same install can be correlated
     without revealing identity. Reset or delete it any time with
     `sfgraph telemetry reset-id` / `sfgraph telemetry purge`.

## What the local sink stores

Failure events only. Each line is one JSON object with:

```jsonc
{
  "ts": 1715000000000,
  "kind": "tool_error" | "ingest_error" | "parser_error" | ...,
  "tool": "governor_risk_check",
  "code": "E_SF_QUERY",
  "durationMs": 412,
  "machineId": "<uuidv4>"
}
```

No qualified names, no source, no error messages from external systems.

## How telemetry data flows — and where it goes

There is **no operator-side telemetry collection**. The project does not run
a backend; nobody on the project side receives telemetry. The pipeline exists
so users can opt into local diagnostics for their own debugging, nothing more.

Concretely:

- **Default state**: telemetry is OFF. `TelemetryPipeline.record()` is wired
  to `NullSink`, which discards every event. Zero filesystem writes, zero
  machine-id generation.
- **If a user opts in** with `sfgraph telemetry enable --local`, a random
  UUIDv4 is generated and stored at `~/.config/sfgraph/machine-id`. The
  pipeline switches to `LocalFileSink`, which appends one JSONL line per
  event to `~/.config/sfgraph/events.jsonl` after passing the allowlist
  check + sanitizer.
- **Local sink is the only sink that exists.** There is no remote endpoint,
  no upload step, no fallback path that could exfiltrate data even if
  `telemetry.enabled = true`. The "HTTP sink" slot in the code is a TODO
  reserved for v1.1; it has never been implemented and never will be without
  a second, explicit user opt-in.
- **The user is the only consumer of their own telemetry file.** Common
  use case: `cat ~/.config/sfgraph/events.jsonl | jq` to debug a failed
  ingest. `sfgraph telemetry purge` deletes the file; `reset-id`
  regenerates the UUID; `preview` shows what a sample event would look
  like after sanitization so users can inspect the format before opting in.

If you're an organization considering enabling local telemetry across many
developer machines, you can:
1. Inspect `packages/core/src/telemetry/event-schema.ts` to see the exact
   field allowlist per event kind.
2. Inspect `packages/core/src/telemetry/sanitizer.ts` for the scrub patterns.
3. Run `sfgraph telemetry preview` on a representative machine to see real
   sanitized output before broad rollout.

## Verifying

- `network-egress.test.ts` asserts that importing `@ryanstark24/sfgraph-core` and
  constructing the MCP server resolves no external DNS.
- `read-only-proxy.test.ts` uses the real `jsforce` 3.x `Connection` with its
  transport replaced by a recorder: writes (Apex, SObject, Metadata, raw
  `request`, back-references) fail without reaching the transport, and every
  read the extractors use still does. `live-ingest-real-connection.test.ts`
  runs a full `liveIngest` through the same guarded connection.
- `sanitizer.test.ts` runs 50+ adversarial inputs.
