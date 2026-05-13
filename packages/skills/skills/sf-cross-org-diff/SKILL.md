---
name: sf-cross-org-diff
description: Compare metadata between two orgs (sandbox vs prod, two sandboxes) and summarise drift.
triggers:
  - "sandbox vs prod"
  - "what changed"
  - "org diff"
  - "compare orgs"
  - "drift"
tools_used:
  - cross_org_diff
  - point_in_time_diff
  - list_orgs
  - staleness_check
---

# sf-cross-org-diff

Use when the user wants to understand drift between two orgs — typically pre-deploy verification or post-deploy reconciliation.

## Playbook

1. Call `list_orgs` first. Present the user with the authenticated orgs, each org's `ingested` flag, last sync timestamp, and `stale` flag. Ask the user to pick the two orgs to compare. Refuse to proceed if either selected org has `ingested=false` — instruct them to run `sfgraph ingest --org <alias>` first.
2. Call `cross_org_diff(orgA, orgB)`. Capture added / removed / modified nodes grouped by metadata category.
3. For high-churn categories, call `point_in_time_diff` inside each org to confirm the drift originated there (vs being a stale snapshot artifact).
4. Categorise drift: **structural** (new objects/fields), **logic** (Apex, Flow body changes), **security** (profile / sharing), **config** (custom metadata / settings).
5. Render the Mermaid drift summary from the tool. For each category, list the top-N items by impact.
6. Recommend `sf-deployment-manifest` if the user wants to bring orgs into sync.

## Visualization

Render a **`flowchart LR`** drift summary. Two side-by-side subgraphs (one per org) joined by edges that classify drift (added / removed / modified). Use colour to indicate severity by metadata category.

```
flowchart LR
  subgraph A[orgA]
    A1[ApexClass:Foo]
  end
  subgraph B[orgB]
    B1[ApexClass:Foo']
  end
  A1 -->|modified| B1
  A2[Field:Account.X]:::removed -.->|absent| B
  classDef removed fill:#fdd,stroke:#900
```

For diffs with >50 nodes, switch to a bucketed table per category and skip the diagram.

## Staleness check

Before calling `cross_org_diff`, invoke `staleness_check` for both orgs. If either is stale, surface a warning to the user:

> Your ingest for `<alias>` is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Orgs compared** — `orgA -> orgB`.
- **Drift by category** — structural / logic / security / config, each with a count and top items.
- **Notable single-side items** — present in A only or B only.
- **Mermaid drift summary** — embedded.
- **Next step** — single line, typically pointing at deployment manifest skill.

## Don't

- Do not deploy or copy metadata between orgs from this skill.
- Do not assume `orgA` is "source of truth"; report drift symmetrically.
- Do not include freshness drift (last-modified-by user) in the structural bucket — call it out separately.
- Do not run if either org has not been ingested; instruct the user instead.
