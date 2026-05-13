---
name: sf-metadata-refresh
description: Check sfgraph ingest staleness, surface dead/stale metadata in the org, and tell the user exactly how to refresh.
triggers:
  - "refresh the graph"
  - "is my data fresh"
  - "how do I update"
  - "sync the org"
  - "re-ingest"
tools_used:
  - staleness_check
  - freshness_report
  - start_ingest_job
  - get_ingest_job
---

# sf-metadata-refresh

Use when the user asks whether their sfgraph data is current, how to refresh it, or wants to see both graph staleness and org-side dead-metadata freshness.

## Playbook

1. Call `staleness_check` for the target org. Report the exact age in days and whether it's stale.
2. If stale, tell the user the exact CLI command to run:
   - For their default org: `sfgraph ingest`
   - For a named alias: `sfgraph ingest --org <alias>`
3. Optionally call `start_ingest_job` if the user explicitly wants to kick the ingest off from chat. Note that this only enqueues the job; the actual run happens out-of-band. Use `get_ingest_job` to poll progress if the user asks.
4. Call `freshness_report` to surface dead/stale metadata in the org itself (not the graph) — Apex classes/Flows/LWCs/objects that haven't been touched in months. This explains _what content might be old_ even after the graph is refreshed.
5. Bucket the `freshness_report` output into hot / current / stale / dead and call out the worst offenders.

## Visualization

**No diagram.** This skill is about timestamps and commands, not topology. Render a tight markdown checklist instead:

```
- Last ingest: 2024-05-01T08:12:33Z
- Age: 13 days  (STALE)
- Recommended action: refresh now
- Command: `sfgraph ingest --org prod`
- Then re-run the analysis you started.
```

Pair it with the bucketed freshness table from `freshness_report` for the org-side picture.

## Staleness check

`staleness_check` _is_ the first step here — the whole skill is the staleness check. If `staleness_check` returns `stale=false`, still continue to `freshness_report` so the user sees the org-side picture.

## Response Shape

- **Graph staleness** — checklist above.
- **Refresh command** — fenced one-liner the user can copy.
- **Org-side freshness** — bucketed table from `freshness_report` (hot / current / stale / dead with counts and top items).
- **Suggested next skill** — `sf-dead-code-audit` if the dead bucket is large.

## Don't

- Do not run the ingest yourself via the shell. The user must execute `sfgraph ingest`; you only enqueue via `start_ingest_job` if they ask.
- Do not conflate graph staleness (ingest timestamp) with org-side freshness (metadata last-modified) — they're independent signals.
- Do not draw a Mermaid diagram for this skill. Timestamps + commands beat shapes.
- Do not silently skip `freshness_report` even when the graph is fresh — org-side rot is still useful signal.
