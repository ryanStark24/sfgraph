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
---

# sf-dead-code-audit

Use when the user wants to inventory metadata that appears unreferenced. Output must be bucketed by confidence — deletion in Salesforce is reversible only via backup, so we communicate uncertainty.

## Playbook

1. Call `dead_code_audit` over the user's chosen scope (entire org, single namespace, or one metadata category). Capture every candidate plus the evidence the tool used (no incoming edges, no inclusion in deploy manifests, etc.).
2. Call `freshness_report` to layer last-touched timestamps onto each candidate. Stale + unreferenced is stronger evidence than unreferenced alone.
3. For any candidate the user names interactively, call `trace_upstream` to confirm absence of indirect callers (dynamic Apex, Flow lookups, callable interfaces).
4. Sort candidates into three buckets:
   - **confident-dead** — no incoming edges, no dynamic-invocation signature match, freshness > 12 months, no inclusion in active permission sets / page layouts.
   - **likely-dead** — no incoming edges, but at least one weak signal (recently modified, referenced from a managed package boundary, or named in a metadata file we don't parse fully).
   - **suspicious-uncertain** — looks dead but the graph has known blind spots (dynamic SOQL string-interpolated field name, reflection-style `Type.forName`, external system reference).
5. Render the Mermaid bar-chart / treemap returned by the tool grouped by category.
6. For confident-dead items, propose a destructive-changes.xml snippet but do not save it. The user owns the delete decision.

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
