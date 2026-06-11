---
name: sf-what-broke
description: Identify what regressed in a SINGLE org since a recent deploy or sync — post-deployment regression triage. Use when the user reports something stopped working after a deploy, or asks what changed since the last ingest. For comparing two distinct orgs use sf-cross-org-diff; for arbitrary point-in-time snapshot comparison use sf-snapshot-compare.
triggers:
  - "what broke after the deploy"
  - "post-deploy regression"
  - "since the last deploy"
  - "what changed since last sync"
  - "regression triage"
tools_used:
  - what_broke
  - point_in_time_diff
  - staleness_check
---

# sf-what-broke

Use when the user is triaging a regression and wants to know which metadata changed since a recent deploy/sync, and which of those changes have **untested dependents** (the likely break surface).

**What the tool actually does (and doesn't):** `what_broke(org, since?)` compares the current graph against the latest pre-sync snapshot (or the `since` you pass), finds the changed nodes, and buckets their dependents as **at-risk** (no test coverage) vs **covered**. It does NOT take a failing-test/stack "failure signal", does NOT rank by reachability to a specific failure, and does NOT emit a path-to-failure diagram. If the user has a concrete failure (a specific exception or failing test), route that to **`sf-debug-root-cause`** (symptom → graph cause) or **`sf-debug-log-analysis`** — then come back here for the "what changed in the window" picture.

## Evidence rule — say it only if something backs it

State a fact about this org or the Salesforce platform **only when evidence backs it**: a tool/graph result, source you actually read (local sfdx file or an org fetch), a live org query, or official Salesforce documentation. If you don't have that, say so plainly — "the graph doesn't show this", "unverified", "I'd need to check the org" — and either go get the evidence or stop. **Never fill the gap with a plausible-sounding guess**: an invented field/method/object name, an assumed dependency, or a governor number recalled from memory. Label each claim as **graph-confirmed** (a tool returned it), **inferred** (you reasoned it from graph facts — say which facts), or **general Salesforce knowledge**. For platform behaviour — governor limits, order of execution, sharing/FLS semantics, API rules — cite the official doc (developer.salesforce.com; fetch it if unsure) instead of asserting from memory. If the graph is stale or the org was never ingested, lead with that caveat — your grounding may be wrong.

## Playbook

1. **`staleness_check`** first (see below).
2. Call **`what_broke`** with the org (and `since` if the user has a specific baseline; otherwise it uses the latest pre-sync snapshot). If it reports no baseline snapshot, tell the user and fall back to `point_in_time_diff` / `sf-snapshot-compare` with an explicit anchor.
3. Read the result: the changed nodes, and their dependents split into **at-risk** (no tests — highest priority) and **covered**.
4. Triage at-risk first: for each, summarise what changed and what depends on it. To see the full dependency chain to a UI/test surface, hand the node to `sf-cross-layer-trace` or `trace_upstream`.
5. For a deeper field-level diff between two points, call **`point_in_time_diff`** (or `sf-snapshot-compare`) — that's where the detailed add/remove/modify per layer lives.
6. Recommend the smallest next step (revert a specific change, or add a test to an at-risk dependent before re-deploying).

## Visualization

`what_broke` returns tables, not a diagram. If a visual helps, build a simple **`flowchart LR`** yourself from the at-risk set: changed node → its untested dependents. Don't claim the tool emitted it.

```
flowchart LR
  C1[ApexClass:AccountTrigger]:::changed --> D1[ApexClass:AccountSvc]:::atrisk
  C1 --> D2[Flow:AccountAfterUpdate]:::atrisk
  classDef changed fill:#fee,stroke:#c00
  classDef atrisk fill:#fcc,stroke:#900,stroke-width:2px
```

## Staleness check

Before calling `what_broke`, invoke `staleness_check` for the target org. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Window** — current vs the baseline snapshot `what_broke` used (or the `since` anchor).
- **At-risk changes** — changed nodes whose dependents have no test coverage, first.
- **Covered changes** — changed nodes whose dependents are tested, briefly.
- **Next step** — single concrete recommendation (revert, or add coverage to an at-risk dependent).

## Don't

- Do not tell the user you passed a failing test / stack to `what_broke` — it has no such parameter. Route concrete failures to `sf-debug-root-cause`.
- `what_broke` DOES emit a dependency-graph Mermaid alongside its tables — embed the tool's diagram directly; don't claim it returns tables only, and don't redraw it from scratch.
- Do not propose a code fix without first inspecting the suspect change via `sf-cross-layer-trace`.
- Do not run write operations against the org. This skill only reads the local graph + snapshots.
- Do not invent snapshots that don't exist; if no baseline is available, say so and use an explicit anchor.
