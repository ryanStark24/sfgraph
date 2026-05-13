---
name: sf-flow-impact
description: Find every Flow / Process Builder / workflow that reads or writes a given field or object.
triggers:
  - "which flows use"
  - "flow impact"
  - "what flows touch"
  - "flow references"
  - "automation on this field"
tools_used:
  - analyze_field
  - trace_upstream
  - staleness_check
---

# sf-flow-impact

Use when the user asks which automation references a specific field or object — typically before a field rename, type change, or deletion.

## Playbook

1. Resolve the target. Call `analyze_field` for a single field; for an SObject, list its fields first and ask the user to narrow if the scope is large.
2. Filter the readers/writers from `analyze_field` to Flow-family node types: `Flow`, `ProcessBuilder`, `WorkflowRule`, `OmniProcess`.
3. Call `trace_upstream` on each Flow to surface what triggers it (record-triggered context, Apex `Invocable`, platform event, button).
4. Bucket results into **reads**, **writes**, **both**. Note whether each Flow is `Active`, `Draft`, or `Obsolete`.
5. Render the Mermaid field-to-flow diagram returned by the tool. If more than 20 flows reference the field, group by entry trigger type.
6. Call out compatibility risk: type changes break decision criteria; deletions break assignments.

## Visualization

Render a **`flowchart LR`** field-to-flow diagram. The target field is the central node; each Flow is a leaf node. Edge style encodes read (`-->`) vs write (`==>`); colour encodes Flow status (Active / Draft / Obsolete).

```
flowchart LR
  F[(Account.Tier__c)]
  F --> Fl1[Flow:Account_OnUpdate]:::active
  F ==> Fl2[Flow:Account_BeforeInsert]:::active
  F --> Fl3[Flow:Account_Legacy]:::obsolete
  classDef active fill:#cfc
  classDef obsolete fill:#eee,stroke-dasharray:3 3
```

If more than 20 flows reference the field, group leaves by entry-trigger type and render at the group level rather than per-flow.

## Staleness check

Before calling `analyze_field`, invoke `staleness_check` for the target org. Newly-created or recently-modified Flows are invisible in a stale graph, which makes this skill produce false negatives. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Target** — `SObject.Field` or `SObject`.
- **Reads** — table of Flow name / status / entry trigger.
- **Writes** — same shape.
- **Both** — same shape.
- **Mermaid field-to-flow diagram** — embedded.
- **Compatibility risks** — bullets for type-change / delete / rename impacts.

## Don't

- Do not include Apex callers here; that belongs to `sf-cross-layer-trace`.
- Do not modify or activate / deactivate any Flow.
- Do not skip Draft / Obsolete flows by default — call them out separately instead.
- Do not assume `analyze_field` covers Apex-generated dynamic field references; flag the limitation.
