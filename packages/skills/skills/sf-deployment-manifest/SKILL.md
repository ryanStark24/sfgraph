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
---

# sf-deployment-manifest

Use when the user wants a `package.xml` that captures a set of changes plus everything they transitively depend on for a successful deploy.

## Playbook

1. Establish the change set. Sources: a git diff, a `cross_org_diff` result, or an explicit list. If unspecified, ask.
2. Optionally call `cross_org_diff` between the source org and target org so the manifest excludes things already present in the target.
3. Call `deployment_manifest_gen` with the change set. The tool walks `DEPENDS_ON` edges and includes every member required for the deploy to succeed (parent objects for fields, layouts for record types, etc.).
4. Inspect the result for ambiguous dependencies (managed-package types, namespace mismatches) and surface them as warnings.
5. Emit the `package.xml` inside a fenced code block. Also emit `destructiveChanges.xml` if the change set includes removals.
6. Render the Mermaid dependency graph the tool returns so the user can sanity-check the closure.

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
