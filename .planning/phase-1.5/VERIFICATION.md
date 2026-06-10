# Phase 1.5 Plan Verification

**Plan reviewed:** `.planning/phase-1.5/PLAN.md`
**Date:** 2026-05-18
**Reviewer mode:** goal-backward (plan, not code) verification
**Phase goal:** "A real-org ingest never reports a metadata type as 'skipped' because of a wedge in an unrelated source. The watchdog kills the wedge, not its queued neighbors. README accurately reflects what ships."

Overall verdict: **PASS WITH CONCERNS (CONDITIONAL ACCEPT).** The keystone (W1.5-01 + W1.5-02) is sound and will close the documented cascade. Three concerns are blocking before execution: (a) W1.5-03 AbortSignal threading is technically suspect against the installed jsforce 3.10.15; (b) the W1.5 → Phase 1 ordering is incoherent in the roadmap (Phase 1.5 depends on W1-01 but Phase 1 has not been planned, and the warnings surface today is `string[]` not structured); (c) the ≥90% skip-reduction success criterion has no precise measurement contract tying it to existing log output.

---

## Criterion 1 — Will W1.5-01 prevent the cascade? PASS

The cascade is structurally caused by `failSoft()` at `packages/core/src/extractors/live-org/bulk-retrieve.ts:137` setting `startedAt = Date.now()` synchronously at the moment `failSoft(label, factory, onError)` is *called* (line 401 of the same file, inside `invoke()`), not at the moment the async generator is consumed.

Walk through the predicate at `bulk-retrieve.ts:155-169` against the proposed change:

- Today: `firstYieldMs = 90_000`. `remainingFirstYield = startedAt + firstYieldMs - Date.now()`. When a `failSoft`-wrapped source is created at second `t=0` but is the 13th source under `concurrency=12` (mergeAsyncIterablesParallel default at `bulk-retrieve.ts:86`), it does not enter the `while (pending.size > 0)` loop body at `bulk-retrieve.ts:112` until 12 other slots vacate. If a wedged source holds its slot for 440s, this queued source has burned all 90s of its budget while parked in the `sources[]` array. Its `it.next()` (line 173) is never actually entered before the watchdog fires inside the merger's first call to it — and even if it were entered, `watchdogMs` is already `<= 0` so it throws synchronously at line 165-168.
- After W1.5-01: `startedAt` is set at the moment `factory()[Symbol.asyncIterator]()` is first called and the first `it.next()` is awaited (the plan specifies this is moved from line 137 to immediately before the `while` loop at line 160). This moment in the merger corresponds to `advance(idx)` at `bulk-retrieve.ts:91-107`, which is only called when the iterator is in the live window. A queued source's clock therefore cannot start until it acquires a slot. Cascade structurally closed.

One unstated subtlety the plan handles correctly: `failSoft()` is itself an async generator (`async function*` at line 131). The plan says to move `startedAt` to "the moment `factory()[Symbol.asyncIterator]()` is first called" — line 159 today. That is in fact the right line: the body of the async generator does not execute until the consumer (the merger) awaits its first `.next()`, which is exactly slot-acquisition time. The plan's described change is consistent with this.

Acceptance test in the plan (10 factories, 4 sleep, 6 instant, `concurrency=4`, `firstYieldMs=10s`, expectation that 4..9 all complete) is the right shape for the cascade scenario. PASS.

Minor — the plan also claims "a structured warning of `code: 'watchdogClockMisaligned'` is impossible to emit" but no such warning exists today; this acceptance line is rhetorical and should be removed or rephrased to "the bug is structurally removed; the existing first-yield-90s skip can no longer fire for a source that never executed" so reviewers don't search for a missing fixture.

---

## Criterion 2 — Soft-isolate + late records. PASS WITH ONE GAP

The slot-release model is correct: when the watchdog fires for an executing source, the plan says to release the merger slot (so `pending.size` decreases and `advance(nextIterIdx++)` runs at `bulk-retrieve.ts:118`) and let the iterator continue running in the background.

The gap: **what happens to records the wedged iterator yields after slot release?** The plan does not state this. Two possibilities, both defensible:

1. *Drain into the output stream anyway.* Requires the merger to keep the iterator's promise in a side map and continue to race it; records yielded late are still upserted (live-ingest's `processOne` is idempotent per the comment at `bulk-retrieve.ts:71-73`).
2. *Discard.* The iterator is detached; whatever it yields after slot release is dropped on the floor; only the side-effect-free wall-clock cost (open socket, queued Bottleneck job) lingers.

Option 1 is the spirit of "soft-isolate" — the wedge is allowed to *finish*, implying its records are captured. Option 2 is what the acceptance test as written ("8 others execute to completion and yield records; exactly one `sourceWedged` warning is emitted") technically permits. The plan must commit explicitly to one model. Recommend option 1 (drain) because:

- It maximally aligns with phase goal "kills the wedge, not its queued neighbors" — the wedge isn't killed, just demoted.
- It matches the `attributes.slotReleased: true` / `lastYieldedRecord` warning shape, which implies the iterator is still observable.
- It removes a class of silent data loss that would be hard to debug later.

The cost is a side-pending-map in `mergeAsyncIterablesParallel` and the W1.5-02 acceptance test needs to assert that *records* from the wedged source eventually arrive (not just that the warning is emitted). Add this to W1.5-02 acceptance.

Second gap: the `SFGRAPH_MAX_BACKGROUND_WEDGES=2 with three induced wedges` acceptance test assumes the cap kicks in *after* the third wedge slot would be promoted to background. There is an off-by-one ambiguity (is the cap "active background wedges" or "background slots permitted"?). Plan should say which.

PASS, conditional on plan revision adding (a) explicit drain-vs-discard decision, (b) records-arrive assertion in acceptance test, (c) cap semantics tightened.

---

## Criterion 3 — AbortSignal threading realism. PARTIAL FAIL — needs research before implementation

This is the riskiest item in the plan. The plan asserts at `PLAN.md:104`:

> `soqlWithTimeout()` (lines 15–28) and `withTimeout()` (lines 39–47) — accept an optional `signal`; when the signal aborts, the in-flight `jsforce` request is aborted via `request.abort()` (jsforce exposes this on its `Request` object)

This is **not accurate for the installed version** (jsforce 3.10.15). I read the request implementation at `node_modules/.pnpm/jsforce@3.10.15_@types+node@22.19.19/node_modules/jsforce/lib/request.js:55,128,180`. jsforce constructs its own `AbortController` internally and passes `controller.signal` to `node-fetch`. It does **not** return that controller to the caller, and `conn.tooling.query(...)` returns a `Promise`, not a `Request` object with an `.abort()` method. There is no public surface to cancel an in-flight Tooling/Data query in jsforce 3.10.x — the abort is plumbed only into jsforce's own 10-minute internal timeout.

Concrete file:line evidence: `request.js:55` creates the AbortController; `request.js:128` passes `signal: controller.signal` to fetch; `request.js:180` is the only caller of `controller.abort()`, and it's wired to jsforce's internal `executeWithTimeout`. The AbortController never escapes that function. `conn.query(soql)` (and `conn.tooling.query`) goes through a higher-level `Query` object that returns a promise; the abort is not exposed.

Implications:

- W1.5-03 unit test "in-flight `soqlWithTimeout(connection, soql, { signal })` … causes the promise to reject within 100ms and `connection.request.abort` is called exactly once" presumes a public surface (`connection.request.abort`) that doesn't exist on the real connection object. The test passes against a mock but won't translate to real behavior.
- For the queued case (signal aborts *before* the Bottleneck job runs), the plan's "Bottleneck job's queue-cancellation path" is feasible: a wrapper around `pool.schedule` can check `signal.aborted` before invoking `fn()` and reject early, removing the queued job. That part is fine. But the in-flight case — the actual hard-abort fallback when a real HTTP request is wedged — has no implementation path that aborts the socket.
- The realistic fallback for in-flight: best-effort is to `reject(AbortError)` in our wrapper promise immediately and let the jsforce request continue running in the background until its 10-minute timeout. From the merger's perspective the source is now unblocked; from the socket pool's perspective the request leaks until libuv tears it down. This is essentially what `withTimeout()` already does at `rate-limit.ts:15-28`, so the W1.5-03 work for in-flight is approximately a no-op beyond surfacing `AbortError` distinctly from `TimeoutError`.

Recommend: **revise W1.5-03 description before implementation.** Either (a) acknowledge the in-flight abort is "stop-waiting" semantics, not real socket cancellation, and document the leak window (≤10 min until jsforce's own controller fires); or (b) drop into a lower layer and patch jsforce to expose its AbortController (not recommended — vendor patch surface). Option (a) is what the plan should commit to. The user-visible behavior is unchanged because the queued-case abort is what the W1.5-02 cap actually needs, and that path is implementable.

PARTIAL FAIL. The plan must be revised to reflect the jsforce 3.10.x reality before W1.5-03 implementation begins. Acceptance tests for in-flight abort should assert "promise rejects within 100ms with AbortError" — NOT "underlying HTTP request was cancelled".

---

## Criterion 4 — LWC parallelization safety. PASS

Sanity check the math:

- LWC bundle list query (`lwc.ts:19`): 1 Tooling slot, runs once.
- Per-bundle resource fetch (`lwc.ts:91`): currently serial via the for-loop at `lwc.ts:60`; each fetch goes through `scheduleQuery` which uses the Tooling pool (`rate-limit.ts:313-315`, `maxConcurrent: 5` from `DEFAULT_POOL_CONCURRENCY.tooling`).

If the LWC extractor opens a sliding window of 8 in-iterator concurrent per-bundle fetches, each fetch still goes through `scheduleQuery` → `toolingPool.schedule()` → `queryLimit` (pLimit 5). The Bottleneck pool's `maxConcurrent: 5` is the binding constraint; the in-iterator window of 8 just means up to 8 fetch promises are pending, of which 5 are actually executing and 3 are queued inside Bottleneck. This is fine — Bottleneck is designed for exactly this pattern. No oversubscription.

The math line in the plan, "the Tooling API connection pool is 5 concurrent and we want to keep that pool saturated with bundles in flight while leaving slack for retries", is essentially right. WINDOW=8 just means the in-iterator producer keeps 3 prefetched in the pool's queue so the pool never starves between bundles. WINDOW=5 would also work (no queue depth, marginally lower throughput when a bundle finishes and the next has to be scheduled); WINDOW=12 would also work (deeper queue, no real benefit; mild extra memory). WINDOW=8 is a fine middle.

One subtle risk: when ingest runs, `lwc` is one source among many in `mergeAsyncIterablesParallel` (12 concurrent sources). `apex` also uses the Tooling pool. If both LWC (8 in-flight) and Apex (its own fan-out) and `generic:` extractors (Tooling for those routed via `toolingSoql`) all schedule simultaneously, the 5-slot Tooling pool is the global cap. LWC monopolizing all 5 slots for 231 bundles would starve `apex`. This is **not new behavior** (LWC already saturates the pool serially, just one slot at a time, so the total wall-clock for LWC is unchanged — only fairness across Tooling-pool sources changes). But the plan should add an explicit success-criterion-adjacent assertion: "apex source wall-clock against PLDT_DEV_Anshul does not regress materially after W1.5-04." Otherwise the real-org win in LWC could hide a regression in Apex.

The "yield records as they complete, not in batch order" requirement (PLAN.md:127, acceptance line `yieldedAt[i] < yieldedAt[i+8]`) is correct and important — it keeps the watchdog's inactivity heartbeat alive. PASS.

Minor: the existing LWC code has a managed-namespace fast-path at `lwc.ts:65-84` that yields without a resource fetch. The W1.5-04 task description should note that managed bundles do not consume a window slot (they yield synchronously from the iterator body). Otherwise an implementer may write a window scheduler that wraps every bundle uniformly and serializes the managed fast-path through the same window.

---

## Criterion 5 — diagnose CLI value. PASS

`sfgraph diagnose <orgId>` is not busywork. The report structure at `PLAN.md:160-184` is operationally useful:

- `slowCalls[]` with >10s threshold names actual outliers — this is what would have caught the `oSSTechnologiesTable` wedge before it hit the watchdog (440s on a `LightningComponentResource` query is well above 10s).
- `perSource[].lastYieldedRecord` is the smoking gun field: today, the run log only says "lwc skipped (source watchdog: …)" without naming *which bundle* was in flight when the watchdog fired. The diagnose report names it.
- `wedgeTimeline[]` with `slotAcquired` / `firstYield` / `wedged` / `slotReleased` / `completed` events is the right shape to ground a future post-mortem.
- `capabilityProbes[]` is independently useful (it ties into Phase 3 `caps.omnistudioOncore`-style gating).

Running it against PLDT_DEV_Anshul post-W1.5-04 should produce a clean report (no `wedged: true` for `lwc` — bundles are now parallel) and `slowCalls[]` would surface only the remaining outliers. That's the reproducibility test the acceptance criterion at `PLAN.md:196` is asking for; it is achievable.

One issue: pool concurrency forced to 1 (`SFGRAPH_TOOLING_POOL=1`, `SFGRAPH_METADATA_POOL=1`, `SFGRAPH_SOURCES_CONCURRENCY=1`) changes the timing profile so dramatically that diagnose-mode timing is not directly comparable to a real ingest run. Plan should add a one-line note: "diagnose mode is for naming wedges, not predicting production wall-clock." Otherwise users will be confused why diagnose says everything is healthy and prod ingest still wedges (or vice versa). And the env var `SFGRAPH_SOURCES_CONCURRENCY` referenced at `PLAN.md:148` should be `SFGRAPH_SOURCE_CONCURRENCY` to match `bulk-retrieve.ts:78`.

PASS, with the env var name corrected and the timing-profile caveat added.

---

## Criterion 6 — README + COVERAGE.md reconciliation. PASS

The reconciliation is well-scoped:

- MCP tool count audit (PLAN.md:213): grep'able verification.
- Security gap disclosure (PLAN.md:215): names specific types (`PermSetGroup`, `MutingPermissionSet`, `ProfileSessionSetting`, `ProfilePasswordPolicy`) — I cross-checked `bulk-retrieve.ts:292-295` and these are routed through `GENERIC_TYPE_WHITELIST` to `iterGenericMetadata`, which emits opaque generic nodes without `GRANTS_*`/`DENIES_*` edges. The claim is accurate.
- Dynamic metadata discovery scope (PLAN.md:216): the count "~80 of ~327 discovered types" is a reasonable approximation based on the size of `GENERIC_TYPE_WHITELIST` at `bulk-retrieve.ts:240-332` (I count ~75 entries, plus the typed sets `APEX_TYPES` / `LWC_TYPES` / `FLOW_TYPES` / `OBJECT_TYPES` / `SECURITY_TYPES` / `INTEGRATION_TYPES`). Counts in README should be reconciled at execution time, not pre-counted in the plan.
- Env var inventory (PLAN.md:218-225) is correct as a list; I verified `SFGRAPH_BISECT_MAX_DEPTH` (`rate-limit.ts:76`), `SFGRAPH_METADATA_READ_CHUNK_SIZE` (`rate-limit.ts:94`), `SFGRAPH_SEQUENTIAL_SOURCES` (`bulk-retrieve.ts:482`), `SFGRAPH_INCLUDE_ALL_GENERIC` (`bulk-retrieve.ts:335`), `SFGRAPH_DEBUG_INGEST` (multiple), and `SFGRAPH_NO_AUTO_RETRY` (not verified — should be confirmed). Two **missing** env vars in the plan's inventory: `SFGRAPH_SOURCE_CONCURRENCY` (`bulk-retrieve.ts:78`) and `SFGRAPH_SKIP_LWC` (`lwc.ts:39`) and `SFGRAPH_INCLUDE_MANAGED` / `SFGRAPH_INCLUDE_MANAGED_LWC` (`lwc.ts:58-59`) and the per-pool overrides `SFGRAPH_TOOLING_POOL` / `SFGRAPH_METADATA_POOL` / `SFGRAPH_DATA_POOL` (`rate-limit.ts:256-258`). The plan says "7 vars" but the real count is closer to 12. PASS conditional on the inventory being grep-completed at execution time rather than locked at 7.

`docs/COVERAGE.md` matrix shape (PLAN.md:227-232) is reasonable — `Full` / `Partial` / `Generic-Only` / `Unsupported` is the right axis.

---

## Criterion 7 — Is the ≥90% skip-reduction target measurable? PASS WITH GAP

Today's run summary prints the total skip count at `packages/core/src/ingest/live-ingest.ts:184-186`:

```
⚠ {N} metadata types were skipped during this ingest.
```

This is grep'able: `grep -E "metadata (type was|types were) skipped" run.log | grep -oE "^[^ ]+ [0-9]+"`. The diagnostic-run baseline was 37 skips on PLDT_DEV_Anshul (per `PLAN.md:37`). ≥90% reduction means ≤4 skips post-1.5.

Gap: the success criterion at `PLAN.md:273` says "the skip count drops by ≥90% on the same org / run conditions as the original diagnostic run on PLDT_DEV_Anshul" but does not specify *how the comparison is recorded*. EVIDENCE.md needs a defined schema: at minimum the before-log and after-log paths, the org alias, the org snapshot identifier (commit SHA or timestamp), and the exact `grep` command used to extract the count. Otherwise "≥90%" is unfalsifiable because the org state can drift between runs (Anshul deploys a new bundle, the count changes for unrelated reasons).

Recommend adding to `PLAN.md` Verification section: "EVIDENCE.md MUST contain: (1) before-run skip count and source list, (2) after-run skip count and source list, (3) the diff, (4) explicit assertion that no other ingest configuration changed (env vars, branch SHA, org state). If org state cannot be frozen, the comparison should be 'same run within 24h' to bound drift."

PASS with this minor revision.

---

## Criterion 8 — Build order: is W1.5-01 + W1.5-02 truly the keystone? Could W1.5-04 alone solve it? PASS

W1.5-04 alone is **insufficient.** Two reasons:

1. LWC is one of many sources that can wedge. The cascade root cause (`bulk-retrieve.ts:137`) applies to *any* slow-to-first-yield source, not just LWC. `security` (which fans into the `iterSecurity` `metadata.read` path), `vlocity` (which does heavy SOQL via `vlocity/runner.ts`), `object` (heavy describe traffic), `flow` (large `metadata.read` batches), and the generic long-tail (`generic:Layout`, `generic:Workflow`, etc.) all have failure modes that produce >90s before first yield on real orgs. Fixing LWC parallelization closes one specific bundle-pagination cause, but the next slow source up will trigger the same cascade. The keystone *must* be the watchdog clock.
2. Even within LWC, parallelizing per-bundle does not fix the case where the *bundle list query* (`lwc.ts:19`) itself is slow (which is a pre-yield wedge — `started === false` at the watchdog check). W1.5-04 doesn't touch this query; the bundle-list path stays serial-first. If `LightningComponentBundle` table-scan slows to >90s on a large org, only W1.5-01's clock fix prevents queued sources from being killed during it.

So: W1.5-01 + W1.5-02 are the keystone (correct, per the plan). W1.5-04 is an LWC-specific win that's required to demonstrate the cascade fix on *this particular* org (PLDT_DEV_Anshul). Both are required for the phase to be considered complete on real-org evidence. The plan correctly orders them: W1.5-01/02 paired first, W1.5-04 second.

PASS.

---

## Criterion 9 — Anti-feature "no timeout literal increase". PASS WITH NOTE

The constraint is correct as stated. After W1.5-01, sources that legitimately need >90s to first-yield are extremely rare (the only realistic case is a single `metadata.list` against a huge type on a wedged-network org). For those, the right fix is the diagnose flow (W1.5-05) surfacing the specific call, then a targeted increase or a paginated-call rewrite — not a global bump.

However: the plan should acknowledge **one legitimate >90s case** explicitly. Real-org `metadata.list` for `CustomObject` on a 10k+ object org can legitimately take 60–120s. Once the source acquires its slot (i.e., post-W1.5-01), the 90s first-yield deadline still applies, and a healthy 100s first-yield is now a false-positive wedge that gets soft-isolated.

This is not a blocker but is worth a one-line note in the anti-features section: "If, post-W1.5-01, a specific named source consistently first-yields between 90s and 180s on healthy real orgs, raise *that source's* per-source budget (the watchdog API should accept a per-source override), not the global literal."

PASS with note.

---

## Criterion 10 — Phase 1 / Phase 1.5 ordering. **CONCERN — needs explicit decision**

The plan says (PLAN.md:25, 60): "Depends on Phase 1 — specifically W1-01 (structured-warning channel on `LiveIngestResult.warnings[]`)."

But the current state (verified at `packages/core/src/ingest/live-ingest.ts:121-162`) is:

```ts
warnings: string[];  // line 161
```

Plain string array. The structured `{stage, code, message, count, attributes}` shape that Phase 1.5 emits (`sourceWedged`, `backgroundWedgeAborted`, `lwcBundleFetchFailed`) has nowhere to land structurally until W1-01 ships.

And ROADMAP.md / STATE.md show Phase 1 is "not started" (STATE.md:14, ROADMAP.md:129 `0/?  Not started`). The Phase 1.5 plan was authored before Phase 1 has even been planned.

Three coherent paths forward (the plan must pick one):

**Option A — Strict dependency, no Phase 1.5 work until Phase 1 W1-01 lands.** Defer W1.5 entirely. Risk: Phase 1 is large (6 requirements including edge provenance, LWC directives, arity precision, README) and could take weeks. The cascade continues to cost real-org ingest reliability during that window. Recommend against.

**Option B — Land Phase 1.5 W1.5-01 + W1.5-02 + W1.5-04 against the **current** `string[]` warnings surface, with a TODO to convert to structured warnings once W1-01 lands.** The runtime fixes (watchdog clock, slot release, LWC parallelization) do not strictly require structured warnings to function — they need a place to write the warning, and `string[]` works for now. The structured-warning shape from the plan would degrade to a pre-stringified `"sourceWedged: lwc wedged 440000ms; lastYielded=lwc/Bundle/oSSTechnologiesTable"` until W1-01 promotes them. Risk: when W1-01 lands and changes the shape, a second pass must rewrite the Phase 1.5 emission sites. This is a small refactor (3 call sites by the plan). Recommend this path.

**Option C — Promote W1-01 (structured warnings only, not the full Phase 1 scope) out of Phase 1 and into Phase 1.5 as a prerequisite work item.** Logically clean but expands Phase 1.5's scope by one item. Acceptable.

The plan as written implies Option A but the ROADMAP positions Phase 1.5 before Phase 2 with no explicit gate on Phase 1. This must be resolved before execution. Recommend the plan add a "Phase ordering decision" sub-section explicitly choosing Option B (or C), and update the dependency line accordingly.

**This is the single biggest concern in the verification.** The plan is internally consistent, but its position in the roadmap is incoherent. Either Phase 1.5 must start *after* W1-01 (which has no ETA), or it must land its runtime fixes on the current string-array warnings surface with a documented refactor follow-up.

---

## Summary table

| # | Criterion | Status |
|---|-----------|--------|
| 1 | W1.5-01 watchdog-clock fix prevents cascade | PASS |
| 2 | W1.5-02 soft-isolate semantics + late-record handling | PASS with gap (drain-vs-discard + acceptance assertion) |
| 3 | W1.5-03 AbortSignal threading is realistic against jsforce 3.10.x | PARTIAL FAIL (in-flight abort claim is not supported by jsforce 3.10.15) |
| 4 | W1.5-04 LWC parallelization is safe vs Tooling pool | PASS (math is sound) |
| 5 | W1.5-05 diagnose CLI is operationally useful | PASS (with env-var name typo + caveat) |
| 6 | W1.5-06 README/COVERAGE reconciliation | PASS (env var inventory undercount: actually ~12, not 7) |
| 7 | ≥90% skip reduction is measurable | PASS with gap (EVIDENCE.md schema undefined) |
| 8 | Keystone is W1.5-01+02, not W1.5-04 alone | PASS (correctly ordered) |
| 9 | "No timeout literal increase" is the right constraint | PASS with note (per-source override likely needed eventually) |
| 10 | Phase 1.5 ↔ Phase 1 W1-01 ordering | **CONCERN — must be resolved before execution** |

## Required revisions before execution

1. **W1.5-03 description (`PLAN.md:98-119`)** — revise to reflect that jsforce 3.10.15 does not expose AbortController for in-flight Tooling/Data queries (verified at `node_modules/.pnpm/jsforce@3.10.15.../jsforce/lib/request.js:55,128,180`). Reframe in-flight abort as "stop-waiting" semantics with a documented socket-leak window of up to 10 minutes. Queued-abort (signal aborts before `pool.schedule` invokes the function) is implementable as described.
2. **Phase ordering (`PLAN.md:25, 60`)** — explicit decision (recommend Option B): land runtime fixes against today's `string[]` warnings surface with a follow-up refactor to the structured shape when W1-01 ships. Update dependency wording from "strictly depends on Phase 1" to "runtime fixes are independent; warning-shape conversion is post-W1-01."
3. **W1.5-02 acceptance test (`PLAN.md:86`)** — add explicit drain-vs-discard decision (recommend drain) and add an assertion that records yielded by the wedged source after slot release are captured in the output stream.
4. **W1.5-05 env var (`PLAN.md:148`)** — `SFGRAPH_SOURCES_CONCURRENCY` should be `SFGRAPH_SOURCE_CONCURRENCY` (singular, matching `bulk-retrieve.ts:78`).
5. **W1.5-06 env var inventory (`PLAN.md:218-225`)** — expand from 7 vars to the full set; add at minimum `SFGRAPH_SOURCE_CONCURRENCY`, `SFGRAPH_SKIP_LWC`, `SFGRAPH_INCLUDE_MANAGED`, `SFGRAPH_INCLUDE_MANAGED_LWC`, `SFGRAPH_TOOLING_POOL`, `SFGRAPH_METADATA_POOL`, `SFGRAPH_DATA_POOL`. Reconcile final count at execution time rather than locking a number in the plan.
6. **Success criterion 6 (`PLAN.md:273`)** — add EVIDENCE.md schema: before/after log paths, org alias, org snapshot identifier, exact `grep` extraction command, assertion of no other config change.
7. **W1.5-01 acceptance line about `watchdogClockMisaligned`** — remove or rephrase; no such code exists today, so the "fixture deletion" line will confuse implementers.

After these revisions, the plan is ready for execution. The core architectural intent (watchdog clock at slot-acquired + semantic slot release + LWC parallelization) is sound and will achieve the phase goal as stated.
