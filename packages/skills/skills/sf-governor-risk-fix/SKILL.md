---
name: sf-governor-risk-fix
description: Detect governor-limit risks (SOQL, SOSL and DML in loops, triggers that are not bulk-safe, unbounded queries) and produce a remediation checklist.
triggers:
  - "governor limit"
  - "SOQL in loop"
  - "DML in loop"
  - "CPU time"
  - "heap"
  - "bulkification"
tools_used:
  - governor_risk_check
  - staleness_check
---

# sf-governor-risk-fix

Use when the user wants to find Apex code that risks hitting governor limits at scale. The skill produces a prioritised remediation checklist; it never rewrites Apex automatically.

## Evidence rule — say it only if something backs it

State a fact about this org or the Salesforce platform **only when evidence backs it**: a tool/graph result, source you actually read (local sfdx file or an org fetch), a live org query, or official Salesforce documentation. If you don't have that, say so plainly — "the graph doesn't show this", "unverified", "I'd need to check the org" — and either go get the evidence or stop. **Never fill the gap with a plausible-sounding guess**: an invented field/method/object name, an assumed dependency, or a governor number recalled from memory. Label each claim as **graph-confirmed** (a tool returned it), **inferred** (you reasoned it from graph facts — say which facts), or **general Salesforce knowledge**. For platform behaviour — governor limits, order of execution, sharing/FLS semantics, API rules — cite the official doc (developer.salesforce.com; fetch it if unsure) instead of asserting from memory. If the graph is stale or the org was never ingested, lead with that caveat — your grounding may be wrong.

## What the tool actually emits

`governor_risk_check` reports only the risk types the analyzer can prove from
the graph. Each record has `risk` (one of the kinds below), the method or trigger
qname, and evidence (the query text or DML target):

- **`soql_in_loop`** (high): a SOQL query whose `EXECUTES_SOQL` edge is tagged
  `inLoop` (AST-verified: the query sits inside a for/while/do-while body).
- **`sosl_in_loop`** (high): the same for SOSL (`EXECUTES_SOSL`).
- **`dynamic_soql_in_loop`** (high): `Database.query(...)` inside a loop.
- **`dml_in_loop`** (high): the same for DML statements.
- **`no_bulk`** (high): a trigger that doesn't iterate `Trigger.new` (body-scan path).
- **`unbounded_query`** (medium): a query with no `WHERE` and no `LIMIT`. Only the
  body-scan path (project ingests, where the full query text is available) emits it;
  live-org ingests do not, because the captured query head makes it pure noise.

Medium and above are listed by default; `min_severity: "high"` keeps only the loop and
bulk findings. `includeTests: true` adds test code. There is no class or namespace
parameter: the tool scans the whole org, so filter its findings to the scope the user
asked about, and say that you did.

The check is per method: SOQL in a method that is *called* from a loop is not flagged.
Say so when the user asks about a call chain.

Do **not** promise non-selective queries, callouts in loops, heap size or trigger
recursion: the tool does not check them.

**Live-ingest prerequisite:** `inLoop` tagging comes from the Apex AST parser. A
graph ingested before that parser change has zero `inLoop` edges, so the check
returns nothing. If `governor_risk_check` returns empty on an org you believe has
in-loop SOQL, the fix is a re-ingest (`sfgraph ingest --org <alias> --rebuild`),
not "the org is clean" — say so explicitly rather than reporting a false all-clear.

## Playbook

1. Call `governor_risk_check` for the org, then keep the findings in the requested scope (a class, a namespace, or the whole org). Records are keyed on the **method** qname (`ApexMethod:Class.method(n)`) or the trigger, with `risk` (one of the six kinds above) and evidence (the query text or DML target).
2. Group findings by `risk`; within each group, sort by call-site fan-in (more callers = higher blast radius). Use `trace_upstream` on the owning class to get fan-in.
3. For each finding, describe the canonical fix pattern (e.g. "extract the SOQL above the loop and key the result by `Id`") in one or two sentences — do not write the code. To actually design the bulkified fix, hand off to **`sf-architect-apex`** (or **`sf-architect-performance`** for LDV/query-plan work) with these call sites as grounding, so the rewrite respects the org's real selectors and trigger framework rather than a generic template.
4. Render a Mermaid heat-map (class-by-rule) yourself from the tool's table findings — `governor_risk_check` returns a table + structured data, not a diagram. See **Visualization**.
5. Produce a checklist the user can copy into a ticket: `- [ ] ClassName.methodName:line — rule — recommended pattern`.
6. Recommend `sf-impact-from-diff` after the user applies fixes, to verify nothing downstream regressed.

## Visualization

Render a **`flowchart TD`** heat-map: rows are Apex classes (top N by fan-in), columns are rule ids. Cell colour encodes severity (high/medium/low). Build it yourself from the tool's findings — `governor_risk_check` returns a table, not a diagram.

```
flowchart TD
  ClassA -->|soql_in_loop: high| Risk1[:::hi]
  ClassA -->|unbounded_query: med| Risk2[:::med]
  ClassB -->|dml_in_loop: high| Risk3[:::hi]
  classDef hi fill:#fcc,stroke:#900
  classDef med fill:#ffe6cc,stroke:#c60
```

If the scan returns >50 findings, render only the top-10-by-fan-in row and link to the full table — a wall of cells doesn't help triage.

## Staleness check

If `staleness_check` is not available (the server runs with `SFGRAPH_TOOLS=core`), skip this step and say the graph's freshness was not checked.

Before calling `governor_risk_check`, invoke `staleness_check` for the target org. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Summary counts** — total findings by severity (high / medium / low) and by rule.
- **Findings grouped by rule** — each finding: location, fan-in, recommended pattern.
- **Mermaid heat-map** — embedded.
- **Remediation checklist** — copy-pasteable Markdown checkboxes.

## Don't

- **Never auto-apply fixes.** This skill does not edit Apex.
- Do not flatten severities — the bucket ordering matters.
- Do not invent additional rules; only report what `governor_risk_check` returns (the six kinds above).
- Do not report "no governor risks" without first checking staleness — an empty result on a pre-AST-parser ingest means the graph lacks `inLoop` tags, not that the code is clean. Recommend a re-ingest.
- Do not silently exclude managed-package code; mention it was filtered out if so.
