---
name: sf-omnistudio-migration-audit
description: Inventory Vlocity-CMT vs OmniStudio-on-Core assets and verify CANONICAL_OF mirror counts.
triggers:
  - "omnistudio migration"
  - "vlocity to omnistudio"
  - "CMT migration"
  - "omnistudio audit"
  - "migrate from vlocity"
tools_used:
  - cross_org_diff
  - staleness_check
---

# sf-omnistudio-migration-audit

Use when the user is mid-migration from Vlocity CMT (managed package) to OmniStudio on Core and wants to verify parity by category.

## Playbook

1. Enumerate Vlocity-CMT node categories present in the graph: `vlocity_cmt__DataRaptor`, `vlocity_cmt__IntegrationProcedure`, `vlocity_cmt__OmniScript`, `vlocity_cmt__VlocityCard`.
2. Enumerate the OmniStudio-on-Core equivalents: `OmniDataTransform`, `OmniIntegrationProcedure`, `OmniProcess` (OmniScript), `OmniUiCard`.
3. For each pair, count nodes on both sides and count `CANONICAL_OF` edges that mirror a CMT asset to its OmniStudio twin. Report `cmt_count`, `core_count`, `canonical_pairs`, `unmirrored_cmt`, `unmirrored_core`.
4. If the user provided two orgs (typically a CMT-only sandbox vs an OmniStudio-on-Core sandbox), call `cross_org_diff` to highlight assets present in one and not the other.
5. Bucket findings:
   - **fully migrated** — pair exists, `CANONICAL_OF` edge present, no logic drift.
   - **partial** — twin exists but `CANONICAL_OF` missing or one-side has additional logic nodes.
   - **not started** — CMT asset has no Core twin.
6. Render a Mermaid bar chart per category: CMT / Core / Canonical / Unmirrored.

## Visualization

Render a **`flowchart LR`** parity diagram. Left subgraph is Vlocity-CMT; right is OmniStudio-on-Core; `CANONICAL_OF` edges connect mirrored pairs. Unmirrored nodes hang off either side with a dashed border.

```
flowchart LR
  subgraph CMT
    D1[vlocity_cmt__DataRaptor:Foo]
  end
  subgraph Core
    D2[OmniDataTransform:Foo]
  end
  D1 -. CANONICAL_OF .-> D2
  D3[vlocity_cmt__OmniScript:Bar]:::unmirrored
  classDef unmirrored stroke-dasharray:4 4,fill:#fdd
```

For orgs with >50 CMT assets, swap the diagram for a per-category counts table — the parity story is the counts, not the topology.

## Staleness check

Before running the audit, invoke `staleness_check` for each org in scope. A stale ingest means recently-created CANONICAL_OF edges or new OmniStudio twins are missing, which inflates the "not started" bucket. If the report says stale, surface a warning to the user:

> Your ingest is N days old. Run `sfgraph ingest --org <alias>` to refresh, or proceed with the understanding that the graph may not reflect recent changes.

Then continue with the playbook.

## Response Shape

- **Scope** — one org or two orgs compared.
- **Per-category table** — DataRaptor / IntegrationProcedure / OmniScript / VlocityCard rows with the five counts above.
- **Buckets** — fully migrated / partial / not started, each as a bulleted list of asset names.
- **Mermaid bar chart** — embedded.
- **Recommended next step** — typically a focused `sf-cross-layer-trace` on the highest-risk unmirrored asset.

## Don't

- Do not include non-OmniStudio Vlocity assets (e.g. `vlocity_cmt__Pricebook2`) in migration counts.
- Do not auto-create `CANONICAL_OF` edges. This is a read-only audit.
- Do not assume name match implies semantic equivalence; require the `CANONICAL_OF` edge before counting as migrated.
- Do not modify or deploy any OmniStudio metadata.
