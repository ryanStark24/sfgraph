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
---

# sf-security-audit

Use when the user asks about who can read or write a field/object, what sharing rules apply, or whether FLS / CRUD is consistent with intent.

## Playbook

1. Resolve the target. Call `analyze_field` if the user gave `SObject.Field`; otherwise treat as SObject-level.
2. Call `security_audit` with the resolved target. Capture profiles, permission sets, permission set groups, sharing rules (criteria + owner-based), OWD, and any `without sharing` Apex that touches the field.
3. Build the access matrix: Profile/PSet -> Read / Edit / Delete / View All / Modify All.
4. Identify sharing exposure: OWD setting, sharing rules expanding access, role-hierarchy inheritance toggles.
5. Flag risks: `without sharing` Apex selectors, missing `stripInaccessible` / `WITH SECURITY_ENFORCED`, guest user access, Experience Cloud profile reach.
6. Render the Mermaid access matrix returned by the tool.

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
