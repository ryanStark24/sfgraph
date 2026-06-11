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
  - find_similar
---

# sf-explain-code

Use this skill when the user wants a plain-English explanation of a specific code unit (an Apex method, an LWC handler, a trigger body). It reads the stored source via the graph's snippet store, generates an annotated explanation, and caches that explanation back so the next caller gets it for free.

## Playbook

1. **Resolve the target qname — it must be METHOD-level.** Snippets are stored only for Apex methods, so `explain_code` needs `ApexMethod:AccountSvc.calculate(N)` (N = arity), **not** a class qname like `ApexClass:AccountSvc` (that returns "No snippet stored"). If the user names a class, first enumerate its methods with `find_nodes(pattern="ApexMethod:AccountSvc.*")` and either pick the method they meant or explain each in turn. For declarative metadata (fields, objects, Flows) there is no snippet — redirect to `analyze_field` / `sf-cross-layer-trace` instead. If the arity is unknown or the name is ambiguous, use `find_nodes` to enumerate candidates and confirm with the user.
2. **`staleness_check`** for the linked org. If stale, surface a warning so the user knows the cached source may not reflect production.
3. **`explain_code(qname=X)`** — pull the stored snippet and any prior cached explanation. The tool returns the source text in a fenced code block.
   - **If the graph doesn't have the full source, FETCH it — don't explain from a stub.** The ingest stores source ONLY for Apex *methods*; it stores **no body for Apex triggers, no logic for Flows, and nothing for managed/`(hidden)` code**. When `explain_code` returns "No snippet stored", an empty body, or you need a trigger/Flow/whole-class that isn't in a snippet, get the real source in this order:
     1. **Local sfdx working tree** (fastest, reflects un-deployed changes) — read the file directly:
        - Apex class → `force-app/main/default/classes/<Name>.cls`
        - Apex trigger → `force-app/main/default/triggers/<Name>.trigger`
        - Flow → `force-app/main/default/flows/<Name>.flow-meta.xml`
        (the package dir may differ — check `packageDirectories` in `sfdx-project.json`).
     2. **Retrieve from the org** when there's no local copy: `sf project retrieve start -m "ApexTrigger:<Name>"` (or `ApexClass:<Name>` / `Flow:<Name>`), then read the retrieved file. For an Apex body without a project, `sf data query --use-tooling-api -q "SELECT Body FROM ApexClass WHERE Name='<Name>'"` (or `ApexTrigger`).
   - State which source you used (graph snippet / local file / org retrieve) so the reader knows whether it reflects production or local edits.
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

## Follow-up: "what else is like this?"

After delivering the explanation, offer a one-line follow-up:

> _Want me to find semantically similar code? I can run `find_similar` on this qname._

If the user says yes, hand off to `sf-find-similar` with mode=qname and the same qname. Don't pre-emptively run it — the embedding query takes a moment and the user may not want it. The chain is most useful when:

- The user is reviewing legacy code and wants to spot duplicates.
- The method does something domain-specific (taxes, compliance, pricing) and the user wants to find every place that handles the same concept.
- The agent already produced an explanation but the user wonders "is this the only place this logic lives?".

## Don't

- Don't modify the source. This skill is read-only against the local graph.
- Don't write anything to Salesforce.
- Always render the source inside a fenced code block tagged with the `sourceFormat` returned by `explain_code` (`apex`, `js`, `html`, etc.).
- Don't fabricate behaviour — if the source is empty or stubbed, say so plainly.
- Don't pass a class/trigger/field qname expecting source — only `ApexMethod:...(N)` has a snippet. On "No snippet stored", resolve to a method qname rather than reporting failure.
