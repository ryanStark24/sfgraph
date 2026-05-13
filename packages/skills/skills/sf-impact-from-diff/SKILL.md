---
name: sf-impact-from-diff
description: Compute downstream blast radius and test-coverage gaps for a git diff before merge.
triggers:
  - "what does this PR break"
  - "impact of this diff"
  - "before I merge"
  - "blast radius"
  - "what does this change affect"
tools_used:
  - impact_from_git_diff
  - test_gap_intelligence_from_git_diff
  - staleness_check
---

# sf-impact-from-diff

Use when the user wants to understand the downstream consequences of a pending change in their working tree (uncommitted or branch-vs-base) before merging.

## Playbook

1. Confirm the diff source: working tree, staged, or a branch range (e.g. `origin/main...HEAD`). If unspecified, default to staged + unstaged against the merge-base of `origin/main`.
2. Call `impact_from_git_diff` with the resolved diff scope. Expect a list of changed metadata nodes plus their downstream dependents grouped by edge type (`READS_FIELD`, `CALLS_METHOD`, `INVOKES_FLOW`, `RENDERS_COMPONENT`, …).
3. Call `test_gap_intelligence_from_git_diff` on the same diff scope. Cross-reference impacted nodes against existing Apex test coverage and surface the uncovered set.
4. Group findings by risk tier — **direct edits**, **first-degree dependents**, **transitive (depth ≥ 2)** — and call out anything that crosses metadata layers (LWC -> Apex -> Flow).
5. Render the Mermaid impact graph returned by the tool. If the impact set is large (>40 nodes), summarise by category and offer a follow-up call scoped to a single changed file.
6. If test gaps exist, list the specific impacted classes + methods that lack assertions, not just totals.

## Visualization

Render a **`flowchart LR`** impact graph. Changed nodes are leftmost (highlighted), first-degree dependents in the middle, transitive (depth >= 2) on the right. Edge style encodes edge type (`CALLS_METHOD`, `READS_FIELD`, `INVOKES_FLOW`, `RENDERS_COMPONENT`).

```
flowchart LR
  C[ApexClass:AccountSvc]:::changed --> D1[ApexClass:AccountCtl]
  C --> D2[Flow:Account_OnUpdate]
  D1 --> T1[LWC:accountList]
  classDef changed fill:#fcc,stroke:#900
```

When the impact set exceeds 40 nodes, summarise per category and offer the user a follow-up scoped to a single changed file before drawing the diagram.

## Staleness check

Before calling `impact_from_git_diff`, invoke `staleness_check` for the linked org. A stale graph will under-report dependents added since the last sync. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **TL;DR** — one sentence: N files changed, M dependents touched, K gaps.
- **Impact by tier** — direct / first-degree / transitive bullets with node names + types.
- **Test gaps** — bulleted list of `ClassName.methodName` not covered, with the impacted node that surfaced them.
- **Mermaid graph** — embedded from tool output.
- **Suggested follow-ups** — point at `sf-governor-risk-fix` or `sf-cross-layer-trace` if the change touches Apex or spans layers.

## Don't

- Do not "approve" or "reject" the diff. You report; the human decides.
- Do not auto-write tests or modify code. This skill is read-only.
- Do not silently truncate the dependent list — always say when results were capped.
- Do not run on a clean working tree without telling the user there is nothing to analyse.
