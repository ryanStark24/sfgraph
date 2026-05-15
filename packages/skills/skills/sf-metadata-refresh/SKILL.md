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
2. If stale, call `start_ingest_job` — it does NOT run the ingest. It returns
   `{ executed: false, run_this_command: "sfgraph ingest --org <alias>" }`.
   Surface that command verbatim to the user. Do not promise the MCP server
   will run it. After the user has executed the ingest in a shell, MCP tools
   will see the new data on their next invocation.
3. Suggest the right shape of the command for their situation:
   - For their default org: `sfgraph ingest`
   - For a named alias: `sfgraph ingest --org <alias>`
   - For **multiple orgs** in one run: `sfgraph ingest --orgs prod,uat,qa` (sequential) or add `--parallel` to fan them out concurrently.
   - For **every authenticated org**: `sfgraph ingest --all` (add `--parallel` to refresh them all at once).
   - For a **clean rebuild from scratch** (when the graph has drifted or parser logic changed): `sfgraph ingest --rebuild --org <alias>` (existing graph moves to `backups/`; pair with `--no-backup` to delete instead).
   - On **production orgs without Source Tracking**, add `--detect-deletions` so qnames that disappeared upstream get removed during the full sync.
   - If the user just changed `sf` CLI state (logged into a new org, renamed an alias, or ran `sf config set target-org=…`), tell them to run **`sfgraph refresh-orgs`** before any sfgraph workflow — that re-snapshots `~/.sf/` into `<dataDir>/orgs-snapshot.json` so the MCP child (running in a sandbox that can't read `~/.sf/` directly) sees the new aliases / default-org. This command does NOT touch the graph or MCP config; it only refreshes the alias snapshot.
4. `get_ingest_job` only returns historical CLI runs the MCP process happened to observe in-memory; it has no relationship to `start_ingest_job` anymore. Use it only if the user asks about a prior run.
5. Call `freshness_report` to surface dead/stale metadata in the org itself (not the graph) — Apex classes/Flows/LWCs/objects that haven't been touched in months. This explains _what content might be old_ even after the graph is refreshed.
6. Bucket the `freshness_report` output into hot / current / stale / dead and call out the worst offenders.

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

- Do not run the ingest yourself via the shell. The user must execute `sfgraph ingest`; `start_ingest_job` returns the command, not a running job.
- Do not conflate graph staleness (ingest timestamp) with org-side freshness (metadata last-modified) — they're independent signals.
- Do not draw a Mermaid diagram for this skill. Timestamps + commands beat shapes.
- Do not silently skip `freshness_report` even when the graph is fresh — org-side rot is still useful signal.
