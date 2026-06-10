---
phase: 1.5-wedge-isolation
type: hardening
wave: 1.5
depends_on: []
requirements: [W1.5-01, W1.5-02, W1.5-03, W1.5-04, W1.5-05, W1.5-06, W1.5-07, W1.5-08]
files_modified:
  - packages/core/src/extractors/live-org/bulk-retrieve.ts
  - packages/core/src/extractors/live-org/rate-limit.ts
  - packages/core/src/extractors/live-org/extractors/lwc.ts
  - packages/core/src/ingest/live-ingest.ts
  - packages/core/src/graph/store.ts
  - packages/server/src/
  - packages/cli/src/commands/diagnose.ts
  - packages/cli/src/index.ts
  - README.md
  - docs/COVERAGE.md
autonomous: true
created: 2026-05-18
revised: 2026-05-18
---

# Phase 1.5 — Wedge Isolation + Watchdog Correctness + Promise Reconciliation

## Phase Header

**Title:** Wedge isolation + watchdog correctness + promise reconciliation
**Inserted between:** Phase 1 (Foundation) and Phase 2 (Reliability and coverage)
**Depends on:** Nothing. Phase 1.5 ships against the **current** `LiveIngestResult.warnings: string[]` surface using namespaced, colon-delimited strings (e.g. `wedge:lwc:firstYield:90s`). These strings are forward-compatible by design: when Phase 1's W1-01 later refactors warnings to `{stage, code, message, count, attributes}[]`, the namespaced strings parse back into structured form via a documented schema. Phase 1.5 and Phase 1 can land in either order, or in parallel.
**Blocks:** Nothing strictly, but Phase 2's MCD baseline (W2-03) and Tooling SOQL hardening (W2-05) become real-org testable only after this phase ships — otherwise the watchdog-cascade noise drowns out real signal.

## Goal

A real-org ingest never reports a metadata type as "skipped" because of a wedge in an unrelated source. The watchdog stops waiting on the wedge so queued neighbors get their slot, even if the wedge's underlying request continues running until the network layer reaps it. README accurately reflects what ships.

## Why this phase exists (concrete evidence)

A real ingest run against the **PLDT_DEV_Anshul** org (Vlocity-CMT) surfaced a cascade failure that the existing watchdog architecture cannot prevent:

- **The wedge:** One LWC bundle (`oSSTechnologiesTable`) stalled the `lwc` source for 440+ seconds at `packages/core/src/extractors/live-org/extractors/lwc.ts:91-98` — a serial per-bundle `LightningComponentResource` Tooling SOQL inside a `for`-loop at `lwc.ts:60`.
- **The cascade:** While that single bundle's pagination stalled, **37 unrelated metadata types** were marked `"skipped (source watchdog: first-yield 90s)"` by the watchdog at `packages/core/src/extractors/live-org/bulk-retrieve.ts:155`. Casualties included `security` (entire Profile / PermSet ingest), `vlocity`, `object`, `flow`, `lwc` itself, `layout`, `customMetadata`, `flowDefinition`, `approvalProcess`, `connectedApp`, `samlSsoConfig`, multiple GenAi types, `Network`, `experienceBundle`, and others.
- **The root cause:** `bulk-retrieve.ts:137` sets `startedAt = Date.now()` at source **registration**, not at slot acquisition. Sources queued behind a wedge in the sliding-window merger burn their 90-second "first-yield" budget while still waiting their turn. When the wedge finally clears, queued neighbors have already exceeded their clocks and are killed without ever executing.
- **The blast radius:** The graph audit at the end of the run showed **19,166 dangling edges out of 39,012 total** — the direct downstream cost of the missing types. Every dangling edge is a question the graph cannot answer.
- **The compounding catastrophe (added 2026-05-18, motivates W1.5-07):** Today's `--detect-deletions` sweep at `packages/core/src/ingest/live-ingest.ts:789-819` only skips when `streamAborted === true`. A wedged source releases its slot with `streamAborted === false`, `parseErrors === 0`, and an empty `touchedQnames` for its label. Result: the sweep wipes EVERY node of that label. The PLDT_DEV_Anshul run with `--detect-deletions=true` would have erased every Profile and PermissionSet from the graph — a graph extinction event from a benign wedge. W1.5-01/02 fix the cascade itself; W1.5-07 is the second-line defense that makes the deletion sweep refuse to act on empty streams.

The fix is correctness, not bigger numbers.

---

## Warning surface (current shape — string[]) and forward-compatibility

Phase 1.5 emits warnings on the **existing** `LiveIngestResult.warnings: string[]` surface (verified at `packages/core/src/ingest/live-ingest.ts:161`). To stay grep-able and forward-compatible with Phase 1's eventual W1-01 structured refactor, all new warnings use a **namespaced, colon-delimited schema**:

```
wedge:<sourceLabel>:<stage>:<detail>
```

Examples:
- `wedge:lwc:firstYield:90s:lastYielded=lwc/Bundle/oSSTechnologiesTable`
- `wedge:lwc:slotReleased:wedgedFor=440000ms`
- `wedge:lwc:resolvedLate:totalMs=612000`
- `wedge:security:firstYield:90s:lastYielded=<none>`
- `wedge:cap:backgroundWedgeAborted:source=lwc:ageMs=180000:reason=backgroundWedgeCapExceeded`
- `wedge:lwc:bundleFetchFailed:bundleId=01p...:error=<message>`
- `wedge:detect-deletions:refuse:label=Profile:reason=empty-stream:priorCount=147` (NEW in W1.5-07)
- `wedge:detect-deletions:refuse:label=PermissionSet:reason=drop-ratio:dropped=89:prior=120:ratio=0.74` (NEW in W1.5-07)

**Forward-compatibility contract.** When Phase 1's W1-01 lands and changes `warnings` to `{stage, code, message, count, attributes}[]`, these strings will be parsed back into structured form by the W1-01 migration:

| String segment | Structured field |
|----------------|------------------|
| literal `wedge:` prefix | `stage: 'live-org-ingest'` |
| `<sourceLabel>` (segment 2) | `attributes.wedgedSource` (or `attributes.source` for cap warnings) |
| `<stage>` (segment 3) | maps to `code`: `firstYield`/`inactivity` → `sourceWedged`; `slotReleased` → `wedgeSlotReleased`; `resolvedLate` → `wedgeResolvedLate`; `backgroundWedgeAborted` → `backgroundWedgeAborted`; `bundleFetchFailed` → `lwcBundleFetchFailed`; `refuse` → `detectDeletionsRefused` (W1.5-07) |
| `<detail>` (remaining `k=v` pairs) | merged into `attributes.*` |

This is documented in `packages/core/src/ingest/warning-schema.ts` as a comment block. Phase 1.5 owns the schema; Phase 1's W1-01 owns the migration parser.

---

## Requirements

### W1.5-01 — Watchdog clock starts at slot-acquired, not registration

**Description.** In `packages/core/src/extractors/live-org/bulk-retrieve.ts`, refactor `failSoft()` so the 90-second first-yield timer and 5-minute inactivity timer only start ticking when the source's async iterator actually begins executing inside the sliding-window merger (currently around `bulk-retrieve.ts:110-118`). Thread an "execution started" signal from `mergeAsyncIterablesParallel()` down to the watchdog timer. Concretely: move `startedAt = Date.now()` from `bulk-retrieve.ts:137` to the moment `factory()[Symbol.asyncIterator]()` is first called and the first `.next()` is awaited.

**Acceptance.**
- A unit test queues 10 source factories where factories 0..3 sleep 30s each before yielding and factories 4..9 yield instantly. With concurrency=4 and `firstYieldMs=10s`, only factories 0..3 are reported wedged. Factories 4..9 all execute and yield to completion. Before this change, factories 4..9 are killed by the watchdog while still queued; after, they are not.
- Existing tests for the slow-source-yields-eventually case still pass — the watchdog still fires when an *executing* source genuinely stalls.
- The bug is structurally removed: the existing `first-yield 90s` skip can no longer fire for a source that never executed. Verified by the queued-behind-wedge fixture above — the bug is impossible to reproduce post-fix.

**Files.**
- `packages/core/src/extractors/live-org/bulk-retrieve.ts` (`failSoft()` body ~ lines 110–160; in particular the `startedAt` assignment at line 137)
- `packages/core/src/extractors/live-org/__tests__/bulk-retrieve.watchdog.test.ts` (NEW — fixture for queued-behind-wedge case)

**Dependencies.** None. Independent of every other W1.5 item.

---

### W1.5-02 — Wedge isolation via slot release (soft-isolate model) with late-yield drain

**Description.** When a source exceeds `firstYieldMs` or `inactivityMs`, *release its slot semantically* so the sliding-window merger can advance to the next queued source. The wedged iterator is allowed to **continue running in the background**; only its slot in the concurrency window is freed.

**Late-yield drain policy.** After slot release, if the wedged iterator eventually yields records, **drain them into the output stream as long as the ingest pipeline is still open.** The merger keeps the wedged iterator's pending promise in a side map (`backgroundWedges: Map<sourceLabel, Promise<IteratorResult>>`) and continues to race it against incoming records from active slots. Late-arriving records:

- Are upserted normally (live-ingest's `processOne` is idempotent per the comment at `bulk-retrieve.ts:71-73`).
- Carry `attributes.lateYield: true` and `attributes.wedgeReleasedAt: <ISO>` so downstream analysis can audit them.
- Stop being drained when the overall ingest pipeline closes (the wedged iterator is then abandoned and its socket is left to network-layer timeout).

**Backlog cap.** Cap concurrent background wedges at 4 (default; env-configurable via `SFGRAPH_MAX_BACKGROUND_WEDGES`). When the cap is exceeded, the **oldest** background wedge is cancelled. Cancellation semantics depend on whether the wedge has acquired a real downstream slot:

- **Clean cancel (queue-cancel path):** If the wedged source's factory has not yet been invoked (it was a *queued* candidate for the background slot), simply never call the factory. No socket leak, no late records.
- **Stop-waiting cancel (in-flight path):** If the factory has been invoked and is awaiting a jsforce request, the merger stops awaiting that promise (the slot is released within 100ms). The underlying request continues until Salesforce / Node's socket idle timeout (~10min default) terminates it server-side. If it resolves before then, a `wedge:<sourceLabel>:resolvedLate:totalMs=<N>` warning is emitted; otherwise it is garbage-collected at process exit. See "Known limitation" below.

A `wedge:<sourceLabel>:firstYield:90s:lastYielded=<qualifiedName>` warning is emitted at slot release. A second `wedge:cap:backgroundWedgeAborted:source=<sourceLabel>:ageMs=<N>:reason=backgroundWedgeCapExceeded` warning is emitted when the cap eviction fires.

**Cap semantics.** `SFGRAPH_MAX_BACKGROUND_WEDGES` is the **number of active background wedges permitted simultaneously.** When the count would exceed the cap, the oldest is evicted *before* the new one is admitted. With `SFGRAPH_MAX_BACKGROUND_WEDGES=2` and three induced wedges, exactly one eviction warning fires (for the oldest of the three).

**Known limitation: stop-waiting is not socket-cancellation.** Verified at `node_modules/.pnpm/jsforce@3.10.15_@types+node@22.19.19/node_modules/jsforce/lib/request.js:55,128,180`: jsforce 3.10.15 constructs its `AbortController` internally and never exposes it to callers. `conn.tooling.query()` returns a `Promise`, not an abortable `Request`. **True in-flight socket abort is impossible without forking jsforce or monkey-patching.** Consequently, a wedged source on the in-flight cancel path may hold an underlying TCP socket and ~1–10MB of buffered memory until the network layer times out (~10 minutes default). This is accepted as a Phase 1.5 bound; a proper jsforce fork or upstream PR is filed as a future hardening item. The queue-cancel path remains clean.

**Acceptance.**
- The cascade scenario from the PLDT_DEV_Anshul run is reproducible as a fixture: one source wedges for 440s; with `concurrency=4` and 8 other sources queued, all 8 others execute to completion and yield records. Exactly one `wedge:<source>:firstYield:90s:...` warning is emitted at slot release, not 37.
- **Late-yield drain:** the wedged source's records, if they eventually arrive, are present in the output stream with `attributes.lateYield: true` and `attributes.wedgeReleasedAt` set. A test asserts that records yielded ≥ 100ms after slot release are still merged.
- Slot release happens within **100ms** of wedge detection (measured from watchdog fire to `pending.size` decrement).
- `SFGRAPH_MAX_BACKGROUND_WEDGES=2` with three induced wedges produces exactly one `wedge:cap:backgroundWedgeAborted:...` warning naming the oldest of the three.
- The 200-entry warnings cap (preserved verbatim from the current implementation) is respected; new wedge-namespaced strings count against it normally.

**Files.**
- `packages/core/src/extractors/live-org/bulk-retrieve.ts` (sliding-window merger / `mergeAsyncIterablesParallel`, `failSoft`, new `backgroundWedges` side map)
- `packages/core/src/extractors/live-org/__tests__/bulk-retrieve.wedge-isolation.test.ts` (NEW)
- `packages/core/src/ingest/warning-schema.ts` (NEW — namespaced-string schema documentation comment block)

**Dependencies.** W1.5-01 (watchdog clock must be correct first, otherwise slot-release just re-creates the original bug at a different layer). Does NOT depend on W1.5-03 — the cap eviction uses stop-waiting semantics described above, not a real AbortController.

---

### W1.5-03 — Stop-waiting iterator close with socket-leak acknowledgement

**Description.** Implement the "stop-waiting" primitive used by W1.5-02's slot release. This is **not** a real in-flight HTTP abort — verified impossible against jsforce 3.10.15 at `node_modules/.pnpm/jsforce@3.10.15_@types+node@22.19.19/node_modules/jsforce/lib/request.js:55,128,180` (jsforce creates its `AbortController` internally and never exposes it; `conn.tooling.query()` returns a `Promise`, not an abortable `Request`). Instead, this requirement ships:

1. **Local stop-waiting signal** in `packages/core/src/extractors/live-org/bulk-retrieve.ts`. The merger holds an internal "abandon" signal per source. When `signal.abort()` is called, the merger's outstanding `Promise.race([it.next(), signalRace])` settles via the local-resolve `signalRace` arm and the merger immediately decrements `pending.size`. The underlying jsforce request continues running until network-layer timeout.

2. **Queue-cancel path** in `packages/core/src/extractors/live-org/rate-limit.ts`. The `scheduleQuery()` wrapper (~line 314) accepts an optional `signal: AbortSignal`. Before invoking the wrapped function inside Bottleneck, the wrapper checks `signal.aborted`; if true, it rejects with `AbortError` and the Bottleneck job's callback is never invoked. This is the **clean** cancel path: zero leak, zero side effects.

3. **AbortError surface.** `soqlWithTimeout()` (lines 15–28) and `withTimeout()` (lines 39–47) accept an optional `signal` and reject with `AbortError` (distinct from `TimeoutError`) when the signal aborts before the underlying promise resolves. The underlying jsforce request is **NOT** aborted; it leaks until network-layer reap.

**Known limitation (must appear in code comments and in docs/COVERAGE.md):** A wedged jsforce request on the in-flight path holds an HTTP socket and buffered response memory (~1–10MB depending on response size) until Salesforce / Node closes the connection (default ~10min). This is acceptable as a Phase 1.5 bound: the merger has released the slot, queued neighbors are running, and the user-visible cascade is closed. A future hardening item ("jsforce abort upstream PR or fork") is filed in `.planning/STATE.md` under "Known limitations / future work."

**Acceptance.**
- Unit test: `scheduleQuery(connection, soql, { signal })` where `signal.abort()` is called before the Bottleneck reservoir would release the job → promise rejects with `AbortError` within 50ms; the underlying jsforce call was never made (verified via spy on `connection.query` — call count is zero). This is the clean queue-cancel path.
- Unit test: in-flight `soqlWithTimeout(connection, soql, { signal })` where the connection is mocked to hang indefinitely; calling `signal.abort()` causes the promise to reject with `AbortError` within 100ms. The underlying mock connection's request is **NOT** asserted to be cancelled — this is the documented stop-waiting limitation. The test instead asserts the mock connection's request handler is still pending after rejection (i.e., the leak is real and visible).
- Unit test: the merger releases the slot for a wedged source within 100ms of wedge detection (measured via fake timers). The wedged iterator's eventual Promise resolution (success or failure) is observed; if it resolves before the test's 1s budget expires, a `wedge:<source>:resolvedLate:totalMs=<N>` warning is verified.
- No regression: existing calls to `scheduleQuery` / `soqlWithTimeout` / `withTimeout` without a `signal` parameter behave identically to today.

**Files.**
- `packages/core/src/extractors/live-org/rate-limit.ts` (`scheduleQuery` ~314 — queue-cancel path; `soqlWithTimeout` 15–28 and `withTimeout` 39–47 — AbortError surface)
- `packages/core/src/extractors/live-org/bulk-retrieve.ts` (local stop-waiting signal in merger)
- `packages/core/src/extractors/live-org/__tests__/rate-limit.abort.test.ts` (NEW)

**Dependencies.** None inside Phase 1.5. W1.5-02 consumes the queue-cancel path for its cap eviction (clean path) and the local stop-waiting signal for in-flight evictions (leak path). Can land before or alongside W1.5-02.

---

### W1.5-04 — Parallelize per-bundle LWC resource fetches

**Description.** Replace the serial `for`-loop at `packages/core/src/extractors/live-org/extractors/lwc.ts:60` with a sliding window of **8 concurrent per-bundle resource fetches**, mirroring the Vlocity runner pattern at `packages/core/src/extractors/live-org/extractors/vlocity/runner.ts:285` (which uses `WINDOW=4`). Pick `WINDOW=8` for LWC because the Tooling API connection pool is 5 concurrent and we want to keep that pool saturated with bundles in flight while leaving slack for retries.

The existing managed-namespace fast-path at `lwc.ts:65-84` (which yields without a resource fetch) does **not** consume a window slot — managed bundles yield synchronously from the iterator body and bypass the window scheduler entirely.

Yield each bundle's parsed record **as soon as it completes** — do NOT wait for the whole batch to drain before yielding. This keeps `lastYieldedAt` heartbeat fresh and prevents false-positive wedge detection from the watchdog (W1.5-01/02).

Keep the per-bundle `try`/`catch` (`lwc.ts:91-98`); failure of one bundle does not affect others. A failed bundle yields no record but a `wedge:lwc:bundleFetchFailed:bundleId=<id>:bundleName=<name>:error=<msg>` warning is emitted (namespaced-string format per the schema above).

**Acceptance.**
- Unit test against a mock connection serving 50 bundles: with `WINDOW=8`, total wall-clock to drain the iterator is ≤ ⌈50/8⌉ × (per-bundle latency) + overhead. Compare to the serial baseline (≥ 50 × per-bundle latency).
- Records are yielded individually as they complete (not batched at the end) — verified by asserting that `yieldedAt[i] < yieldedAt[i+8]` holds, i.e., the first record arrives before the 9th request is even issued.
- A bundle that throws mid-fetch produces exactly one `wedge:lwc:bundleFetchFailed:...` warning and does not interrupt the other 49 bundles.
- Real-org smoke against PLDT_DEV_Anshul (231 bundles, including `oSSTechnologiesTable`): `lwc` source completes within 120s wall-clock; the `oSSTechnologiesTable` wedge no longer prevents other bundles from yielding.
- Apex source wall-clock against PLDT_DEV_Anshul does not regress materially (>20% slower) after W1.5-04 lands — Apex shares the 5-slot Tooling pool with LWC, and LWC saturating 5 slots for 231 bundles must not starve Apex.

**Files.**
- `packages/core/src/extractors/live-org/extractors/lwc.ts` (loop at line 60, per-bundle SOQL at lines 91–98, managed fast-path at 65–84 must remain non-windowed)
- `packages/core/src/extractors/live-org/extractors/__tests__/lwc.parallel.test.ts` (NEW)

**Dependencies.** Independent of W1.5-01/02/03 in terms of code — but the verification story for W1.5-04 relies on W1.5-01/02 being shipped, because without them a single wedged bundle still cascades. Can be authored in parallel; lands after the watchdog work for clean real-org verification.

---

### W1.5-05 — `sfgraph diagnose <orgId>` CLI subcommand

**Description.** New CLI command that runs in a special "diagnose mode":

- Pool concurrency forced to **1** (override `SFGRAPH_TOOLING_POOL=1`, `SFGRAPH_METADATA_POOL=1`, `SFGRAPH_SOURCE_CONCURRENCY=1`).
- Verbose per-call timing dumped to stdout (every Tooling/Metadata API call timed and labeled).
- Single retry on wedge (no automatic retry-bisection — we want to *see* the wedge, not recover from it).

**Timing-profile caveat.** Because pool concurrency is forced to 1, diagnose-mode wall-clock is NOT directly comparable to a real production ingest run. Diagnose is for **naming wedges** (which source, which bundle/record, which SOQL), not for predicting production throughput. This caveat is printed at the top of the report and in `--help`.

Output a JSON report at:

```
~/Library/Application Support/sfgraph/diagnostics/<orgId>-<ISO-timestamp>.json
```

The report contains:

```ts
{
  orgId: string,
  startedAt: string,
  finishedAt: string,
  diagnosticMode: true,                  // explicit flag; timing is not comparable to prod
  perSource: Array<{
    name: string,
    elapsedMs: number,
    yieldCount: number,
    error?: { code: string, message: string },
    wedged: boolean,
    lastYieldedRecord?: string,
    needsDiagnose?: boolean,             // W1.5-07: surfaced when a label was refused by deletion guard
  }>,
  wedgeTimeline: Array<{ atMs: number, source: string, event: 'slotAcquired' | 'firstYield' | 'wedged' | 'slotReleased' | 'completed' }>,
  capabilityProbes: {
    toolingApi: boolean,
    metadataApi: boolean,
    modifyMetadata: boolean,
    modifyAllData: boolean,
    bulkApi: boolean,
  },
  toolingCalls: Array<{ soql: string, elapsedMs: number, recordCount: number, error?: string }>,
  slowCalls: Array<{ /* same shape, only entries with elapsedMs > 10_000 */ }>,
  detectDeletionsRefusals?: Array<{      // W1.5-07: emitted when guard refuses sweep
    label: string,
    reason: 'empty-stream' | 'drop-ratio',
    priorCount: number,
    touchedCount: number,
    ratio?: number,
  }>,
}
```

Detect specifically:

- Which Tooling/Metadata calls exceed **10s** (surfaced in `slowCalls[]`).
- Which iterators yield **zero records** (`yieldCount === 0`, `error: undefined`).
- Which sources hit the watchdog and what their `lastYieldedRecord` was at kill time.
- Which labels were refused by the deletion-sweep guard (W1.5-07) — surfaced in `detectDeletionsRefusals[]` and as `needsDiagnose: true` per-source entries.

Wire into the main `sfgraph` CLI entry. Document in README under a new "Diagnostics" section.

**Acceptance.**
- `sfgraph diagnose <orgId>` against a healthy scratch org produces a report with no `wedged: true` entries and `slowCalls[]` empty (or near-empty).
- The same command against PLDT_DEV_Anshul produces a report that names `lwc` (or whichever source still wedges post-W1.5-04) with `wedged: true` and `lastYieldedRecord: "lwc/Bundle/oSSTechnologiesTable"` (or similar).
- The report path is printed to stdout on completion; the file is valid JSON parseable by `node -e "JSON.parse(...)"`.
- `--help` lists `diagnose` alongside `ingest`, `query`, etc., and includes the "diagnostic-mode timing is not comparable to production" note.
- When run after a `--detect-deletions` ingest that triggered W1.5-07 refusals, the report includes a populated `detectDeletionsRefusals[]` array and the corresponding `perSource[]` entries carry `needsDiagnose: true`.

**Files.**
- `packages/cli/src/commands/diagnose.ts` (NEW)
- `packages/cli/src/index.ts` (wire the subcommand)
- `packages/core/src/extractors/live-org/diagnostics/` (NEW — report builder helpers, capability probes, slow-call collector)
- `packages/cli/src/__tests__/diagnose.test.ts` (NEW)

**Dependencies.** W1.5-01, W1.5-02, W1.5-03, W1.5-07 (the report consumes the wedge timeline + namespaced-string warnings + stop-waiting plumbing + deletion-guard refusal records emitted by those). Land last among the code changes.

---

### W1.5-06 — README + COVERAGE.md reconciliation

**Description.** Audit README claims against shipped reality. Required deltas:

1. **MCP tool count.** README currently claims "26 MCP tools". Verify the actual count by enumerating registered tools in `packages/mcp-server/src/tools/` (or equivalent registration site) and update README to the correct number. If the discrepancy is non-trivial (>2), call out the delta explicitly in the changelog entry.
2. **Security model gap disclosure.** README claims sfgraph helps engineers "reason about ... security". Disclose that `PermSetGroup`, `MutingPermissionSet`, `ProfileSessionSetting`, and `ProfilePasswordPolicy` are ingested as **opaque generic nodes WITHOUT `GRANTS_*` / `DENIES_*` edges**. Either fix (explicitly out of scope for 1.5) or document the gap honestly with a "Known limitations" subsection.
3. **Dynamic metadata discovery scope.** README claims "dynamic metadata discovery". Disclose that the `GENERIC_TYPE_WHITELIST` filters approximately 80 of the org's ~327 discovered types. Document the `SFGRAPH_INCLUDE_ALL_GENERIC=1` escape hatch and what it costs (longer ingest, more opaque nodes).
4. **Staleness signal (NEW — W1.5-08).** Document the `staleness: { generation: N, in_progress: bool, last_sync_at: ISO }` block returned on every MCP tool response. Reader-side guidance: "if `staleness.in_progress === true`, the graph is being rewritten; results may reflect partial state."
5. **Env var inventory.** Document every env var currently in use. The authoritative list is to be produced at execution time by running:

   ```bash
   grep -rn "process\.env\.SFGRAPH_" packages/core/src/ packages/cli/src/ packages/mcp-server/src/
   ```

   Current known set (≥13 vars — final count produced by grep at execution time):

   | Env var | Default | Effect | Source |
   |---------|---------|--------|--------|
   | `SFGRAPH_SOURCE_CONCURRENCY` (singular) | 12 | Concurrency of the sliding-window merger in `bulk-retrieve.ts:78` | `bulk-retrieve.ts:78` |
   | `SFGRAPH_SEQUENTIAL_SOURCES` | unset | Force serial source execution (debug aid) | `bulk-retrieve.ts:482` |
   | `SFGRAPH_BISECT_MAX_DEPTH` | 6 | Tooling SOQL adaptive bisection depth cap | `rate-limit.ts:76` |
   | `SFGRAPH_METADATA_READ_CHUNK_SIZE` | 10 | `metadata.read` composite batch size | `rate-limit.ts:94` |
   | `SFGRAPH_TOOLING_POOL` | 5 | Tooling API pool concurrency | `rate-limit.ts:256-258` |
   | `SFGRAPH_METADATA_POOL` | varies | Metadata API pool concurrency | `rate-limit.ts:256-258` |
   | `SFGRAPH_DATA_POOL` | varies | Data API pool concurrency | `rate-limit.ts:256-258` |
   | `SFGRAPH_INCLUDE_ALL_GENERIC` | 0 | Disable `GENERIC_TYPE_WHITELIST` filter | `bulk-retrieve.ts:335` |
   | `SFGRAPH_SKIP_LWC` | unset | Skip the LWC source entirely | `lwc.ts:39` |
   | `SFGRAPH_INCLUDE_MANAGED` / `SFGRAPH_INCLUDE_MANAGED_NAMESPACES` | unset | Include managed-namespace components in LWC ingest | `lwc.ts:58-59` |
   | `SFGRAPH_DEBUG_INGEST` | unset | Verbose ingest logging | multiple |
   | `SFGRAPH_NO_AUTO_RETRY` | unset | Disable automatic retry on watchdog wedge | grep to verify |
   | `SFGRAPH_MAX_BACKGROUND_WEDGES` (NEW in W1.5-02) | 4 | Cap on simultaneous background wedges | new |
   | `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO` (NEW in W1.5-07) | 0.30 | Per-label drop-ratio threshold above which `--detect-deletions` sweep refuses to act | new |

   Each README entry: name, default, effect, when to use. The final count must match what `grep` produces at execution time — do NOT lock a number in the plan.

Create `docs/COVERAGE.md` as a comprehensive matrix:

- **Columns:** `Metadata Type | Status | Edges emitted | Known limitations | First-class extractor file`
- **Status values:** `Full` (named extractor, all known edges), `Partial` (named extractor, gaps documented), `Generic-Only` (opaque node via whitelist, no relational edges), `Unsupported` (filtered out).
- **Rows:** every type in `GENERIC_TYPE_WHITELIST` plus the named extractors (Apex, LWC, Aura, Vlocity, OmniStudio, Flow, Security, Object).

Link `docs/COVERAGE.md` from the README's "Coverage" section (create the section if missing).

Document the **jsforce stop-waiting limitation** from W1.5-03 in `docs/COVERAGE.md` under "Known limitations / future work" — including the up-to-10-minute socket leak window and the planned upstream PR. Document the **deletion-sweep guard refusal behavior** from W1.5-07 (no data is deleted; staleness clock still ticks; refusal recorded in diagnostics). Document the **MCP staleness block** from W1.5-08.

**Acceptance.**
- A reviewer reading the README can answer correctly: how many MCP tools ship, what env vars exist (full grep-produced list), what security model gaps remain, what dynamic metadata discovery actually does, what the staleness signal means.
- `docs/COVERAGE.md` exists and lists every type the ingest pipeline knows about, with no rows marked TBD.
- The README's MCP tool count, when grep'd, matches the count produced by `node -e "require('./packages/mcp-server/dist/tools').list().length"` (or the equivalent).
- README env var section reconciles 1:1 with the grep output at PR-merge time.

**Files.**
- `README.md`
- `docs/COVERAGE.md` (NEW)
- `packages/core/src/extractors/live-org/generic.ts` (read-only reference for `GENERIC_TYPE_WHITELIST`)

**Dependencies.** W1.5-01 through W1.5-05, plus W1.5-07 and W1.5-08 (COVERAGE.md must reflect what actually shipped, including the new env vars `SFGRAPH_MAX_BACKGROUND_WEDGES` / `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO`, the `sfgraph diagnose` subcommand, the jsforce stop-waiting known-limitation entry, the deletion-guard refusal behavior, and the MCP staleness block). Lands last.

---

### W1.5-07 — Per-label drop-ratio guard on `--detect-deletions` sweep

**Description.** Add a second-line defense at `packages/core/src/ingest/live-ingest.ts:789-819` (the `if (opts.detectDeletions && mode === "full")` block) that refuses to delete an entire label's worth of nodes when the in-memory `touchedQnames` set is suspiciously sparse relative to the prior on-disk population.

**Motivation.** Today's deletion sweep only skips when `streamAborted === true` (i.e. when the extractor threw). A source that completes with **zero records** (which is exactly what the wedge cascade produces — neighbor sources are killed before ever yielding) sets `streamAborted === false`, `parseErrors === 0`, and `touchedQnames` for that label is empty. Result: the sweep wipes every node of that label. In the PLDT_DEV_Anshul run, ONE wedge in `lwc` → `security` source killed at 90s false-positive → `--detect-deletions=true` → **every Profile and PermissionSet wiped from the graph**. A graph extinction event from a benign wedge. W1.5-01/02 fix the cascade itself; W1.5-07 is the second-line defense that ensures the deletion sweep cannot act on an empty stream.

**Behavior.**

- Before deleting any qname of label `L`, compute:
  - `priorCount = graph.countNodesByLabel(L)` (new helper on the graph store)
  - `touchedCount = touchedQnames.filter(label === L).size`
- **Empty-stream refusal:** If `priorCount > 0 && touchedCount === 0` → REFUSE the deletion for label `L`. Emit `wedge:detect-deletions:refuse:label=<L>:reason=empty-stream:priorCount=<N>` into `result.warnings`.
- **Drop-ratio refusal:** If `priorCount > 0 && (priorCount - touchedCount) / priorCount > maxDropRatio` (default `0.30`, configurable via env `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO`) → REFUSE. Emit `wedge:detect-deletions:refuse:label=<L>:reason=drop-ratio:dropped=<X>:prior=<Y>:ratio=<Z>` warning.
- **Refusal effects:** When REFUSED, the label's nodes are left in the graph with their previous `last_seen_at` timestamp (i.e. the staleness clock keeps ticking — staleness reports will still surface them, which is the right behavior).
- **Diagnose tagging:** Refusal also tags the source/label with a `needs_diagnose: true` marker that the next `sfgraph diagnose <orgId>` run (W1.5-05) will report.

**Cross-reference.** This guard is the second line of defense complementing W1.5-02 (soft-isolate wedge). Wedged sources release their slot with `touchedCount === 0` → automatically caught by W1.5-07. The two fixes together ensure no wedge ever causes data loss.

**Acceptance.**

- Real-org repro: run `sfgraph ingest --detect-deletions --rebuild` against PLDT_DEV_Anshul on a deliberately-induced wedge condition (e.g. set `SFGRAPH_SKIP_LWC=1` to simulate an empty `lwc` stream). Verify no Profile/PermissionSet/etc. is deleted; verify `wedge:detect-deletions:refuse:*` warnings appear in the run summary naming the protected labels.
- Unit test: inject an extractor yielding zero records for label `Profile` against a graph pre-seeded with 100 Profile nodes; assert no nodes deleted; assert `wedge:detect-deletions:refuse:label=Profile:reason=empty-stream:priorCount=100` warning emitted.
- Unit test: inject an extractor yielding 60 of 100 prior `PermissionSet` qnames (40% drop); assert no nodes deleted; assert `wedge:detect-deletions:refuse:label=PermissionSet:reason=drop-ratio:dropped=40:prior=100:ratio=0.40` warning emitted.
- Env-var override test: set `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO=1.0`; verify guard is effectively disabled and old behavior returns (for users who explicitly accept the risk).

**Files.**

- `packages/core/src/ingest/live-ingest.ts` (lines 789–819 sweep block + new `countNodesByLabel` call site)
- `packages/core/src/graph/store.ts` (or equivalent — add `countNodesByLabel(label: string): number` helper if not already present)
- `packages/core/test/ingest/live-ingest.detect-deletions-guard.test.ts` (NEW)

**Dependencies.** None. Independent of W1.5-01/02/03/04. Can land as its own PR in parallel with the keystone. Diagnose CLI (W1.5-05) consumes the refusal records, so W1.5-05's report shape depends on W1.5-07.

---

### W1.5-08 — Sync-generation column for MCP reader staleness signal

**Description.** Add a per-org `sync_generation` counter (and `sync_in_progress` flag) to the existing `_sfgraph_orgs` table, increment it at ingest start/end, and surface it on every MCP tool response so concurrent readers can detect "the graph is being rewritten" without requiring a global ingest transaction or snapshot isolation.

**Motivation.** Concurrent MCP readers can today observe partial-state graphs mid-ingest (no global transaction by design — per-resolver try/catch isolation is documented at `live-ingest.ts:821-823`). As the MCP ecosystem grows (agents firing tools mid-ingest), concurrent-read inconsistency becomes more likely to bite. Per-connection WAL snapshots already give technical isolation; this fix is purely about **communicating** "the sync isn't done yet" to readers so they can react sensibly (warn the user, retry, etc.).

**Behavior.**

- Add `sync_generation INTEGER NOT NULL DEFAULT 0` column to the `_sfgraph_orgs` table. Migration: write an `ALTER TABLE` that defaults existing rows to 0.
- Add a `sync_in_progress` signal. Two acceptable encodings (pick one in implementation; both are equivalent semantically):
  - Separate `sync_in_progress BOOLEAN NOT NULL DEFAULT 0` column, OR
  - Sentinel via parity: increment `sync_generation` to **odd** at ingest START, to **even** at ingest END (callers detect "in progress" via `sync_generation % 2 === 1`).
- Wire the increment into the existing `graph.touchSync()` call in `packages/core/src/graph/store.ts`. Increment must flip the in-progress flag correctly even when ingest throws (try/finally).
- MCP server reads both at query time and surfaces them as `staleness: { generation: N, in_progress: bool, last_sync_at: ISO }` on every tool response.
- Reader-side guidance documented in README (W1.5-06 picks this up): "if `staleness.in_progress === true`, the graph is being rewritten; results may reflect partial state."

**Why now.** Cheap. Small. Complementary to W1.5-07. Reduces a real but currently silent failure mode for downstream agents.

**Out of scope.** Cross-process locking, atomic-swap of the DB file, snapshot-based reads. Those are larger and deferred.

**Acceptance.**

- Two concurrent processes: process A starts an ingest; process B fires an MCP tool mid-ingest. B's response includes `staleness.in_progress: true` and a `staleness.generation` value matching what A is in the middle of writing.
- After A completes, a third tool call from B returns `staleness.in_progress: false` and `staleness.generation` incremented by 1.
- Unit test: assert `sync_generation` increments by exactly 1 per successful ingest.
- Unit test: assert the in-progress flag flips correctly even when ingest throws (try/finally semantics verified by deliberately throwing inside the ingest body and asserting the post-throw row state).
- Documentation: README section explaining the staleness block and the reader-side contract.

**Files.**

- `packages/core/src/graph/store.ts` (column add + migration + `touchSync` increment)
- `packages/server/src/` (MCP response surface — find where tool responses are serialized and add the `staleness` block; grep for tool-response builder)
- Migration file in the codebase's existing migration system (locate via `grep -rn "ALTER TABLE" packages/core/src/`)
- `packages/core/test/graph/sync-generation.test.ts` (NEW)
- `README.md` — document the staleness field (handled in W1.5-06)

**Dependencies.** None. Independent of W1.5-01/02/03/04/07. Can parallelize with anything. README documentation handled inside W1.5-06.

---

## Build Order

1. **W1.5-01 + W1.5-02 (paired) — keystone.** Watchdog clock correction and slot-release are the keystone of this phase. Without them, no other fix helps because the cascade still happens. Ship together as one PR.
2. **W1.5-03 — Stop-waiting iterator close.** Required for W1.5-02's cap-eviction path (clean queue-cancel + in-flight stop-waiting). Can land before W1.5-02 as inert infrastructure, or alongside.
3. **W1.5-04 — LWC parallelization.** Independent; can be authored in parallel with the watchdog work. Lands after W1.5-01/02 for clean real-org verification (otherwise a single wedged bundle still cascades and obscures the win).
4. **W1.5-07 — Deletion-sweep safety guard.** Small, independent, can parallelize with W1.5-01/02 (touches different files: `live-ingest.ts:789-819` + `graph/store.ts`, not `bulk-retrieve.ts`). Lands as its own PR. **High priority** — closes a catastrophic-but-latent bug (graph extinction on `--detect-deletions` + benign wedge).
5. **W1.5-08 — Sync generation counter.** Small, independent, can parallelize with anything. Schema migration (additive column) + `touchSync()` increment + MCP response surface update.
6. **W1.5-05 — `sfgraph diagnose` CLI.** Uses W1.5-01/02/03 plumbing (wedge timeline, namespaced-string warnings, stop-waiting signals) plus W1.5-07's refusal records. Lands after the runtime fixes.
7. **W1.5-06 — README + COVERAGE.md.** Last; depends on knowing what actually shipped, including the new env vars (`SFGRAPH_MAX_BACKGROUND_WEDGES`, `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO`), the new CLI subcommand (`sfgraph diagnose`), the jsforce stop-waiting documented limitation, the deletion-guard refusal behavior, and the MCP staleness block.

## Anti-features That Must Ship From Day 1

- **No raising of timeout literals.** The fix is correctness, not bigger numbers. Per-call timeouts (60s SOQL, 120s `metadata.read`) remain unchanged unless investigation in W1.5-04 proves a specific path needs more. If you find yourself wanting to bump a timeout, stop and re-read W1.5-01.
- **One legitimate >90s case to acknowledge.** Real-org `metadata.list` for `CustomObject` on a 10k+ object org can legitimately take 60–120s to first-yield. Post-W1.5-01, the 90s first-yield deadline still applies once the source acquires its slot. If a specific named source consistently first-yields between 90s and 180s on healthy real orgs, raise *that source's* per-source budget via a per-source watchdog override (the watchdog API should accept it), not the global literal.
- **Soft-isolate, never hard-cancel by default.** Stopping waiting on a wedged HTTP request is the W1.5-03 fallback when the background-wedge cap (`SFGRAPH_MAX_BACKGROUND_WEDGES`, default 4) is exceeded — not the primary behavior. Default behavior is "release the slot, let the wedge finish in background, drain late records, emit `wedge:<source>:firstYield:...` warning."
- **No Bulk API migration.** That is explicitly out of scope and may be a future phase. The diagnosis showed the wedge was correctness-of-watchdog plus serial-per-bundle SOQL, not API paradigm choice.
- **No `SECURITY_PER_LABEL_CAP` removal.** Out of scope; documented in `docs/COVERAGE.md` as a known limitation instead.
- **No new YAML rule files for PermSetGroup / Muting / ProfileSessionSetting / ProfilePasswordPolicy.** Documented as a gap in `docs/COVERAGE.md`, deferred.
- **No re-architecting of the source registration model.** The fix is moving `startedAt` to slot-acquired and adding semantic slot release — not redesigning how sources are registered or how the sliding-window merger is structured.
- **No real in-flight HTTP cancellation.** Verified impossible against jsforce 3.10.15. Stop-waiting + documented socket leak is the accepted bound. Upstream PR / fork is a future hardening item.
- **No global ingest transaction.** W1.5-08 communicates staleness; it does NOT introduce a single transaction wrapping the whole ingest. The existing per-resolver try/catch isolation (documented at `live-ingest.ts:821-823`) is preserved.
- **No `--detect-deletions` default flip.** The guard in W1.5-07 makes the flag SAFER but does not promote it to default-on. That's a separate decision pending more confidence in real-org behavior.
- **No parallel parsing (#1 from the independent analysis).** Explicit deferral — requires profiling proof first. See "Deferred / Backlog" backlog item 2 below.
- **No buffered writes (#2 from the independent analysis).** Explicit deferral — requires profiling proof first. See "Deferred / Backlog" backlog item 1 below.

## Success Criteria

1. Engineer running `sfgraph ingest --rebuild` against a Vlocity-CMT org sees **zero** `source watchdog (first-yield 90s)` skips for sources that never actually executed. Every skip in the report is attributable to a real wedge in **that** source (verified by `lastYielded=<own-source-label>` in the namespaced warning string).
2. Engineer reading the run summary sees namespaced warnings naming the specific wedged source(s) — `wedge:<sourceLabel>:firstYield:90s:lastYielded=<qualifiedName>` — rather than a fan-out of unrelated victim skips.
3. Engineer running `sfgraph diagnose <orgId>` gets a JSON report at `~/Library/Application Support/sfgraph/diagnostics/<orgId>-<timestamp>.json` with per-source timing, slow-call list, capability probes, and the `diagnosticMode: true` flag. The report identifies any sub-30s wedge candidates.
4. Engineer reading README sees: accurate MCP tool count, honest disclosure of security model gaps, documented env var inventory matching the grep output at PR-merge time (≥13 vars including new `SFGRAPH_MAX_BACKGROUND_WEDGES` and `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO`).
5. Engineer reading `docs/COVERAGE.md` sees every ingested metadata type with status (`Full` / `Partial` / `Generic-Only` / `Unsupported`) and known limitations — including the jsforce stop-waiting socket-leak window, the deletion-guard refusal behavior, and the MCP staleness block — no surprises in the graph.
6. A second-pass real-org ingest log captured in `.planning/phase-1.5/EVIDENCE.md` shows the AFTER skip count is **≤ 10% of the BEFORE skip count** on the same org / run conditions as the original diagnostic run on PLDT_DEV_Anshul (see EVIDENCE.md schema below).
7. Engineer running `sfgraph ingest --detect-deletions --rebuild` against any org sees zero label-level deletions on a wedge-induced empty-stream condition; instead sees `wedge:detect-deletions:refuse:label=*` warnings naming the protected labels.
8. MCP client polling any tool response sees `staleness: { generation: N, in_progress: bool, last_sync_at: ISO }` block. During an active ingest, `in_progress: true` and clients can warn the user "graph is being rewritten."

## EVIDENCE.md Measurement Schema (pinned)

The ≥90% skip-reduction success criterion is measured via the following protocol. EVIDENCE.md MUST contain all fields listed.

**Measurement source.** Both BEFORE and AFTER skip counts are parsed from the run summary line at `packages/core/src/ingest/live-ingest.ts:184-186`:

```
⚠ {N} metadata types were skipped during this ingest.
```

The count under the "Other" sub-bullet (un-categorized skips) is the primary metric.

**Extraction command.**

```bash
grep -E "metadata (type was|types were) skipped" run.log | head -1
```

**EVIDENCE.md template (required fields).**

```yaml
org:
  alias: PLDT_DEV_Anshul
  orgId: <18-char ID>
before:
  runTimestamp: <ISO-8601>
  logPath: .planning/phase-1.5/runs/before-<ISO>.log
  skipCount: 37          # baseline from PLAN.md:37
  skipSourceList:        # parsed from the "Other" sub-bullet
    - security
    - vlocity
    - object
    - ...
  envVars:
    SFGRAPH_SOURCE_CONCURRENCY: 12
    # ... full env at run time
  branchSha: <git SHA>
after:
  runTimestamp: <ISO-8601>
  logPath: .planning/phase-1.5/runs/after-<ISO>.log
  skipCount: <N>
  skipSourceList:        # each entry MUST have lastYielded matching its own source label
    - <source>: lastYielded=<qualifiedName in own source>
  envVars:
    SFGRAPH_SOURCE_CONCURRENCY: 12   # unchanged from BEFORE
    SFGRAPH_MAX_BACKGROUND_WEDGES: 4 # new in 1.5
    SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO: 0.30 # new in 1.5 (W1.5-07)
    # ... full env at run time
  branchSha: <git SHA after merge>
delta:
  absolute: <BEFORE - AFTER>
  percentage: <((BEFORE - AFTER) / BEFORE) * 100>
  organicallyChangedSources: []  # any source that genuinely became unhealthy between runs
driftGuards:
  orgMetadataDelta: <e.g. "no deploys in 24h" or "snapshot SHA matches">
  retryRequired: false  # set true if org state changed >5% and we re-ran on a stable snapshot
```

**Acceptance (pinned).**
- `delta.percentage >= 90` (i.e. AFTER ≤ 10% of BEFORE), AND
- Every entry in `after.skipSourceList` has `lastYielded` pointing into its own source label (no neighbor-wedge victims), AND
- `driftGuards.orgMetadataDelta` shows no significant change OR the run was repeated on a stable snapshot.

If org metadata changed by >5% between runs (deploys, package installs), the AFTER run is retried on a stable snapshot before EVIDENCE.md is finalized.

## Verification (real-org smoke test)

The phase is **NOT** complete until all of:

1. A full ingest run against PLDT_DEV_Anshul (or any Vlocity-CMT org) completes with zero "skipped due to neighbor wedge" entries — meaning the only skips remaining are sources that actually wedged themselves, not victims of someone else's wedge. Verified via the namespaced-string `lastYielded=<own-source>` check.
2. The same run shows the `lwc` source completing in under **120s** wall-clock against the same 231-bundle org (down from 440s+).
3. `sfgraph diagnose <orgId>` prints a complete per-source timing report and identifies any sources still taking >30s. The report file is created at the documented path with `diagnosticMode: true`.
4. README + `docs/COVERAGE.md` changes have been reviewed by the user.
5. EVIDENCE.md committed to `.planning/phase-1.5/EVIDENCE.md` with all required-schema fields populated and the ≥90% reduction asserted.
6. The graph audit at the end of the post-1.5 run shows dangling-edge count drop materially (target: ≥50% reduction from the 19,166 baseline on the same org snapshot). This is downstream of (1)–(3) — included as a sanity check, not a separate gate.
7. **Real-org repro for W1.5-07:** deliberately induce a wedge OR set `SFGRAPH_SKIP_LWC=1` to simulate an empty `lwc` stream, run with `--detect-deletions --rebuild`, verify no nodes deleted and `wedge:detect-deletions:refuse:*` warnings appear in the run summary.
8. **Real-org repro for W1.5-08:** start an ingest in process A; while it runs, fire an MCP tool from process B; verify the response includes `staleness.in_progress: true` with a `staleness.generation` matching what A is writing. After A completes, a follow-up tool call from B shows `staleness.in_progress: false` and `staleness.generation` incremented by 1.

## Phase 1 interaction (no dependency, forward-compatible)

Phase 1.5 has **no dependency** on Phase 1. The two phases can land in either order or in parallel.

- **Current surface.** Phase 1.5 emits namespaced colon-delimited strings on the existing `LiveIngestResult.warnings: string[]` field at `packages/core/src/ingest/live-ingest.ts:161`. These strings follow the schema documented above in "Warning surface."
- **Future migration.** When Phase 1's W1-01 lands and refactors `warnings` to `{stage, code, message, count, attributes}[]`, W1-01 owns a migration parser that consumes Phase 1.5's namespaced strings and emits them as structured records using the field mapping documented above. The mapping is intentionally bijective (no information loss in either direction).
- **W1-02 edge provenance.** Not required by Phase 1.5 code, but the `sfgraph diagnose` report's `lastYieldedRecord` references qualifiedNames whose downstream edges will eventually carry W1-02 `sourceUri/line/column` once Phase 1 ships. Used in `EVIDENCE.md` to cross-reference dangling-edge reductions when both phases are merged.

## Decisions Log (to be appended to STATE.md when this plan is finalized)

- **Stop-waiting (not in-flight abort) as the wedge close primitive.** jsforce 3.10.15 does not expose its internal `AbortController` to callers (verified at `node_modules/.pnpm/jsforce@3.10.15.../jsforce/lib/request.js:55,128,180`). True in-flight socket cancellation is impossible without forking jsforce. Phase 1.5 ships stop-waiting semantics: the merger releases the slot within 100ms of wedge detection; the underlying jsforce request continues until network-layer timeout (~10min). Accepted as a Phase 1.5 bound; upstream PR / fork is a future hardening item.
- **Namespaced-string warnings (not structured) on the current `string[]` surface.** Phase 1.5 emits colon-delimited namespaced strings (`wedge:<source>:<stage>:<detail>`) on the existing `LiveIngestResult.warnings: string[]` field. This makes Phase 1.5 dependency-free on Phase 1 / W1-01. The strings are forward-compatible: when W1-01 ships, its migration parser converts them to the structured `{stage, code, message, count, attributes}` shape via a documented bijective mapping.
- **Soft-isolate with late-yield drain as default.** When a source wedges, the default behavior is to release the slot and let the iterator continue running in the background. Records yielded after slot release are still merged into the output stream (tagged `attributes.lateYield: true`, `attributes.wedgeReleasedAt: <ISO>`) until the ingest pipeline closes. Stop-waiting cancel via the in-flight path is reserved for the case where the background-wedge cap (`SFGRAPH_MAX_BACKGROUND_WEDGES`, default 4) is exceeded — at which point the oldest is evicted. Rationale: the cascade fix doesn't require hard cancellation, and late-drain prevents silent data loss.
- **LWC window=8 (vs. Vlocity window=4).** Picked to saturate the 5-concurrent Tooling pool with bundles in flight while leaving slack for retries. Vlocity runner uses 4 because its per-call cost profile differs (each Vlocity bundle is heavier than an LWC `LightningComponentResource` query). Managed-namespace LWC fast-path bypasses the window scheduler.
- **Diagnostics report path under `~/Library/Application Support/sfgraph/`.** Matches existing sfgraph user-data conventions on macOS; no new platform-path code needed. Linux/Windows variants follow the same `app-data-dir` resolver used elsewhere in the CLI. Diagnose mode is for naming wedges, not predicting production wall-clock.
- **W1.5-07 — deletion-sweep guard refuses, doesn't merge.** Refused-label nodes keep their `last_seen_at` so staleness reports still surface them. Default drop-ratio 0.30 chosen as conservative; tuning data needed before adjusting. Env-var override (`SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO=1.0`) preserves old behavior for users who explicitly accept the risk.
- **W1.5-08 — staleness signaled via INTEGER counter, not snapshot isolation.** Per-connection WAL snapshots already give technical isolation; this is purely about communicating "sync not done yet" to readers. No global ingest transaction; no DB file atomic-swap. Smallest possible surface that closes the user-visible inconsistency.
- **Performance work deferred.** Parallel parse + buffered writes (independent analyst's items #1 and #2) require profiling proof first. Speculative claim of 3-5x throughput rejected without per-record timing data on PLDT_DEV_Anshul. Profiling task captured as backlog item 2 below; trigger to revisit is documented per backlog entry.

## Files Expected to Be Touched

- `packages/core/src/extractors/live-org/bulk-retrieve.ts` — watchdog clock (W1.5-01), slot release + late-drain + namespaced warnings (W1.5-02), local stop-waiting signal (W1.5-03)
- `packages/core/src/extractors/live-org/rate-limit.ts` — queue-cancel path in `scheduleQuery` ~314; AbortError surface in `soqlWithTimeout` 15–28 / `withTimeout` 39–47 (W1.5-03)
- `packages/core/src/extractors/live-org/extractors/lwc.ts` — sliding-window concurrency at loop ~60, per-bundle SOQL 91–98, managed fast-path 65–84 preserved (W1.5-04)
- `packages/core/src/ingest/live-ingest.ts` — deletion-sweep guard at lines 789–819 (W1.5-07)
- `packages/core/src/graph/store.ts` — `countNodesByLabel(label)` helper (W1.5-07); `sync_generation` + `sync_in_progress` columns + migration + `touchSync()` increment (W1.5-08)
- `packages/server/src/` — MCP tool response surface; add `staleness` block (W1.5-08)
- `packages/core/src/ingest/warning-schema.ts` — NEW; documents the namespaced-string schema and the forward-compat mapping to W1-01's eventual structured shape (now also documents `wedge:detect-deletions:refuse:*` from W1.5-07)
- `packages/core/src/extractors/live-org/diagnostics/` — NEW directory for report builder, capability probes, slow-call collector (W1.5-05)
- `packages/cli/src/commands/diagnose.ts` — NEW (W1.5-05)
- `packages/cli/src/index.ts` — wire `diagnose` subcommand (W1.5-05)
- `README.md` — claim audit + env var inventory + Diagnostics section + Coverage link + staleness block doc (W1.5-06)
- `docs/COVERAGE.md` — NEW comprehensive matrix + jsforce stop-waiting known-limitation + deletion-guard refusal + MCP staleness (W1.5-06)
- `.planning/ROADMAP.md` — Phase 1.5 requirements list updated to 8 items
- `.planning/phase-1.5/PLAN.md` — this file
- `.planning/phase-1.5/EVIDENCE.md` — NEW; before/after ingest log captured during verification, per EVIDENCE.md schema above
- `.planning/STATE.md` — append Decisions Log entries above + backlog items below

## Constraints

- Do not modify existing per-call timeout literals (60s SOQL, 120s `metadata.read`) — fix watchdog semantics instead. If a specific path needs more, document it in W1.5-04's investigation notes and propose a separate change.
- Preserve all existing test coverage. Add new tests for: watchdog-at-slot-acquired semantics (W1.5-01), wedge-isolation cascade prevention + late-yield drain (W1.5-02), stop-waiting / queue-cancel paths + leak-visibility assertion (W1.5-03), LWC parallel-fetch ordering and failure-isolation (W1.5-04), `diagnose` JSON report shape (W1.5-05), deletion-sweep guard refusal paths (W1.5-07), and sync-generation increment + in-progress flip on throw (W1.5-08).
- Phase 1.5 does NOT depend on Phase 1. Both can land in either order. Forward-compat schema is documented in `packages/core/src/ingest/warning-schema.ts`.
- The Decisions Log in `STATE.md` must be updated when this PLAN is finalized — add the stop-waiting-not-abort, namespaced-string-warnings, soft-isolate-with-late-drain, LWC-window=8, diagnostics-path, W1.5-07 guard-refuses-not-merges, W1.5-08 INTEGER-counter-not-snapshot, and performance-work-deferred decisions.

---

## Deferred / Backlog

These items were surfaced by an independent analyst review (12 issues identified in `live-ingest.ts`) but are **explicitly deferred** from Phase 1.5. Each item lists its trigger to revisit so we don't lose the thread.

**Backlog item 1: Per-record SQLite write buffering.**
- Source: independent analyst identified this as part of "biggest leverage" pair (#2 from their list).
- Status: deferred pending profiling.
- Trigger to revisit: real-org timing histogram shows >20% wall-clock spent in SQLite merge calls (`mergeNodes`, `mergeEdges`, snippet upsert).
- Estimated win: 10–30s on a 482s ingest. better-sqlite3 in WAL mode is fast; fsync amortization is the actual gain.

**Backlog item 2: Parallel `processOne` via `p-limit(4-8)`.**
- Source: independent analyst (#1 from their list). Claim of 3–5× throughput is unprofiled.
- Status: deferred pending profiling.
- Trigger to revisit: real-org timing histogram shows >50% wall-clock spent inside `processOne` (CPU-bound parsing for Apex AST, OmniStudio JSON walks, LWC HTML bind resolution).
- Profiling requirement: capture per-record CPU time vs await time on PLDT_DEV_Anshul. If parsing dominates, plan as Phase 1.6. If extractor-bound, the parallel-parse refactor is wasted effort.
- Compounds with: backlog item 1 (combined refactor is one architectural change, not two).

**Backlog item 3: Move MCD baseline into the bulkRetrieve sliding-window merge (#6 from analysis).**
- Source: independent analyst (#6).
- Status: deferred pending verification of the "different physical tables" claim.
- Trigger to revisit: confirm MCD-edge writes and parsed-edge writes do NOT race on shared rows in the `edges` table.
- Expected win: 30–90s by parallelizing MCD with the main fan-out.

**Backlog item 4: De-duplicate `discoverMetadataTypes` + `probeCapabilities` calls (#9 from analysis).**
- Trivial fix; ~5s win; not worth its own phase. Bundle into the next general PR touching the ingest entry.

**Backlog item 5: OmniStudio double-ingest dedup (#10 from analysis).**
- Five-line dispatch change when `disableOmnistudioRetrieve === false`. Bundle into Phase 3 (OmniStudio retrieve) since the logic lives next door.

**Backlog item 6: Incremental-mode deletion safety net (#5 from analysis).**
- Schedule periodic full syncs every Nth incremental run; relies on W1.5-07 already landing as the underlying safety mechanism. Defer to milestone v1.3.

**Backlog item 7: Post-merge pass parallelization (#7 from analysis).**
- Group independent post-merge passes (`resolveFlowApexMethods`, `resolveApexMethodArity`, audit) into `Promise.all`. 5–15s win. Trivial; bundle into a future PR.

**Backlog item 8: Reflection walker index streaming (#11 from analysis) — REJECTED.**
- Analyst flagged memory cost. Existing 50k-per-label cap is sufficient. V8 string compression makes the actual heap cost smaller than implied. Re-evaluate ONLY if heap profiling proves it bites in production. Not in backlog; not a planned future item.

---

## Verification round 1

This section summarizes the revisions applied in response to the verifier's `.planning/phase-1.5/VERIFICATION.md` (PASS WITH CONCERNS, 7 required revisions). Each revision is keyed to its verifier item.

### Blocking revisions applied

**1. Reframed W1.5-03 from "AbortSignal threading" to "stop-waiting iterator close with socket-leak acknowledgement."** The verifier confirmed against `node_modules/.pnpm/jsforce@3.10.15.../jsforce/lib/request.js:55,128,180` that jsforce 3.10.15 creates its `AbortController` internally and never exposes it; `conn.tooling.query()` returns a `Promise`, not an abortable `Request`. The W1.5-03 description, acceptance tests, and known-limitation block now reflect this reality. The merger releases the slot within 100ms via a local stop-waiting signal; the underlying request continues until network-layer timeout (~10min). Queue-cancel (signal aborts before `pool.schedule` invokes the factory) remains clean and is the path used for the W1.5-02 cap-eviction "happy" case. W1.5-02 acceptance was relaxed to reflect that wedged sources may hold a TCP socket + ~1–10MB until network-layer reap; this is an accepted Phase 1.5 bound.

**2. Dropped the W1-01 / Phase 1 dependency; Phase 1.5 ships against the current `string[]` warnings surface.** Verifier confirmed `LiveIngestResult.warnings` is `string[]` today at `packages/core/src/ingest/live-ingest.ts:161` and Phase 1 has not been planned. Phase 1.5 now emits namespaced colon-delimited strings (`wedge:<sourceLabel>:<stage>:<detail>`) on the existing surface. A new "Warning surface" section documents the schema and the forward-compatible bijective mapping to W1-01's eventual structured shape. `depends_on: []` in frontmatter; phase header updated; `## Phase 1 interaction` section added. ROADMAP.md updated to remove the dependency line. STATE.md Decisions Log will record the namespaced-string decision.

### Non-blocking revisions applied

**3. W1.5-02 drain-vs-discard policy.** Plan now explicitly commits to **drain**: late-yielded records from a wedged source are merged into the output stream as long as the ingest pipeline is open, tagged with `attributes.lateYield: true` and `attributes.wedgeReleasedAt: <ISO>`. Acceptance test now asserts that records yielded ≥100ms after slot release are present in the output. Cap semantics tightened: `SFGRAPH_MAX_BACKGROUND_WEDGES` is the number of simultaneously active background wedges; eviction fires when the cap would be exceeded.

**4. Env var typo fixed.** All references to `SFGRAPH_SOURCES_CONCURRENCY` corrected to `SFGRAPH_SOURCE_CONCURRENCY` (singular), matching `bulk-retrieve.ts:78`. Affected W1.5-05's diagnose-mode pool override list and the W1.5-06 env var inventory.

**5. W1.5-06 env var inventory expanded.** Inventory now includes ≥12 vars: `SFGRAPH_SOURCE_CONCURRENCY`, `SFGRAPH_SEQUENTIAL_SOURCES`, `SFGRAPH_BISECT_MAX_DEPTH`, `SFGRAPH_METADATA_READ_CHUNK_SIZE`, `SFGRAPH_TOOLING_POOL`, `SFGRAPH_METADATA_POOL`, `SFGRAPH_DATA_POOL`, `SFGRAPH_INCLUDE_ALL_GENERIC`, `SFGRAPH_SKIP_LWC`, `SFGRAPH_INCLUDE_MANAGED` / `SFGRAPH_INCLUDE_MANAGED_NAMESPACES`, `SFGRAPH_DEBUG_INGEST`, `SFGRAPH_NO_AUTO_RETRY`, and new `SFGRAPH_MAX_BACKGROUND_WEDGES`. Final count is to be reconciled at execution time via `grep -rn "process\.env\.SFGRAPH_" packages/core/src/ packages/cli/src/ packages/mcp-server/src/` rather than locked in the plan.

**6. EVIDENCE.md measurement schema pinned.** New "EVIDENCE.md Measurement Schema (pinned)" section defines: extraction source (`live-ingest.ts:184-186` run summary), grep command, required YAML fields (org alias/ID, before/after timestamps + skip counts + skip source lists + env vars + branch SHAs, delta absolute + percentage, drift guards). Acceptance pinned at "AFTER ≤ 10% of BEFORE AND every remaining skip has `lastYielded` in its own source label AND no >5% org drift between runs."

**7. Removed fictitious `watchdogClockMisaligned` code reference.** W1.5-01 acceptance line that said "a structured warning of `code: 'watchdogClockMisaligned'` is impossible to emit" has been removed and replaced with: "The bug is structurally removed: the existing `first-yield 90s` skip can no longer fire for a source that never executed." The plan's emitted-warning examples now use only namespaced-string formats actually consistent with the schema in the "Warning surface" section.

### Net effect

Phase 1.5 is now dependency-free, internally consistent against verified jsforce 3.10.15 behavior, measurable via a pinned EVIDENCE.md schema, and grounded in the actual env-var inventory of the codebase. The keystone (W1.5-01 + W1.5-02) is unchanged in spirit but tightened in semantics. The phase is ready for execution.

---

## Verification round 2

This round folds in an independent analyst review of `live-ingest.ts` (12 issues identified) and ships two new requirements plus 8 explicit backlog/rejection entries.

### (a) New requirements added

**W1.5-07 — Per-label drop-ratio guard on `--detect-deletions` sweep.** Adds a second-line defense at `packages/core/src/ingest/live-ingest.ts:789-819`. The existing sweep only skips when `streamAborted === true`; a wedged source completes with `streamAborted === false` and an empty `touchedQnames`, which causes the sweep to wipe every node of that label. Combined with W1.5-01/02's cascade fix, W1.5-07 ensures no wedge can ever cause data loss: refuse the deletion when prior count > 0 and either touched count is zero or the implied drop ratio exceeds 0.30 (env-overridable). Refusal is surfaced as `wedge:detect-deletions:refuse:*` warnings and tagged for the diagnose CLI to report.

**W1.5-08 — Sync-generation counter for MCP reader staleness signal.** Adds a `sync_generation` column to `_sfgraph_orgs` and an in-progress flag (separate column or parity sentinel). Incremented at ingest start/end via `touchSync()` with try/finally semantics. MCP server surfaces `staleness: { generation, in_progress, last_sync_at }` on every tool response so concurrent readers can detect "the graph is being rewritten" without requiring a global ingest transaction or snapshot isolation.

### (b) Why these were added

- **W1.5-07 — compounding risk with the wedge cascade.** The original Phase 1.5 evidence narrative documented a 37-source skip cascade and 19,166 dangling edges. The independent analyst observed that with `--detect-deletions=true`, the same benign wedge would have caused a **graph extinction event** — every Profile and PermissionSet wiped from the graph. W1.5-01/02 fix the cascade itself; W1.5-07 is the second-line defense that ensures the deletion sweep cannot act on an empty stream. It is small (one helper + one guard block), independent of the keystone work (different files), and closes a catastrophic-but-latent failure mode. High priority for that reason.
- **W1.5-08 — cheap reader staleness.** Concurrent MCP readers today can observe partial-state graphs mid-ingest. As the MCP ecosystem grows (agents firing tools mid-ingest), this becomes more likely to bite. A `sync_generation` counter is the minimum surface that closes the user-visible inconsistency without introducing global transactions or snapshot isolation. Complementary to W1.5-07; orthogonal to the cascade work; can parallelize with anything.

### (c) Explicit deferrals from analyst items

- **#1 Parallel `processOne` via p-limit** → backlog item 2. Trigger: real-org timing histogram shows >50% wall-clock spent inside `processOne`. Profiling requirement: per-record CPU vs await time on PLDT_DEV_Anshul.
- **#2 Per-record SQLite write buffering** → backlog item 1. Trigger: real-org timing histogram shows >20% wall-clock spent in SQLite merge calls.
- **#5 Incremental-mode deletion safety net** → backlog item 6. Relies on W1.5-07 as underlying mechanism; defer to milestone v1.3.
- **#6 MCD into bulkRetrieve merge** → backlog item 3. Trigger: confirm MCD-edge writes and parsed-edge writes do NOT race on shared rows.
- **#7 Post-merge pass parallelization** → backlog item 7. Trivial; bundle into a future PR.
- **#10 OmniStudio double-ingest dedup** → backlog item 5. Bundle into Phase 3.

### (d) Explicit rejection

- **#11 Reflection walker index streaming** → REJECTED. Existing 50k-per-label cap is sufficient; V8 string compression makes the actual heap cost smaller than implied. Re-evaluate ONLY if heap profiling proves it bites in production. Not on the backlog; not a planned future item.

### Net effect of round 2

Phase 1.5 now hardens not just the cascade but its catastrophic downstream consequence (label-wide deletion) and adds a cheap, complementary reader-staleness signal. Every analyst-identified speculative performance refactor has either a trigger condition to revisit or an explicit rejection rationale. The keystone work (W1.5-01/02) and its dependents are unchanged. Phase 1.5 is ready for execution as 8 requirements across the same wave structure.
