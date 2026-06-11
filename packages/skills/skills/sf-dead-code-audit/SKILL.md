---
name: sf-dead-code-audit
description: Identify unused Apex / LWC / Flow / fields with confidence buckets and freshness signals.
triggers:
  - "dead code"
  - "unused apex"
  - "unused fields"
  - "what can I delete"
  - "cleanup audit"
tools_used:
  - dead_code_audit
  - freshness_report
  - trace_upstream
  - staleness_check
  - find_similar
---

# sf-dead-code-audit

Use when the user wants to inventory metadata that appears unreferenced. Output must be bucketed by confidence — deletion in Salesforce is reversible only via backup, so we communicate uncertainty.

## Evidence rule — say it only if something backs it

State a fact about this org or the Salesforce platform **only when evidence backs it**: a tool/graph result, source you actually read (local sfdx file or an org fetch), a live org query, or official Salesforce documentation. If you don't have that, say so plainly — "the graph doesn't show this", "unverified", "I'd need to check the org" — and either go get the evidence or stop. **Never fill the gap with a plausible-sounding guess**: an invented field/method/object name, an assumed dependency, or a governor number recalled from memory. Label each claim as **graph-confirmed** (a tool returned it), **inferred** (you reasoned it from graph facts — say which facts), or **general Salesforce knowledge**. For platform behaviour — governor limits, order of execution, sharing/FLS semantics, API rules — cite the official doc (developer.salesforce.com; fetch it if unsure) instead of asserting from memory. If the graph is stale or the org was never ingested, lead with that caveat — your grounding may be wrong.

## Playbook

1. Call `dead_code_audit` for the org. The tool **summarizes by confidence (`high`/`medium`/`low`) and by metadata type**, then renders a capped list (`limit`, default 50). On a large org there can be thousands of candidates — do NOT try to retrieve them all inline; work from the summary counts and drill in with `confidence: "high"` (most-likely-dead first) or raise `limit`. For the complete machine-readable set, use `export_sarif`. Each row carries a score + reasons (`no_incoming_edges`, `stale_freshness`).
2. Call `freshness_report` to layer last-touched timestamps onto each candidate. Stale + unreferenced is stronger evidence than unreferenced alone.
3. For any candidate the user names interactively, call `trace_upstream` to confirm absence of indirect callers (dynamic Apex, Flow lookups, callable interfaces). Optionally call `find_similar(qname=<candidate>, k=5)` — if the candidate has near-neighbours (similarity > 0.6) that ARE referenced, the candidate may be a copy-paste duplicate of live code and worth deleting; if every neighbour is also in the dead list, you've found a whole disused subsystem worth flagging as a group.
4. Sort candidates into three buckets:
   - **confident-dead** — no incoming edges, no dynamic-invocation signature match, freshness > 12 months, no inclusion in active permission sets / page layouts.
   - **likely-dead** — no incoming edges, but at least one weak signal (recently modified, referenced from a managed package boundary, or named in a metadata file we don't parse fully).
   - **suspicious-uncertain** — looks dead but the graph has known blind spots (dynamic SOQL string-interpolated field name, reflection-style `Type.forName`, external system reference).
5. Render a bar-chart / treemap as Mermaid yourself, grouped by category, from the tool's `byConfidence` / `byLabel` counts — the tool returns a table + structured data, not a diagram.
6. For confident-dead items, propose a destructive-changes.xml snippet but do not save it. The user owns the delete decision.

## Visualization

Render a **`flowchart TD`** treemap-style grouping. Top-level nodes are metadata categories (ApexClass, LWC, Flow, Field); under each, sub-nodes are the three confidence buckets, sized loosely by item count. Avoid drawing the dead items themselves — the table carries that detail.

```
flowchart TD
  Root --> Apex
  Apex --> A_conf[confident-dead: 12]:::conf
  Apex --> A_likely[likely-dead: 8]:::likely
  Apex --> A_uncert[uncertain: 4]:::uncert
  classDef conf fill:#fcc
  classDef likely fill:#ffe6cc
  classDef uncert fill:#ffd
```

When the org has >100 dead candidates, drop the diagram and rely on the per-bucket tables — the chart becomes noise.

## Staleness check

Before calling `dead_code_audit`, invoke `staleness_check` for the target org. Stale ingests make dead-code analysis dangerously wrong (a recently-added caller would be invisible). If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Scope** — what was scanned (org id, category filter).
- **Bucket: confident-dead** — table of name / type / last-touched / evidence.
- **Bucket: likely-dead** — same shape.
- **Bucket: suspicious-uncertain** — same shape with the specific blind spot called out.
- **Mermaid summary chart** — embedded.
- **Proposed destructive-changes.xml** (confident bucket only, fenced block, not written to disk).

## Don't

- Do not collapse buckets. Confidence is the product here.
- Do not delete or stage anything. Output only.
- Do not include managed-package items as deletable.
- Do not skip the `trace_upstream` confirmation step for any item the user actually plans to remove.
