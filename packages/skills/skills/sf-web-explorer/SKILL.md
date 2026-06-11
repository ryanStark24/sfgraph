---
name: sf-web-explorer
description: Triggers when the user wants to visually explore the ingested graph — "show me the graph", "open the visualiser", "see the relationships", "open the web view", "let me click around".
triggers:
  - "show me the graph"
  - "open the visualiser"
  - "open the web view"
  - "see the relationships visually"
  - "render the whole org"
tools_used: []
when_to_use: Visual exploration of an ingested org. Pairs with `analyze_field`, `trace_upstream`, `trace_downstream`, and `cross_layer_flow_map` when the markdown answers are not enough and the user wants to click around.
---

# sf-web-explorer

The MCP tool surface is great for answering specific questions, but sometimes the user wants to **see** their org — pan, zoom, follow edges by eye. `sfgraph serve` boots a local web visualiser at `http://localhost:7777` for exactly this.

This skill does not call any MCP tool. It instructs the user how to launch the viewer and what to do once it's open.

## Evidence rule — say it only if something backs it

State a fact about this org or the Salesforce platform **only when evidence backs it**: a tool/graph result, source you actually read (local sfdx file or an org fetch), a live org query, or official Salesforce documentation. If you don't have that, say so plainly — "the graph doesn't show this", "unverified", "I'd need to check the org" — and either go get the evidence or stop. **Never fill the gap with a plausible-sounding guess**: an invented field/method/object name, an assumed dependency, or a governor number recalled from memory. Label each claim as **graph-confirmed** (a tool returned it), **inferred** (you reasoned it from graph facts — say which facts), or **general Salesforce knowledge**. For platform behaviour — governor limits, order of execution, sharing/FLS semantics, API rules — cite the official doc (developer.salesforce.com; fetch it if unsure) instead of asserting from memory. If the graph is stale or the org was never ingested, lead with that caveat — your grounding may be wrong.

## Playbook

1. Confirm the org has been ingested (use `staleness_check` if uncertain).
2. Tell the user to run `sfgraph serve` in a shell. It auto-opens their default browser. Mention `--no-open` if they want to suppress that, and `--port <N>` for an alternate port.
3. Walk them to the right tab:
   - **Trace** — for following the dependency neighborhood of a single node. Best after running `trace_upstream` / `trace_downstream` in chat and wanting to keep exploring.
   - **Overview** — for "what does this org look like at a glance" — hubs, layer counts, freshness.
   - **Schema** — for SObject / field topology and cross-layer references.
   - **"Render entire org" button** — for the full 3D force-graph (Obsidian-style). Useful for getting your bearings on an unfamiliar org.
4. Surface the keyboard shortcuts up front: `L` toggles always-show labels, `F` fits the graph, `Esc` closes panels.

## Suggested workflows

- **Following a field across layers.** Run `analyze_field` in chat → switch to the Schema tab in the web view → pivot to "Render entire org" if you need broader context. The web view's labels for hubs stay visible at any zoom so you don't lose your place.
- **Onboarding to a new org.** Open the Overview tab first. Identify the top hubs by degree. Then jump to Trace tab on each hub to see what depends on them.
- **Visualising a `cross_layer_flow_map` result.** The markdown gives you the paths; the Trace tab gives you the picture. Both are useful side-by-side.

## Visualization

No diagram from the skill itself — the visualiser **is** the visualisation. Render a short markdown checklist with the launch command and the tab/shortcut cheatsheet.

```
- Launch: `sfgraph serve`  (or `sfgraph serve --no-open`)
- URL:    http://localhost:7777
- Tabs:   Trace · Overview · Schema · [Render entire org]
- Keys:   L = labels · F = fit · Esc = close panels
```

## Security note

The server binds to loopback only by default. Anything else requires `--i-understand-public-bind`. Do not suggest exposing it publicly unless the user explicitly asks.

## Don't

- Do not try to call an MCP tool to "open" the viewer — it's a separate process the user launches in their shell.
- Do not promise screenshots; this skill doesn't render. The browser does.
- Do not skip the security note when suggesting non-default flags.
