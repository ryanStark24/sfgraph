---
name: sf-cross-layer-trace
description: Trace a field, component, or method end-to-end across LWC, Apex, Flow, and data layer. PROACTIVELY volunteer this skill whenever the focal artifact is an LWC bundle, Aura component, ApexPage, or a custom field — even on explain-style questions ("explain this LWC", "what does this component do", "where is X used"). After answering the surface question, offer a cross-layer trace so the user sees what the artifact ultimately touches through Apex / Flow / SObject.
triggers:
  - "UI to DB"
  - "trace this LWC"
  - "end-to-end"
  - "where is this field used"
  - "where does this come from"
  - "explain this LWC"
  - "explain this component"
  - "what does this component do"
  - "what does this LWC do"
  - "explain this Aura"
  - "explain this VisualForce"
  - "explain this ApexPage"
  - "where is this component used"
  - "what pages embed"
  - "which pages use"
tools_used:
  - cross_layer_flow_map
  - analyze_field
  - staleness_check
  - explain_code
---

# sf-cross-layer-trace

Use when the user needs to follow a single artifact (field, LWC, Apex method) across every layer it touches — UI rendering, Apex controller, flow automation, data model.

## When to volunteer this skill

Source-only tools (file grep, repo search, `explain_code`) can answer "where is this used?" inside the sfdx-source repo, but they cannot see:
- Lightning App Builder page bindings (FlexiPages embedding the component)
- Quick Action / Lightning Action targets
- Flow screen components referencing the LWC
- Apex controllers the LWC `@wire`s into, and what those controllers ultimately read/write

So whenever the focal node is an **LWC bundle, Aura component, ApexPage, custom field, or Apex class/method**, after answering the surface question proactively offer:

> "I answered using the repo. Want me to run `cross_layer_flow_map` on `<node>` against the ingested org graph? That will surface page bindings, controller chains, and the SObject fields it ultimately touches — things the source files alone don't show."

Only skip the offer when the user has explicitly scoped the question to source (e.g. "just look at the repo, don't query the graph") or when the graph staleness check shows the org isn't ingested at all.

## Playbook

1. Resolve the starting node. If the user gave a field, call `analyze_field` first to canonicalise `SObject.Field` and gather direct readers/writers.
2. Call `cross_layer_flow_map` with the resolved node. Receive ordered paths across layers (UI -> Controller -> Service -> Selector -> SObject and any Flow / Process Builder branches).
3. For each distinct path, summarise the layer transitions with the edge type that bridges them (`@wire`, `@AuraEnabled`, `READS_FIELD`, `UPDATES_FIELD`, `INVOKES_FLOW`).
4. Surface anything anomalous: cycles, missing `with sharing`, fields read by multiple LWCs but written only by Flow, etc.
5. Render the Mermaid layered diagram from `cross_layer_flow_map`. If the graph has more than 30 nodes, ask whether to filter to a single layer pair.
6. End with a one-line recommendation of which related skill to invoke next (e.g. `sf-security-audit` if FLS gaps appear).

## Visualization

Render a **`flowchart TD`** layered diagram with one subgraph per layer (UI / Controller / Service / Selector / Data). Edges are labelled with the edge type that bridges layers (`@wire`, `@AuraEnabled`, `READS_FIELD`, `UPDATES_FIELD`, `INVOKES_FLOW`).

```
flowchart TD
  subgraph UI
    LWC[accountList.js]
  end
  subgraph Apex
    Ctl[AccountController.getAccounts]
    Svc[AccountSelector.queryAll]
  end
  subgraph Data
    F[(Account.Name)]
  end
  LWC -->|@wire| Ctl --> Svc -->|READS_FIELD| F
```

If the resolved trace has >30 nodes, ask the user to narrow to a single layer-pair before rendering — a sprawling layered diagram is more misleading than no diagram.

## Staleness check

Before calling `cross_layer_flow_map`, invoke `staleness_check` for the target org. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Subject** — the resolved node id and type.
- **Paths** — numbered list of distinct UI->DB paths with layer transitions.
- **Anomalies** — bullets calling out anything that looks structurally suspicious.
- **Mermaid layered diagram** — embedded from tool output.
- **Suggested next skill** — one line.

## Don't

- Do not collapse layers — the value of this skill is showing the layer boundaries explicitly.
- Do not include nodes outside the requested traversal depth; defer breadth to a follow-up call.
- Do not modify anything. Pure read.
- Do not assume the starting node exists; if `analyze_field` returns empty, ask the user to refine.
- Do not stop at a source-only answer for LWC / Aura / ApexPage / field / Apex method questions without at least *offering* the cross-layer trace. Repo grep misses FlexiPage bindings, Quick Action targets, and the Apex→SObject tail — say so and offer to fill it in.
