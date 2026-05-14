---
name: sf-deployment-manifest
description: Generate a package.xml deployment manifest covering a change set and its required dependencies.
triggers:
  - "deployment manifest"
  - "package.xml"
  - "what do I need to deploy"
  - "build manifest"
  - "deploy plan"
tools_used:
  - deployment_manifest_gen
  - cross_org_diff
  - staleness_check
---

# sf-deployment-manifest

Use when the user wants a `package.xml` that captures a set of changes plus everything they transitively depend on for a successful deploy.

## Playbook

1. Establish the source and target orgs. The tool's contract today is a strict cross-org diff: it inputs `from_org` (source) and `to_org` (target) and emits the metadata that exists in `from_org` but is missing or different in `to_org` (plus a `destructiveChanges.xml` for things present only in `to_org`).
2. Optionally call `cross_org_diff` first to preview the set difference before generating the manifest XML.
3. Call `deployment_manifest_gen` with `from_org` + `to_org` (+ optional `category` filter). The tool does NOT currently walk `DEPENDS_ON` edges — it returns the set difference as `package.xml` / `destructiveChanges.xml`. Dependency-closure walking is planned future work; for now the user is responsible for any additional parent metadata not surfaced by the diff.
4. Inspect the result for ambiguous dependencies (managed-package types, namespace mismatches) and surface them as warnings.
5. Emit the `package.xml` inside a fenced code block. Also emit `destructiveChanges.xml` if the diff includes removals.
6. If extra dependencies are needed beyond the raw diff, ask the user to extend the set manually — do not silently fabricate dependency edges the graph doesn't have.

## Visualization

Render a **`flowchart LR`** dependency closure graph. The user's explicit change set is one subgraph; auto-pulled dependencies are another. Edge labels carry the dependency reason (`parent-of`, `layout-for`, `required-permission`).

```
flowchart LR
  subgraph Requested
    F[Field:Account.Tier__c]
  end
  subgraph Closure
    O[CustomObject:Account]
    L[Layout:Account-Layout]
  end
  F -->|parent-of| O
  F -->|layout-for| L
```

If the closure expands past 60 nodes, summarise per metadata type and only render the diagram for the top 20 — beyond that the graph becomes unreadable.

## Staleness check

Before calling `deployment_manifest_gen`, invoke `staleness_check` for the source org. A stale graph means missing dependencies in the manifest, which fail at deploy time. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Source set** — what was requested.
- **Closure additions** — what was pulled in by dependency traversal, grouped by metadata type.
- **Warnings** — managed-package / namespace / ambiguous-dependency notes.
- **package.xml** — fenced code block.
- **destructiveChanges.xml** — fenced code block (only if applicable).
- **Mermaid dependency graph** — embedded.

## Don't

- **Never deploy.** This skill emits XML; the user runs `sf project deploy start`.
- Do not silently include managed-package types as deployable — flag them.
- Do not omit API version; default to the source org's API version unless the user overrides.
- Do not write the XML to disk on the user's behalf. They paste it where they want it.
