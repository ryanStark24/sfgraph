---
name: sf-governor-risk-fix
description: Detect governor-limit risks (SOQL/DML in loops, unbounded queries) and produce a remediation checklist.
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

## Playbook

1. Call `governor_risk_check` over the requested scope (single class, namespace, or full org). The tool returns risk records with rule id (`SOQL_IN_LOOP`, `DML_IN_LOOP`, `UNBOUNDED_QUERY`, `NON_SELECTIVE_QUERY`, `CALLOUT_IN_LOOP`, `LARGE_HEAP`, `RECURSIVE_TRIGGER`), location (class + method + line), and severity.
2. Group findings by rule id; within each group, sort by call-site fan-in (more callers = higher blast radius).
3. For each finding, describe the canonical fix pattern (e.g. "extract the SOQL above the loop and key the result by `Id`") in one or two sentences — do not write the code.
4. Render the Mermaid heat-map (class-by-rule) from the tool response.
5. Produce a checklist the user can copy into a ticket: `- [ ] ClassName.methodName:line — rule — recommended pattern`.
6. Recommend `sf-impact-from-diff` after the user applies fixes, to verify nothing downstream regressed.

## Visualization

Render a **`flowchart TD`** heat-map: rows are Apex classes (top N by fan-in), columns are rule ids. Cell colour encodes severity (high/medium/low). When the tool returns its own Mermaid heat-map, embed that and skip this template.

```
flowchart TD
  ClassA -->|SOQL_IN_LOOP: high| Risk1[:::hi]
  ClassA -->|UNBOUNDED_QUERY: med| Risk2[:::med]
  ClassB -->|DML_IN_LOOP: high| Risk3[:::hi]
  classDef hi fill:#fcc,stroke:#900
  classDef med fill:#ffe6cc,stroke:#c60
```

If the scan returns >50 findings, render only the top-10-by-fan-in row and link to the full table — a wall of cells doesn't help triage.

## Staleness check

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
- Do not invent additional rules; only report what `governor_risk_check` returns.
- Do not silently exclude managed-package code; mention it was filtered out if so.
