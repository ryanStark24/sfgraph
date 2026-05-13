---
name: sf-what-broke
description: Identify what regressed in an org since a recent deploy or snapshot using point-in-time diffs.
triggers:
  - "what broke"
  - "post-deploy regression"
  - "since deploy"
  - "what changed since last sync"
  - "regression triage"
tools_used:
  - what_broke
  - point_in_time_diff
---

# sf-what-broke

Use when the user is triaging a regression and wants to know which metadata changed between two points in time and which of those changes plausibly explains a reported failure.

## Playbook

1. Establish the two anchors: the "good" snapshot (pre-deploy, last green build, or named checkpoint) and the "bad" anchor (now, post-deploy, or a specific snapshot id). Ask if neither is obvious.
2. Call `point_in_time_diff` between the two anchors. Note added / removed / modified nodes and edge churn per layer.
3. Call `what_broke` with the same window plus the user's failure signal (failing test name, error stack, broken UI route). The tool ranks suspect changes by reachability to the failure signal.
4. Triage in descending suspicion order. For each suspect, summarise the change (what attribute moved) and the dependency path to the failure surface.
5. Render the Mermaid path-to-failure diagram returned by `what_broke`.
6. Recommend the smallest revert or follow-up investigation (e.g. "inspect `AccountTrigger.handleInsert` — its SOQL selector lost a filter between snapshot X and Y").

## Response Shape

- **Window** — from `<snapshot/anchor>` to `<snapshot/anchor>`.
- **Top suspects** — ordered list with confidence, change summary, and the edge path linking them to the failure.
- **Other changes in window** — collapsed bullet list, not the focus.
- **Mermaid path-to-failure** — embedded from tool output.
- **Next step** — single concrete recommendation.

## Don't

- Do not propose a code fix without first inspecting the suspect change in detail via `sf-cross-layer-trace`.
- Do not run write operations against the org. This skill only reads the local graph + snapshots.
- Do not bury the lead — top suspect goes first, not last.
- Do not invent snapshots that don't exist; if the "good" anchor is unavailable, say so.
