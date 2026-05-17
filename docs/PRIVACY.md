# Privacy

sfgraph is local-only and read-only by design.

## Three pillars

1. **No codebase egress.** Source content never leaves your machine. The graph
   and vector store are SQLite files under the platform's user-data directory
   (`~/Library/Application Support/sfgraph/` on macOS, `~/.local/share/sfgraph/`
   on Linux, `%APPDATA%\sfgraph\` on Windows — see
   [`DATA_LOCATIONS.md`](DATA_LOCATIONS.md)). The MCP server listens on stdio
   only.
2. **Read-only Salesforce access.** Every `jsforce`/`@salesforce/core` call is
   wrapped in a `ReadOnlyProxy` that throws on any mutating method
   (`create`, `update`, `delete`, `upsert`, `destroy`, `*sobject().create`,
   etc.). The proxy is verified by a unit test that enumerates every method
   on a connection mock.
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
- `read-only-proxy.test.ts` asserts every mutating method on a mock
  Connection throws.
- `sanitizer.test.ts` runs 50+ adversarial inputs.
