---
name: sf-debug-log-analysis
description: Read and analyse a Salesforce Apex debug log — exceptions/FATAL_ERROR, governor-limit consumption (SOQL/DML/CPU/heap), the execution call tree, and slow or repeated code units — then ground every finding in the org graph (map the log's code units/methods to qnames and explain WHY with trace/governor/analyze_field). Use when the user pastes or points to a debug log, an `sf apex get log` output, or asks to interpret a System.debug / stack trace / "Too many SOQL queries" / CPU-time log. Pairs with sf-debug-root-cause (log = symptom, graph = cause).
triggers:
  - "debug log"
  - "read this log"
  - "analyze this log"
  - "apex log"
  - "Too many SOQL queries"
  - "Apex CPU time limit"
  - "System.debug output"
  - "FATAL_ERROR"
  - "LIMIT_USAGE"
  - "sf apex get log"
  - "stack trace from the log"
tools_used:
  - find_nodes
  - explain_code
  - trace_upstream
  - trace_downstream
  - analyze_field
  - governor_risk_check
  - staleness_check
---

# sf-debug-log-analysis

A Salesforce debug log is the ground truth of what *actually executed* — but on its own
it's a wall of pipe-delimited lines and it can't tell you *why* (what other code calls the
slow method, where the in-loop SOQL is declared, what writes the field that reverted).
This skill reads the log, extracts the signal, and **grounds each finding in the org graph**
so the answer is "the CPU went here because `OrderTriggerHandler.recalc` runs a SOQL inside
a `for` over `Trigger.new` — here are its 3 callers", not "looks like a CPU issue".

Format reference: <https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_debugging_debug_log.htm>

## Getting the log (if the user hasn't supplied one)

- Salesforce CLI: `sf apex list log` → `sf apex get log --log-id <id> > debug.log`, or live: `sf apex tail log --color none`.
- Setup → Debug Logs (trace flags on the user), then download.
- Tell the user the log level matters: `Apex Code = FINE`/`FINER` captures method entry/exit and SOQL; `Apex Profiling`/`System = FINE` captures the `CUMULATIVE_LIMIT_USAGE` block. `FINEST` is huge and often truncated at the 20 MB cap — prefer `FINE`/`FINER` unless you need variable-level detail.

## Reading the log (format)

The header line lists the API version + per-category log levels. Every subsequent line is
`HH:mm:ss.SSS (elapsedNanos)|EVENT_TYPE|details`. The event types that carry signal:

| Event | What it tells you |
|---|---|
| `CODE_UNIT_STARTED` / `_FINISHED` | The unit boundaries — triggers, `Class.method`, flows, VF, anonymous. Top of the call tree. |
| `METHOD_ENTRY` / `METHOD_EXIT` | Method call tree (needs Apex Code ≥ FINER). Indentation/elapsed time = where time goes. |
| `SOQL_EXECUTE_BEGIN` / `_END` | Each query + `Rows:` returned + aggregations. **Count them** — repeated identical SOQL = in-loop. |
| `SOSL_EXECUTE_*`, `DML_BEGIN` / `_END` | SOSL and DML operations + row counts. |
| `CALLOUT_REQUEST` / `_RESPONSE` | HTTP callouts + endpoints + timing. |
| `EXCEPTION_THROWN` | The thrown exception + type + the offending `Class.method: line`. |
| `FATAL_ERROR` | The uncaught error + full Apex stack trace — the prime anchor for a failure. |
| `USER_DEBUG` | `System.debug()` output the developer planted. |
| `LIMIT_USAGE_FOR_NS` / `CUMULATIVE_LIMIT_USAGE` | **The governor scorecard** — SOQL queries, query rows, DML statements/rows, CPU time, heap, callouts used vs limit. |
| `HEAP_ALLOCATE`, `STATEMENT_EXECUTE`, `VARIABLE_*` | FINEST-only, very noisy — skip unless chasing a heap/variable bug. |
| `FLOW_*` / `WF_*` | Flow elements and Workflow-rule evaluation (order-of-execution bugs). |

## Method

1. **If the log is large, filter before reading.** Don't load a 20 MB log into context. Grep for the signal first:
   `grep -nE 'FATAL_ERROR|EXCEPTION_THROWN|CUMULATIVE_LIMIT_USAGE|LIMIT_USAGE_FOR_NS' debug.log` for failures + limits;
   `grep -c 'SOQL_EXECUTE_BEGIN' debug.log` for query count;
   `grep -E 'CODE_UNIT_(STARTED|FINISHED)' debug.log` for the unit skeleton.
   Read only the relevant slices.
2. **Classify the problem** from the evidence: an uncaught failure (`FATAL_ERROR`), a governor breach (limit at/over 100% in the cumulative block, or a `System.LimitException`), a performance issue (one `CODE_UNIT` dominating elapsed time), or just `USER_DEBUG` tracing.
3. **Extract the anchor:**
   - Failure → the exception type + the top in-org frame `Class.method: line` from the stack trace.
   - Governor → which limit, the count vs cap, and the `CODE_UNIT`/method where consumption spiked (repeated SOQL/DML lines under one unit).
   - Performance → the `CODE_UNIT`/method with the largest elapsed delta.
4. **Ground it in the graph** (the part a log reader alone can't do):
   - `find_nodes ApexClass:<Name>` / `ApexMethod:<Name>.*` to resolve the anchor to a qname; `explain_code` on the method to read the offending source. The graph stores source only for Apex methods — for a **trigger body, Flow, whole class, or managed code, fetch the real source** (local `force-app/main/default/{classes,triggers,flows}/...` or `sf project retrieve start -m "ApexTrigger:<Name>"`); don't analyse from an empty stub. See `sf-explain-code`.
   - `trace_upstream` — who invokes this unit, and in what context (trigger vs batch vs LWC). Order-of-execution and "why was this even called" answers live here.
   - `trace_downstream` — what it calls/reads/writes; a NullPointer or limit usually originates in a callee.
   - Governor breach → `governor_risk_check` scoped to the class to pinpoint the SOQL/DML-in-loop **source line** the log proved is hot.
   - Field misbehaviour seen in the log → `analyze_field` for every trigger/Flow/validation that fires on that field (competing automation).
5. **State a single root-cause hypothesis** backed by *both* the log evidence and the graph evidence, then hand the fix to the right design skill (`sf-architect-apex` / `sf-architect-performance` / `sf-governor-risk-fix`) — grounded, never generic.

## Staleness

If you'll ground in the graph, call `staleness_check` first. A stale graph maps the log's
code units to outdated source — warn and recommend `sfgraph ingest --org <alias>`. The log
itself is always current; the mismatch is on the graph side.

## Response shape

- **Verdict** — one line: failure / governor breach / performance / trace-only, with the anchor `Class.method:line`.
- **Log evidence** — the decisive lines (exception, the cumulative-limit row that breached, the repeated SOQL count, the dominant code unit) — quote them, don't paraphrase.
- **Graph grounding** — callers, callees, competing automation, or the in-loop source line that explains the log.
- **Root cause** — one hypothesis, confidence, tied to both evidence sources.
- **Fix** — described and handed off to a design skill; not auto-applied.
- **Mermaid** — optional call-tree or caller→unit→callee path when it clarifies.

## Don't

- Don't load a multi-MB log wholesale — filter with grep first, then read slices. Say what you filtered so nothing looks silently dropped.
- Don't stop at the log. The log shows *what*; grounding in the graph shows *why* — that's the value. A log-only answer is a guess about the cause.
- Don't trust `FINEST` noise (`STATEMENT_EXECUTE`/`VARIABLE_ASSIGNMENT`) as signal — anchor on CODE_UNIT/SOQL/DML/limit/exception events.
- Don't edit code here — produce evidence + root cause; design hands off.
- Don't confuse a logged, *caught* `EXCEPTION_THROWN` with the actual failure — the uncaught `FATAL_ERROR` (if present) is the one that ended the transaction.
