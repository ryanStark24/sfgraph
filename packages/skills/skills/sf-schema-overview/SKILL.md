---
name: sf-schema-overview
description: Build an ERD-style overview of one or more SObjects and how they relate across Apex, Flow, and LWC layers.
triggers:
  - "show the schema"
  - "object model"
  - "data model"
  - "how are these objects related"
  - "ERD"
  - "field map for"
tools_used:
  - analyze_field
  - trace_upstream
  - trace_downstream
  - staleness_check
---

# sf-schema-overview

Use when the user wants a high-level picture of the data model — which objects exist in a domain, how they connect via Lookup/MasterDetail, and which Apex/Flow/LWC artifacts depend on them.

## Playbook

1. Identify the focal object(s) from the user's question. If they named a domain ("the Order schema"), pick the lead object and include its first-degree neighbours.
2. Call `staleness_check` for the org. Warn if stale.
3. For each focal object, call `trace_downstream` with `qname=CustomObject:<name>` to enumerate Lookup/MasterDetail references coming out of it.
4. Call `trace_upstream` for the same object to find what depends on it (Apex selectors, Flows, LWCs, layouts).
5. If the user named a specific field, call `analyze_field` to get its readers/writers and a precise role description.
6. Produce an ERD-like diagram with one entity per object and relationship lines for each Lookup/MasterDetail edge.

## Visualization

Render an **`erDiagram`**. One entity per object; relationship cardinality from Lookup (`||--o{`) vs MasterDetail (`||--|{`). Fall back to a **`flowchart LR`** if the client renderer doesn't support `erDiagram`.

```
erDiagram
  Account ||--o{ Contact : "has"
  Account ||--o{ Opportunity : "has"
  Opportunity }o--|| Pricebook2 : "uses"
```

When the schema has >20 entities, prune to the focal object's two-hop neighbourhood — a sprawling ERD is unreadable. State that you pruned, and offer to expand on request.

## Staleness check

Before tracing, invoke `staleness_check` for the org. New custom objects/fields and recently-added relationships are invisible in a stale graph. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Focal objects** — the object(s) the diagram is centred on.
- **Entities** — one bullet per object with its key fields (highest-arity fields first).
- **Relationships** — table: source object / target object / type (Lookup/MasterDetail) / required.
- **Cross-layer consumers** — bullets per object naming the Apex classes, Flows, and LWCs that touch it.
- **Mermaid ERD** — embedded.
- **Suggested next skill** — typically `sf-cross-layer-trace` for any field the user asks about in detail.

## Don't

- Do not include every field on every object — pick highest-arity or user-named ones. ERDs that list 200 fields are useless.
- Do not infer relationships from name match; only use edges from `trace_downstream`/`trace_upstream`.
- Do not modify the schema. This is pure read.
- Do not skip the cross-layer consumer summary — the value of this skill over a raw ERD is the layer context.
