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
---

# sf-cross-org-diff

Use when the user wants to understand drift between two orgs — typically pre-deploy verification or post-deploy reconciliation.

## Playbook

1. Resolve the two org ids. Both must be already ingested. If one is missing, stop and instruct the user to run `sfgraph ingest --org <alias>`.
2. Call `cross_org_diff(orgA, orgB)`. Capture added / removed / modified nodes grouped by metadata category.
3. For high-churn categories, call `point_in_time_diff` inside each org to confirm the drift originated there (vs being a stale snapshot artifact).
4. Categorise drift: **structural** (new objects/fields), **logic** (Apex, Flow body changes), **security** (profile / sharing), **config** (custom metadata / settings).
5. Render the Mermaid drift summary from the tool. For each category, list the top-N items by impact.
6. Recommend `sf-deployment-manifest` if the user wants to bring orgs into sync.

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
