---
name: sf-debug-root-cause
description: Root-cause a SPECIFIC Salesforce failure — an Apex exception or stack trace, a failing test, a flow fault, or "this field/record isn't behaving right" — by grounding the symptom in the org graph (callers, callees, recent changes, automation on the object, test coverage). Use when the user reports a concrete error/symptom and wants to know WHY. For "what changed since deploy" broadly use sf-what-broke; for pre-commit blast radius use sf-wip-impact.
triggers:
  - "why is this failing"
  - "debug this error"
  - "this test fails"
  - "stack trace"
  - "NullPointerException"
  - "System.LimitException"
  - "this trigger isn't firing"
  - "field isn't updating"
  - "flow fault"
  - "root cause"
tools_used:
  - find_nodes
  - explain_code
  - trace_upstream
  - trace_downstream
  - analyze_field
  - what_broke
  - test_gap_intelligence_from_git_diff
  - staleness_check
---

# sf-debug-root-cause

Use when the user has a **concrete failure** and wants the cause, not a guess. Salesforce
failures are rarely in the one method that threw — they come from another trigger on the
same object, a recent change upstream, an order-of-execution surprise, or automation the
developer forgot exists. The graph makes those visible. Debug by narrowing with evidence,
never by pattern-matching the error message to a generic fix.

## Method (scientific, evidence-first)

0. **If a debug log is available, start there.** A debug log is the strongest anchor — it
   has the exact `FATAL_ERROR` stack frame and the real governor scorecard. Hand the log to
   **`sf-debug-log-analysis`** to extract the anchor + limit evidence, then continue this
   playbook from step 2 with that anchor. Without a log, anchor from the error text/symptom:

1. **Anchor the symptom to a node.** Parse the error / test name / symptom for the failing
   unit and resolve its qname:
   - Apex class/method in the trace → `find_nodes ApexClass:<Name>` / `ApexMethod:<Name>.*`.
   - Failing test → the test method, then its `IS_TEST_FOR` target.
   - "Field X isn't updating" → `analyze_field` on `<Object>.<Field>`.
   If you can't anchor it, ask the user for the class/object name — don't guess.

2. **Read the failing unit.** `explain_code(qname=<ApexMethod>)` for Apex methods. The graph
   stores source only for Apex methods — for a **trigger body, Flow logic, a whole class, or
   managed/`(hidden)` code, fetch the real source** (the graph can't show it): read the local
   sfdx file (`force-app/main/default/{classes,triggers,flows}/<Name>.{cls,trigger,flow-meta.xml}`)
   or `sf project retrieve start -m "ApexTrigger:<Name>"`. See `sf-explain-code` for the full
   fallback. Confirm the trace's line maps to a real branch (SOQL, DML, deref).

3. **Look outward for the real cause — this is where graphs beat grep:**
   - `trace_downstream(qname)` — what it calls / reads / writes. A `System.NullPointer` or
     `LimitException` usually originates in a callee or a SOQL/DML it triggers.
   - `trace_upstream(qname)` — who invokes it, and with what context (trigger vs batch vs
     LWC). Order-of-execution bugs hide here.
   - For an object symptom: `sf-flow-impact` / `analyze_field` — every trigger, Flow,
     Process Builder, and validation rule that fires on the object. "Trigger isn't firing"
     and "field reverts" are almost always a competing automation.
   - **If the cause depends on actual data** (a field's real value, a CMDT/setting the code
     reads, a record-type/picklist value, data skew) and the graph doesn't hold it, pull it
     from the org — config/metadata records freely (`sf data query … FROM <Type>__mdt`), live
     business records only as a small bounded `LIMIT` sample (real/PII data — see
     `sf-graph-router` → "When the graph doesn't hold what the analysis needs").
   - Governor `LimitException` → hand to `sf-governor-risk-fix` scoped to the class to find
     the SOQL/DML-in-loop.

4. **Check what recently changed.** `sf-what-broke` (or `what_broke`) for the org since the
   last deploy/ingest — if the failing node or any node it depends on changed recently,
   that's your prime suspect. Correlate the failure's first-seen time with the change.

5. **Check test coverage of the suspect path** — `test_gap_intelligence_from_git_diff` (if a
   diff exists) or the `IS_TEST_FOR` edges — a path with no test is where regressions live.

6. **State a single hypothesis, then confirm it** against the graph before recommending a
   fix. "I think X because the graph shows Y." If the evidence doesn't support it, form a
   new hypothesis — don't stack speculative fixes.

## Staleness check

Call `staleness_check` first. A stale graph misleads root-cause analysis (the change that
caused the bug may not be ingested yet). If stale, warn and recommend
`sfgraph ingest --org <alias>` before trusting the upstream/recent-change steps.

## Response shape

- **Symptom** — the error/test/behaviour, anchored to a qname.
- **Evidence chain** — the graph facts that narrow the cause (callers, callees, competing
  automation, recent changes, coverage gaps), each tied to the tool that surfaced it.
- **Root-cause hypothesis** — one, with the supporting evidence. Confidence level.
- **Recommended fix** — described, not auto-applied; hand to `sf-architect-apex` /
  `sf-architect-ui` / `sf-governor-risk-fix` to design it, grounded in this evidence.
- **Mermaid** — optional: the failing path (caller → unit → callee/field) when it clarifies.

## Don't

- Don't propose a fix before anchoring the symptom to a real node and reading its source.
- Don't ignore competing automation — on object symptoms it's the most common root cause and
  the thing a stack trace alone never shows.
- Don't stack multiple speculative fixes; one hypothesis, confirmed, at a time.
- Don't edit code here — root-cause + evidence is the deliverable; design hands off.
- Don't trust a stale graph for "what recently changed" without flagging it.
