---
name: sf-snapshot-compare
description: Compare two sfgraph snapshots (or one snapshot against current) to see what changed point-in-time.
triggers:
  - "compare snapshots"
  - "what changed between these snapshots"
  - "point in time diff"
  - "rewind"
  - "show me the state before"
tools_used:
  - snapshot_list
  - snapshot_create
  - point_in_time_diff
  - staleness_check
---

# sf-snapshot-compare

Use when the user wants to compare two named points in time — typically a pre-deploy checkpoint vs current, or two milestone snapshots taken during a release.

## Playbook

1. Call `snapshot_list` for the org. Present available snapshots with their `id`, `label`, `createdAt`, and `kind` (auto/manual).
2. If the user has not yet taken a snapshot, suggest `snapshot_create --label "before-X"` first and stop until they confirm.
3. Call `staleness_check` for the org. Warn if stale — note: even with a stale ingest, snapshot vs snapshot comparisons are still meaningful, but snapshot vs `current` would be stale-on-stale.
4. Call `point_in_time_diff(from=snapA, to=snapB | 'current')`. Capture nodes added / removed / changed grouped by metadata category.
5. Summarise totals by category. For each category, list the top items by impact (e.g. ApexClass changes ranked by fan-in).

## Visualization

Render a **`gitGraph`** showing the snapshot chain with annotated commits encoding added/removed/changed counts.

```
gitGraph
  commit id: "snap_pre-deploy"
  commit id: "snap_mid-sprint" tag: "+12 nodes"
  commit id: "current" tag: "+3 -1 ~5"
```

If `gitGraph` isn't supported by the client, fall back to a small **`flowchart LR`** with the two snapshots as nodes and a labelled edge carrying the change counts.

## Staleness check

Before calling `point_in_time_diff` with `to='current'`, invoke `staleness_check` for the org. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook. Snapshot-to-snapshot diffs are immune to staleness, but a snapshot-to-current diff inherits it.

## Response Shape

- **Snapshots compared** — `from` and `to` with labels + timestamps.
- **Totals** — `added N`, `removed M`, `changed K`.
- **Per-category** — table: metadata type / added / removed / changed.
- **Top changes** — bullet list per category, top 5 by fan-in.
- **Mermaid gitGraph** — embedded.
- **Suggested next skill** — typically `sf-what-broke` if the user is post-deploy triaging.

## Don't

- Do not auto-create snapshots without explicit user consent; `snapshot_create` mutates local state.
- Do not delete or rewrite snapshots; this skill is comparison-only.
- Do not silently truncate the change list — say when results were capped.
- Do not pretend a snapshot exists if it doesn't; check `snapshot_list` first.
