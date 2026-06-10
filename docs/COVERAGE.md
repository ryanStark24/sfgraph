# sfgraph Coverage Matrix

This document is the authoritative reference for which Salesforce metadata types sfgraph supports, the edges each emits, and known limitations.

**Status legend:**

- **Full** — first-class extractor; parsed deeply; emits relationship-specific edges (`READS_FIELD`, `EMBEDS_LWC`, `GRANTS_OBJECT_ACCESS`, etc.).
- **Partial** — first-class extractor, but some structural relationships are not modeled.
- **Generic-Only** — ingested via the generic-metadata path; node exists with raw attributes, but no relationship-specific edges (only opaque `REFERENCES`).
- **Unsupported** — type appears in `describeMetadata()` output but is not dispatched to any extractor (only ingested if `SFGRAPH_INCLUDE_ALL_GENERIC=1`).

Coverage is **dynamic, not hardcoded**. At ingest start, `conn.metadata.describe(apiVersion)` asks the org for its full supported type list — which automatically includes any types added by installed managed packages or by new Salesforce releases. Each type is routed to either a code parser, a declarative YAML rule, or the generic opaque-node fallback.

Last updated: **2026-05-18** (Phase 1.5).

See also: [`../README.md#coverage`](../README.md#coverage) for the high-level summary and [`../README.md#honest-disclosures--known-limitations`](../README.md#honest-disclosures--known-limitations) for the disclosure list (mirrored at the end of this file).

---

## Status matrix

### Apex

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `ApexClass` | Full | `CALLS`, `READS_FIELD`, `WRITES_FIELD`, `READS_SOBJECT`, `WRITES_SOBJECT`, `EMBEDS_LWC` (from Aura wrappers), `IS_TEST_FOR` | Managed-package `Body` is `(hidden)` — metadata-only node. | `packages/core/src/extractors/live-org/extractors/apex.ts` |
| `ApexTrigger` | Full | `TRIGGER_ON`, `CALLS`, `READS_FIELD`, `WRITES_FIELD` | Managed-package `Body` is `(hidden)` — metadata-only node. | `packages/core/src/extractors/live-org/extractors/apex.ts` |
| `ApexPage` | Generic-Only | `REFERENCES` (opaque) | VF markup not parsed; references to Apex controllers / static resources not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `ApexComponent` | Generic-Only | `REFERENCES` (opaque) | VF component markup not parsed. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### UI components

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `LightningComponentBundle` (LWC) | Full | `EMBEDS_LWC`, `IMPORTS_LMS_CHANNEL`, `CALLS_APEX`, `WIRES_APEX`, `BINDS_FIELD` | Managed-package `Source` is `<hidden>` — metadata-only node. Empty bundle stubs no longer emitted on per-bundle fetch failure (Phase 1.5 change). | `packages/core/src/extractors/live-org/extractors/lwc.ts` |
| `AuraDefinitionBundle` | Generic-Only | `REFERENCES` (opaque) | Aura markup not parsed; Apex / LWC embeds not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `FlexiPage` | Generic-Only | `REFERENCES` (opaque) | Lightning App Builder references (embedded LWCs, RecordType bindings) not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `Layout` | Generic-Only | `REFERENCES` (opaque) | Field placements / QuickAction references not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `QuickAction` | Generic-Only | `REFERENCES` (opaque) | Target object / Flow references not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `CustomTab` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `CustomApplication` | Generic-Only | `REFERENCES` (opaque) | Tab list / utility bar references not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `HomePageLayout` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `CustomPageWebLink` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `WebLink` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `LightningMessageChannel` | Generic-Only | `REFERENCES` (opaque) | LWC `IMPORTS_LMS_CHANNEL` resolves against bundle imports; channel node itself is opaque. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Process automation

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `Flow` | Full | `INVOKES_APEX`, `READS_FIELD`, `WRITES_FIELD`, `CALLS_SUBFLOW` | Definition modes (active version selection) follow `FlowDefinition`'s `ActiveVersionNumber`. | `packages/core/src/extractors/live-org/extractors/flow.ts` |
| `FlowDefinition` | Generic-Only | `REFERENCES` (opaque) | Used to resolve active Flow version; not modeled as a graph relationship. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `Workflow` | Generic-Only | `REFERENCES` (opaque) | Field updates / email alerts / outbound messages not modeled. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `ApprovalProcess` | Generic-Only | `REFERENCES` (opaque) | Step-level actor / field references not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `AssignmentRules` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `AutoResponseRules` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `EscalationRules` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `DuplicateRule` | Generic-Only | `REFERENCES` (opaque) | MatchingRule pairing not modeled as a graph edge. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `MatchingRule` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Data model

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `CustomObject` | Full | `HAS_FIELD`, `LOOKUP_TO`, `MASTER_DETAIL_TO`, `EXTERNAL_LOOKUP_TO`, `HAS_RECORD_TYPE`, `HAS_VALIDATION_RULE` | Per-`describe()` 12s hard timeout; pathological objects are caught and skipped. SObject inclusion governed by `EntityDefinition.IsCustomizable` (see below). | `packages/core/src/extractors/live-org/extractors/object.ts` |
| `CustomMetadata` (records) | Full (values) | `INSTANCE_OF`, `REFERENCES` | Each record's **field values** are captured onto the `CustomMetadataRecord` node's `values` attribute (from metadata.read's `<values>`) and folded into the node embedding, so the graph resolves config to real values (endpoints, matching keys, toggles) and `find_similar` matches on them. | `packages/core/src/parsers/rules/custom-metadata-type.yml` |
| `CustomLabels` / `CustomLabel` | Full (values) | `REFERENCES` | The `CustomLabels` container rule captures each label's `value`/`language` (folded into the embedding). The redundant singular `CustomLabel` path is suppressed so it can't clobber the value-bearing nodes. Managed-package label values remain package-hidden. | `packages/core/src/parsers/rules/custom-labels.yml` |
| Custom Settings (rows) | Full (values) | `INSTANCE_OF` → `CustomObject` | A dedicated extractor discovers `EntityDefinition.IsCustomSetting`, `SELECT FIELDS(ALL)` each (≤200 rows), and emits a `CustomSetting:<obj>` node whose `customSettingRows` attribute holds the org-default + hierarchy values (folded into the embedding). Linked to the schema `CustomObject` node. | `packages/core/src/extractors/live-org/extractors/custom-settings.ts` |
| `GlobalValueSet` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `StandardValueSet` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `CustomPermission` | Generic-Only | `REFERENCES` (opaque) | Grants to Profile / PermSet not modeled as a graph edge. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Security & access

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `Profile` | Full | `GRANTS_OBJECT_ACCESS`, `GRANTS_FIELD_ACCESS`, `GRANTS_APEX_CLASS_ACCESS`, `GRANTS_VF_PAGE_ACCESS`, `GRANTS_USER_PERMISSION` | Analysis layer caps results at 5000 per label (`SECURITY_PER_LABEL_CAP`); graph storage is complete. | `packages/core/src/extractors/live-org/extractors/security.ts` |
| `PermissionSet` | Full | `GRANTS_OBJECT_ACCESS`, `GRANTS_FIELD_ACCESS`, `GRANTS_APEX_CLASS_ACCESS`, `GRANTS_VF_PAGE_ACCESS`, `GRANTS_USER_PERMISSION` | Same 5000-per-label analysis cap. | `packages/core/src/extractors/live-org/extractors/security.ts` |
| `SharingRules` | Full | `SHARES_TO_GROUP`, `SHARES_TO_ROLE`, `SHARES_BASED_ON_CRITERIA`, `SHARES_BASED_ON_OWNER` | — | `packages/core/src/extractors/live-org/extractors/security.ts` |
| **`PermissionSetGroup`** | **Generic-Only** | `REFERENCES` (opaque) | **No `GRANTS_*` / `INCLUDES_PERMSET` edges.** Composition of constituent permission sets is not modeled. Audits relying on permission inheritance will MISS findings for grouped permissions. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| **`MutingPermissionSet`** | **Generic-Only** | `REFERENCES` (opaque) | **No `DENIES_*` edges.** Mutes within a PermissionSetGroup are not modeled. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| **`ProfileSessionSetting`** | **Generic-Only** | `REFERENCES` (opaque) | **Session security policy (IP ranges, login hours, session timeouts) not modeled.** | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| **`ProfilePasswordPolicy`** | **Generic-Only** | `REFERENCES` (opaque) | **Password policy (complexity, expiration, history) not modeled.** | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `ConnectedApp` | Generic-Only | `REFERENCES` (opaque) | OAuth scopes / SAML config / IP relaxation not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `SamlSsoConfig` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `SharingSet` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `GroupMember` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Integrations

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `NamedCredential` | Full | `USES_EXTERNAL_CREDENTIAL`, `CALLED_BY_APEX` (resolved from Apex callouts) | — | `packages/core/src/extractors/live-org/extractors/integration.ts` |
| `ExternalServiceRegistration` | Full | `BACKED_BY_NAMED_CREDENTIAL`, `EXPOSES_SCHEMA` | OpenAPI schema is captured as an attribute blob, not as edges into a structured operation graph. | `packages/core/src/extractors/live-org/extractors/integration.ts` |
| `ExternalCredential` | Generic-Only | `REFERENCES` (opaque) | Principal / parameter records not modeled. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `RemoteSiteSetting` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `CspTrustedSite` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Platform Events & CDC

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `PlatformEventChannel` | Generic-Only | `REFERENCES` (opaque) | Channel-member fan-out not modeled. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `PlatformEventChannelMember` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `PlatformEventSubscriberConfig` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Vlocity legacy industry clouds

Coverage delivered via a vendored copy of `vlocity_build`'s `QueryDefinitions.yaml` (MIT, 48 DataPack types). Namespaces: `vlocity_cmt`, `vlocity_ins`, `vlocity_hc`, `vlocity_ps`, `vlocity_fs`.

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `DataRaptor` (DRBundle + DRMapItem children) | Full | `DR_READS_FIELD`, `DR_WRITES_FIELD`, `DR_TRANSFORMS`, `REFERENCES_OBJECT` | Field edges come from structured DRMapItem rows (Interface/Domain/Lookup sides) plus `Object.Field` regex over formula expressions. JSON-path sides (`Step:Field`) correctly emit nothing. | `packages/core/src/parsers/vlocity/data-raptor.ts` |
| `IntegrationProcedure` (Element__c children) | Full | `IP_CALLS_DR`, `IP_CALLS_IP`, `IP_INVOKES_REMOTE` | Remote elements without `remoteClass`/`endpointURL` in PropertySet resolve to `Remote:unknown`. | `packages/core/src/parsers/vlocity/integration-procedure.ts` |
| `OmniScript` (Element__c children) | Full | `OS_USES_DR`, `OS_CALLS_IP`, `OS_EMBEDS_VC`, `OS_INVOKES_REMOTE` | — | `packages/core/src/parsers/vlocity/omni-script.ts` |
| `VlocityCard` | Full | `VC_USES_DR`, `VC_CALLS_IP`, `VC_EMBEDS_LWC`, `VC_INVOKES_REMOTE`, `EMBEDS_VC` | — | `packages/core/src/parsers/vlocity/vlocity-card.ts` |
| Other DataPack types (44 of 48) | Node-Only | — | Ingested as nodes (CalculationMatrix, CalculationProcedure, DocumentTemplate, …) without dedicated edge parsers or child fetches. | `packages/core/src/extractors/live-org/vlocity/runner.ts` |

All Vlocity ingestion is capability-gated — it only runs when the `vlocityLegacy` capability probe fires.

### OmniStudio on-Core

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `OmniProcess` (+ OmniProcessElement children) | Full | `OMNI_CALLS_DATA_TRANSFORM`, `OMNI_CALLS_INTEGRATION_PROCEDURE`, `OMNI_EMBEDS_UI_CARD`, `OMNI_INVOKES_REMOTE` | SOQL on the standard `OmniProcess`/`OmniProcessElement` SObjects. Covers both on-core OmniScripts and on-core Integration Procedures (both are stored as OmniProcess rows). | `packages/core/src/extractors/live-org/extractors/omnistudio.ts`, `packages/core/src/parsers/omnistudio/process.ts` |
| `OmniDataTransform` (+ OmniDataTransformItem children) | Full | `DR_READS_FIELD`, `DR_WRITES_FIELD`, `REFERENCES_OBJECT` | Field edges come from structured OmniDataTransformItem rows (Input/Output/Lookup sides), fetched via SOQL child query. Uses the same edge vocabulary as Vlocity DataRaptor so cross-flavor overlap signatures can match. | `packages/core/src/parsers/omnistudio/data-transform.ts` |
| `OmniUiCard` | Partial | `OMNI_CALLS_INTEGRATION_PROCEDURE`, `OMNI_CALLS_DATA_TRANSFORM`, `OMNI_INVOKES_REMOTE` | Edge emission depends on nested references present in the card definition payload. | `packages/core/src/parsers/omnistudio/ui-card.ts` |
| `OmniIntegrationProcedure` | Partial | `OMNI_CALLS_DATA_TRANSFORM`, `OMNI_CALLS_INTEGRATION_PROCEDURE`, `OMNI_INVOKES_REMOTE` | Only available via the Metadata-API retrieve path (`enableOmnistudioRetrieve`); not part of the SOQL pass. | `packages/core/src/extractors/live-org/extractors/omnistudio-retrieve.ts`, `packages/core/src/parsers/omnistudio/integration-procedure.ts` |

Retrieve path (`enableOmnistudioRetrieve`): hydrates `OmniDataTransform`, `OmniUiCard`, and `OmniIntegrationProcedure` from Metadata-API XML (parsers accept both JSON and XML payloads). When enabled, the SOQL pass skips `OmniDataTransform` and `OmniUiCard` so the same component is not ingested twice. `OmniScript` has no separate on-core type — on-core OmniScripts are `OmniProcess` rows and are covered by the `OmniProcess` row above. Vlocity↔on-core duplicates are linked via `CANONICAL_OF` edges by the cross-flavor resolver, with divergence annotations from the overlap detector.

### Communities / Networks

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `Network` | Generic-Only | `REFERENCES` (opaque) | Community member / tab references not modeled. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `NetworkBranding` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `NavigationMenu` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `Community` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `ExperienceBundle` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `DigitalExperienceBundle` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Reports & Analytics

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `Report` | Generic-Only | `REFERENCES` (opaque) | ReportType binding / field references not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `Dashboard` | Generic-Only | `REFERENCES` (opaque) | Report references not modeled. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `ReportType` | Generic-Only | `REFERENCES` (opaque) | Object joins / accessible fields not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Notifications & Sites

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `CustomNotificationType` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `CustomSite` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `EmailTemplate` | Generic-Only | `REFERENCES` (opaque) | Merge-field references not parsed. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `EmailServicesFunction` | Generic-Only | `REFERENCES` (opaque) | Apex handler class binding not modeled. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `StaticResource` | Generic-Only | `REFERENCES` (opaque) | Binary body not fetched. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `RecordActionDeployment` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `PathAssistant` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Einstein / GenAI / Bots

| Metadata Type | Status | Edges Emitted | Known Limitations | Source File |
|---|---|---|---|---|
| `Bot` | Generic-Only | `REFERENCES` (opaque) | Intent / dialog node references not extracted. | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `GenAiPromptTemplate` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `GenAiFunction` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `GenAiPlugin` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |
| `GenAiPlannerBundle` | Generic-Only | `REFERENCES` (opaque) | — | `bulk-retrieve.ts:GENERIC_TYPE_WHITELIST` |

### Long tail (`Unsupported` unless `SFGRAPH_INCLUDE_ALL_GENERIC=1`)

Every other type returned by `describeMetadata()` that does not appear in any of the rows above and is not in `GENERIC_TYPE_WHITELIST` is filtered out by default. Setting `SFGRAPH_INCLUDE_ALL_GENERIC=1` runs them through the generic extractor at the cost of longer ingest and more opaque nodes. Out of the ~327 metadata types a typical org's `describeMetadata()` returns, sfgraph dispatches ~80 to a named or whitelisted-generic extractor; the rest are filtered.

---

## SObject classification

`describeGlobal()` returns every queryable SObject — often 800–1500 of them on a demo / industry-cloud org. The vast majority are platform internals (audit, telemetry, SSO config, introspection metadata) that user code never references. Describing all of them takes minutes, bloats the graph, and on macOS 26+ historically crashed jsforce mid-run for some pathological tables.

sfgraph **asks Salesforce which SObjects are user-relevant** via the Tooling API's `EntityDefinition` table:

```sql
SELECT QualifiedApiName, IsCustomizable, IsApexTriggerable,
       IsDeprecatedAndHidden, IsCustomSetting
FROM EntityDefinition
```

If `IsCustomizable=true`, `IsApexTriggerable=true`, or `IsCustomSetting=true` (and not `IsDeprecatedAndHidden`), the SObject is in scope. Otherwise it's a platform internal and gets skipped.

This works across Salesforce editions and industry clouds: `AuthorizationFormConsent` (Health Cloud) returns `IsCustomizable=true` → included automatically. `AuthConfig` (SSO internal) returns false → skipped. No hardcoded list to maintain — Salesforce's own metadata tells us what's real.

### Layered filters (applied in order)

1. Companion tables (`*Feed`, `*History`, `*Share`, etc.) — always skipped.
2. `SYSTEM_SKIP_NAMES` hard blacklist (`ApexLog`, `EventLogFile`, etc.) — always skipped (acts as a ceiling even if `EntityDefinition` says otherwise).
3. Custom SObjects (`__c`, `__e`, `__b`, `__mdt`, `__x`, `__ka`, `__kav`, `__chn`) — always **included**. Covers user-owned and every managed-package custom object.
4. `EntityDefinition.IsCustomizable` filter — primary signal for non-custom SObjects.
5. Static `STANDARD_SOBJECT_WHITELIST` — fallback only if `EntityDefinition` query fails or returns 0 records (some scratch / dev orgs).

### Per-describe timeout

Each `describe()` is wrapped in a 12-second hard timeout. A single pathological SObject whose response never returns no longer wedges the run; it's caught as a timeout and skipped while everything else proceeds.

### Overrides

```bash
SFGRAPH_INCLUDE_ALL_SOBJECTS=1   # bring back the full queryable surface
SFGRAPH_SKIP_SOBJECT=Foo,Bar     # per-SObject escape hatch for crashes
```

---

## Managed-package handling

`describeGlobal()` returns every queryable SObject in the org. sfgraph distinguishes based on **what Salesforce actually returns** for each:

- **System telemetry tables** — `ApexLog`, `EventLogFile`, `LoginHistory`, `AsyncApexJob`, `CronTrigger`, `LightningUsage*`, etc. Hundreds of fields each, multi-MB describe responses, frequently crash on macOS 26+, and **never appear in user code as references**. → **skipped by default.**
- **Managed-package custom SObjects** — `vlocity_cmt__Contract__c`, `omnistudio__Foo__c`, etc. Unlike Apex `Body` and LWC `Source` (which Salesforce *redacts* to `(hidden)` / `<hidden>` for managed packages), **SObject `describe()` returns the full field map for managed objects** — including lookups, formulas, and references. That's real graph value. → **included by default.**
- **Audit tables** — `*__History`, `*__Feed`, `*__Share`, `*__ChangeEvent`, `*__b`. → **skipped (always).**

### Managed-package source content (skipped by default)

Salesforce redacts managed-package source for any user without *View All Source* on the package:

- `LightningComponentResource.Source` → literal string `<hidden>`
- `ApexClass.Body` / `ApexTrigger.Body` → literal string `(hidden)`
- Same for `ApexPage.Markup`, `ApexComponent.Markup`, etc.

The redacted text has zero graph value (no methods, no field refs, no internal references to walk), *and* on macOS 26+ fetching some managed LWC bundles reliably crashes Node silently. So sfgraph treats managed-package items as **metadata-only nodes**:

- The bundle / class / trigger still appears in the graph (inventory tools, `list_orgs`, cross-org diff, edge resolution from your own code all work).
- Body / Source / Markup is **not** fetched or parsed.

### Override knobs

```bash
SFGRAPH_INCLUDE_SYSTEM_SOBJECTS=1   # include ApexLog/EventLogFile/etc.
SFGRAPH_INCLUDE_MANAGED=1           # include managed-package source content globally
SFGRAPH_INCLUDE_MANAGED_LWC=1       # LWC-only override
SFGRAPH_SKIP_LWC=name1,name2        # skip specific LWC bundle DeveloperNames
SFGRAPH_INCLUDE_ALL_GENERIC=1       # invoke every metadata.describe() type, not just whitelist
```

---

## Caps and thresholds

| Constant / Env var | Default | Layer | Effect |
|---|---|---|---|
| `SECURITY_PER_LABEL_CAP` | 5000 | Analysis | Profile / PermissionSet results truncated per label; graph storage unaffected. Sets `truncated: true` on the response. |
| `CROSS_ORG_PER_LABEL_CAP` | 10000 | Analysis | Cross-org diff truncation per label. |
| `maxEdgesPerSource` | 200 | Ingest (generic) | Per opaque generic node; sets `cappedSources` flag in result. |
| `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO` | `0.30` | Ingest (deletion sweep) | Per-label drop-ratio threshold; sweep refuses to wipe a label whose drop ratio exceeds this. |
| `SFGRAPH_MAX_BACKGROUND_WEDGES` | `4` | Ingest (watchdog) | Cap on simultaneous background wedge runners. |
| `SFGRAPH_WATCHDOG_FIRST_YIELD_MS` | `90000` | Ingest (watchdog) | Per-source first-yield deadline. |
| `SFGRAPH_WATCHDOG_INACTIVITY_MS` | `300000` | Ingest (watchdog) | Per-source inactivity deadline. |
| `describe()` per-call timeout | 12s | Ingest (object) | Pathological SObjects caught as timeouts and skipped. |

---

## Async / polling paradigms used

| Path | Paradigm | Polling cadence | Ceiling |
|---|---|---|---|
| SOQL / Tooling SOQL | Synchronous REST query + `nextRecordsUrl` pagination | N/A | N/A |
| Metadata API `metadata.read` | SOAP single-shot with batch bisection on timeout | N/A | `SFGRAPH_BISECT_MAX_DEPTH` (default 6) |
| Metadata API `retrieve()` (OmniStudio on-Core retrieve path only) | Async with jsforce-internal polling | 3s | 180s |
| Bulk API | **Not currently used.** | — | — |

---

## Known limitations

Mirrored from the [README's "Honest disclosures" section](../README.md#honest-disclosures--known-limitations) — keep these in sync.

- **Security model gaps.** `PermissionSetGroup`, `MutingPermissionSet`, `ProfileSessionSetting`, `ProfilePasswordPolicy` are **Generic-Only** (no `GRANTS_*` / `DENIES_*` edges). Audits relying on permission inheritance through PermissionSetGroups will MISS findings until a future Security phase.
- **Security analysis caps.** Results capped at 5000 per label in the analysis layer; graph storage is complete.
- **Generic-type whitelist.** ~80 of ~327 metadata types are dispatched to a named or whitelisted-generic extractor; the rest are filtered out unless `SFGRAPH_INCLUDE_ALL_GENERIC=1`.
- **LWC empty-bundle behavior change (Phase 1.5).** Per-bundle fetch failures now emit a `wedge:lwc:bundleFetchFailed:...` warning and NO record (previously: stub bundle with `files: {}`). Re-ingest after upgrade will remove previously-recorded empty bundles. This is correct.
- **Socket leak on wedged HTTP requests (jsforce 3.10.15 stop-waiting).** When the per-source watchdog fires, sfgraph releases the slot but the underlying jsforce HTTP request is NOT cancelled (jsforce does not expose `AbortController`). Wedged sockets are reaped by Node's idle-timeout (~10min). Worst case: 4 wedges × ~1MB ≈ 4MB transient memory per ingest, GC'd at process exit.

---

## Future hardening (cross-reference)

- **Bulk API migration** for large SOQL paths — deferred; profiling-gated. Bulk API has higher per-job overhead, so the migration is only worth it for the longest-tail label populations.
- **First-class extractors for `PermissionSetGroup` / `MutingPermissionSet` / `ProfileSessionSetting` / `ProfilePasswordPolicy`** — deferred to a future Security phase. Closing this gap requires modeling group composition (`INCLUDES_PERMSET`), mute semantics (`DENIES_*`), and session/password policy semantics that don't fit the current `GRANTS_*` schema.
- **jsforce upgrade or fork exposing `AbortController`** — needed for true in-flight HTTP cancellation; tracked in `.planning/STATE.md` backlog. Until then, the socket-leak caveat above applies.
- **Aura / VF deep parsing** — `AuraDefinitionBundle`, `ApexPage`, `ApexComponent` are currently Generic-Only. A first-class extractor would unlock LWC ↔ Aura embed edges and VF ↔ Apex controller edges. Deferred (low industry-cloud priority).
