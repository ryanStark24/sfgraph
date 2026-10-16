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
  - find_nodes
  - trace_downstream
  - cross_org_diff
  - staleness_check
---

# sf-omnistudio-migration-audit

Use when the user is mid-migration from Vlocity CMT (managed package) to OmniStudio on Core and wants to verify parity by category.

## Evidence rule — say it only if something backs it

State a fact about this org or the Salesforce platform **only when evidence backs it**: a tool/graph result, source you actually read (local sfdx file or an org fetch), a live org query, or official Salesforce documentation. If you don't have that, say so plainly — "the graph doesn't show this", "unverified", "I'd need to check the org" — and either go get the evidence or stop. **Never fill the gap with a plausible-sounding guess**: an invented field/method/object name, an assumed dependency, or a governor number recalled from memory. Label each claim as **graph-confirmed** (a tool returned it), **inferred** (you reasoned it from graph facts — say which facts), or **general Salesforce knowledge**. For platform behaviour — governor limits, order of execution, sharing/FLS semantics, API rules — cite the official doc (developer.salesforce.com; fetch it if unsure) instead of asserting from memory. If the graph is stale or the org was never ingested, lead with that caveat — your grounding may be wrong.

## Playbook

No tool computes these counts; you build them from `find_nodes` and `trace_downstream` results, and say so. The graph labels are the same whatever the org's namespace (there is no `vlocity_cmt__` prefix on a label).

1. List the Vlocity-CMT assets with `find_nodes(label=…)` for each of `DataRaptor`, `IntegrationProcedure`, `OmniScript` and `VlocityCard`. Raise `limit` until the result is not truncated.
2. List the OmniStudio-on-Core twins the same way: `OmniDataTransform`, `OmniIntegrationProcedure`, `OmniProcess` (OmniScript) and `OmniUiCard`. The pairs are DataRaptor ↔ OmniDataTransform, IntegrationProcedure ↔ OmniIntegrationProcedure, OmniScript ↔ OmniProcess, VlocityCard ↔ OmniUiCard.
3. For each CMT asset, `trace_downstream(qname, depth=1, rel_types=["CANONICAL_OF"])` finds its twin (the edge is written both ways when the names match). With many assets, check a sample and say so. Per pair of labels, report the CMT count, the Core count, the mirrored pairs, and the unmirrored assets on each side.
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
    D1[DataRaptor:Foo]
  end
  subgraph Core
    D2[OmniDataTransform:Foo]
  end
  D1 -. CANONICAL_OF .-> D2
  D3[OmniScript:Bar]:::unmirrored
  classDef unmirrored stroke-dasharray:4 4,fill:#fdd
```

For orgs with >50 CMT assets, swap the diagram for a per-category counts table — the parity story is the counts, not the topology.

## Staleness check

If `staleness_check` is not available (the server runs with `SFGRAPH_TOOLS=core`), skip this step and say the graph's freshness was not checked.

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
