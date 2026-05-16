---
name: sf-explain-code
description: Explain a single Salesforce code unit (Apex method/class/trigger, LWC handler, Aura controller method) in plain English with conditional-branch annotation, then cache the explanation back to the sfgraph store. Salesforce metadata only — do NOT use for non-Salesforce code (e.g. Node, Python, ingest pipeline scripts) even when asked inside this repo. Scope is one named code unit; for end-to-end UI→DB tracing across layers use sf-cross-layer-trace, for whole-object schema views use sf-schema-overview.
triggers:
  - "explain this Apex method"
  - "explain this trigger"
  - "explain this LWC handler"
  - "what does <ApexClass.method> do"
  - "walk me through <qname>"
  - "annotate the conditionals"
tools_used:
  - explain_code
  - trace_upstream
  - trace_downstream
  - staleness_check
---

# sf-explain-code

Use this skill when the user wants a plain-English explanation of a specific code unit (an Apex method, an LWC handler, a trigger body). It reads the stored source via the graph's snippet store, generates an annotated explanation, and caches that explanation back so the next caller gets it for free.

## Playbook

1. **Resolve the target qname.** Most users say "explain `AccountSvc.calculate`" — that maps to the qname `ApexMethod:AccountSvc.calculate(N)` where N is the arity. If the arity is unknown or the name is ambiguous, call `trace_upstream` with a partial match to enumerate candidates and confirm with the user.
2. **`staleness_check`** for the linked org. If stale, surface a warning so the user knows the cached source may not reflect production.
3. **`explain_code(qname=X)`** — pull the stored snippet and any prior cached explanation. The tool returns the source text in a fenced code block.
4. **Generate the explanation**, structured as:
   - **One-paragraph summary**: what the method does at a high level.
   - **Annotated source block**: re-emit the source with terse `// → ...` comments after each conditional branch and each loop. Keep comments to one line.
   - **Side effects**: list any SOQL/DML found in the body, with target objects/fields. The reader needs to know what hits the database.
   - **Reaches** (optional): if the method clearly delegates to other code, call `trace_downstream(qname=X, depth=2)` and summarise what it touches.
5. **Cache the explanation back** via `explain_code(qname=X, annotation=<summary + annotated block>)`. This makes the next read of the same qname instant.

## Visualization

When the method has **more than two branches** (counting `if`, `else if`, `switch when`, and early `return` guards), render a `flowchart TD` of the conditional structure. Skip the diagram for straight-line code — it adds noise.

```
flowchart TD
  S[start] --> C1{isClosed?}
  C1 -- yes --> R1[return early]
  C1 -- no --> C2{amount > 0?}
  C2 -- yes --> A[apply tax]
  C2 -- no --> E[throw]
```

## Staleness check

Before reading the snippet, call `staleness_check` for the org. If the ingest is stale:

> Your ingest is N days old. The source you're explaining may not match production. Run `sfgraph ingest --org <alias>` to refresh.

Continue the playbook either way; just flag the risk.

## Response shape

- **TL;DR** — one sentence: "what this method does".
- **Annotated source** — fenced code block tagged with the source format.
- **Side effects** — SOQL/DML/callouts.
- **Mermaid** — only when conditional structure justifies it.
- **Cached** — confirm the explanation was cached back, with the qname.

## Don't

- Don't modify the source. This skill is read-only against the local graph.
- Don't write anything to Salesforce.
- Always render the source inside a fenced code block tagged with the `sourceFormat` returned by `explain_code` (`apex`, `js`, `html`, etc.).
- Don't fabricate behaviour — if the source is empty or stubbed, say so plainly.
