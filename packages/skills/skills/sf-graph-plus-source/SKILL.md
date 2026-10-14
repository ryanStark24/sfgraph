---
name: sf-graph-plus-source
description: Use when you have file access AND sfgraph tools and the question is about references, flows, field usage, downstream reach or similar code. The graph gives the fast, complete-looking answer; this skill says what to double-check in the source before you finish, so graph speed and your own reading both count.
triggers:
  - "where is this used"
  - "trace downstream"
  - "analyze field"
  - "cross layer"
  - "find similar"
tools_used:
  - analyze_field
  - cross_layer_flow_map
  - trace_downstream
  - find_similar
---

# sf-graph-plus-source

The graph is the starting point, not the last word. Call the tool first, then spend a few file reads on the gaps below. Do not re-derive what the graph already returned.

## Recipe: analyze_field / who reads or writes a field
1. `analyze_field` for the field. Keep every component it lists.
2. Grep the source once for the field's API name (`Field__c`). Add a component only if you see the name written in its source (Apex, Flow, LWC, Vlocity JSON). Skip profiles, layouts and permission sets.

## Recipe: cross_layer_flow_map
1. Call `cross_layer_flow_map` and keep its whole chain.
2. Check each hop that crosses a layer boundary (LWC to Apex, Apex to Flow, Flow to Apex, OmniScript to Integration Procedure to DataRaptor). Grep for the hop's name; add a missing hop only when its source names the next component.

## Recipe: trace_downstream
1. Call `trace_downstream`. It is usually complete, and extras are the common error here.
2. Do not add components from a grep. Only remove or flag one when the source shows it is only mentioned in a comment or string that is not a real reference. Remember objects, fields, validation rules and named credentials are leaves.

## Recipe: find_similar
1. Call `find_similar`. Open the top few hits and keep only those that do the same job (same inputs and effect), not just similar names.

## Always
- Say which parts came from the graph and which you confirmed in source.
- If the two disagree, trust the source you actually read and say so in a short sentence.
- Keep the answer plain: lead with the finding, then one short line per component.
