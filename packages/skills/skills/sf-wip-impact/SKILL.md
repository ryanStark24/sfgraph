---
name: sf-wip-impact
description: Dry-run the impact of uncommitted local changes against the org graph before you commit.
triggers:
  - "dry-run this change"
  - "what would this PR do"
  - "local impact"
  - "uncommitted changes"
  - "wip impact"
tools_used:
  - wip_impact
  - wip_test_gap
  - wip_diff
  - staleness_check
---

# sf-wip-impact

Use when the user has local edits they haven't committed yet (working tree, staged or unstaged) and wants to see the downstream blast radius and test gaps before deciding whether to commit or push.

## Playbook

1. Confirm the project root. Default to the current working directory; if the user explicitly names another, use that.
2. Call `staleness_check` for the org linked to this project. Warn if stale.
3. Call `wip_impact` with default `depth=3`. Capture changed nodes, added nodes (in `full-folder` mode), removed nodes, and the downstream dependent set.
4. Call `wip_test_gap` to find which impacted nodes have no Apex test coverage. These are the "at risk" set.
5. Optionally call `wip_diff` for a node-level diff (attribute level) when the user asks "what specifically changed in this file".
6. Summarise: `changed N`, `added M` (full-folder mode only), `removed K`, `at_risk J without tests`.

## Visualization

Render a **`flowchart LR`** impact graph using the 4-class palette emitted by `wip_impact`:

- `changed` (yellow): the file you edited
- `added` (green): new nodes
- `removed` (red, dashed): nodes your diff deletes
- `dependent` (grey): downstream nodes your change reaches

```
flowchart LR
  W1[ApexClass:AccountSvc]:::changed --> D1[ApexClass:AccountCtl]:::dependent
  W1 --> D2[Flow:Account_OnUpdate]:::dependent
  W2[ApexClass:NewHelper]:::added
  W3[ApexClass:OldClass]:::removed
  classDef changed fill:#ffd
  classDef added fill:#cfc
  classDef removed fill:#fdd,stroke-dasharray:4 4
  classDef dependent fill:#eee
```

If the dependent set exceeds 40 nodes, summarise per category and skip the diagram.

## Staleness check

Before calling `wip_impact`, invoke `staleness_check` for the linked org. WIP analysis depends on the existing graph being accurate; a stale graph will under-report dependents. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **TL;DR** — `N changed`, `M added`, `K removed`, `J at-risk without tests`.
- **Changed nodes** — list with their downstream dependents grouped by edge type.
- **Test gaps** — bulleted list of impacted classes/methods lacking coverage.
- **Mermaid impact graph** — embedded.
- **Suggested next step** — typically `sf-impact-from-diff` after the user commits, or `sf-governor-risk-fix` if Apex was touched.

## Don't

- Do not commit, stage, or modify any file — this skill is read-only against the working tree.
- Do not extrapolate beyond `depth=3` without the user asking; transitive depth >3 tends to be noise.
- Do not skip `wip_test_gap`; the gap surface is the main reason to run this skill.
- Do not pretend coverage exists for added nodes — they cannot have tests yet by definition; flag them explicitly.
