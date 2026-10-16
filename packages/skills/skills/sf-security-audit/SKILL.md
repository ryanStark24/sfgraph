---
name: sf-security-audit
description: Audit FLS, CRUD, sharing, and profile/permission-set access for a field or object.
triggers:
  - "FLS"
  - "who has access"
  - "sharing rules"
  - "field-level security"
  - "permission audit"
  - "CRUD"
tools_used:
  - security_audit
  - analyze_field
  - staleness_check
---

# sf-security-audit

Use when the user asks about who can read or write a field/object, what sharing rules apply, or whether FLS / CRUD is consistent with intent.

## Evidence rule — say it only if something backs it

State a fact about this org or the Salesforce platform **only when evidence backs it**: a tool/graph result, source you actually read (local sfdx file or an org fetch), a live org query, or official Salesforce documentation. If you don't have that, say so plainly — "the graph doesn't show this", "unverified", "I'd need to check the org" — and either go get the evidence or stop. **Never fill the gap with a plausible-sounding guess**: an invented field/method/object name, an assumed dependency, or a governor number recalled from memory. Label each claim as **graph-confirmed** (a tool returned it), **inferred** (you reasoned it from graph facts — say which facts), or **general Salesforce knowledge**. For platform behaviour — governor limits, order of execution, sharing/FLS semantics, API rules — cite the official doc (developer.salesforce.com; fetch it if unsure) instead of asserting from memory. If the graph is stale or the org was never ingested, lead with that caveat — your grounding may be wrong.

## Playbook

1. Resolve the target. Call `analyze_field` if the user gave `SObject.Field`; otherwise treat as SObject-level. `analyze_field` takes **separate `object` and `field`** params (not a single `Account.Status` string) — split before calling.
2. Call `security_audit` with the resolved target (`object` / `field` to narrow; whole-org if neither). Capture full-access sharing rules and the FLS gap list.
   - **FLS gaps are pre-filtered** to FLS-relevant fields: Custom Metadata Type (`__mdt`), platform-event (`__e`), big-object (`__b`), and standard system/audit fields (Id, CreatedById, SystemModstamp, …) are excluded as noise. The response notes `+N CMDT/system fields hidden`. Only pass `include_non_fls_fields: true` if the user explicitly wants that raw set — never lead with it.
   - The inline gap list is capped (`limit`, default 30). Narrow with `object`, or raise `limit`, rather than dumping thousands of rows.
3. Build the field access matrix: for one field, the report lists every profile and permission set that grants read or edit ("Granted by"); a profile or permission set whose entry denies access is not counted. Run the audit per field you need in the matrix.
4. Report sharing exposure from what the tool returns: the sharing rules that give edit or full access. The tool does **not** report org-wide defaults, the role hierarchy, object CRUD per profile, or `without sharing` Apex; say so, and check those in the source or the org if the user needs them (label them as not graph-confirmed).
5. Flag risks you can back with evidence: full-access sharing rules and FLS gaps from the tool; `without sharing` classes, missing `stripInaccessible` / `WITH SECURITY_ENFORCED`, guest user and Experience Cloud reach only from source you read.
6. Render the access matrix as Mermaid yourself from the report's "Granted by" lists. The tool does not draw a diagram. See **Visualization** below.

## Visualization

Render a **`flowchart LR`** access-flow diagram: Profile/PermissionSet nodes on the left, Permission Set Groups in the middle, the target object/field on the right. Edge style encodes Read/Edit/Delete; colour encodes risk (guest user, Experience Cloud, `without sharing` Apex).

```
flowchart LR
  P1[Profile:SystemAdmin] -->|RED| F[(Account.Tier__c)]
  PSG[PSG:Sales] --> PS[PS:SalesEdit] --> F
  GU[Profile:Guest]:::risk --> F
  classDef risk fill:#fcc,stroke:#900
```

When more than 25 Profiles/PSets have access, collapse to a count table and only diagram the high-risk paths (guest, Experience Cloud, without-sharing).

## Staleness check

If `staleness_check` is not available (the server runs with `SFGRAPH_TOOLS=core`), skip this step and say the graph's freshness was not checked.

Before calling `security_audit`, invoke `staleness_check` for the target org. Permission set/profile assignments change frequently; a stale graph misrepresents access. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Target** — `SObject` or `SObject.Field`.
- **Access matrix** — table: Profile / PSet -> R / E / D / VA / MA.
- **Sharing model** — OWD + sharing rules + role hierarchy.
- **Apex exposure** — list of `without sharing` classes that touch the target.
- **Risks** — bullets, severity-tagged.
- **Mermaid access matrix** — embedded.

## Don't

- Do not propose specific profile / permission set edits; surface the gap and let security own the change.
- Do not modify any sharing configuration.
- Do not omit guest user / Experience Cloud findings — they are the highest-risk category.
- Do not infer encryption status from this audit; that requires `sf-architect-security`.
