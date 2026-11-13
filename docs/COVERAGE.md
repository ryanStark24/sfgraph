# sfgraph Coverage Matrix

This document is the authoritative reference for which Salesforce metadata types sfgraph supports, the edges each emits, and known limitations.

**Status legend:**

- **Full** — first-class extractor; parsed deeply; emits relationship-specific edges (`READS_FIELD`, `EMBEDS_LWC`, `GRANTS_OBJECT_ACCESS`, etc.).
- **Partial** — first-class extractor, but some structural relationships are not modeled.
- **Generic-Only** — ingested via the generic path as an opaque node (name, size, raw attributes). Since 1.8.0 the node also carries the scanner's candidate references, and a candidate that matches a real node becomes a heuristic `GENERIC_REFERENCES_*` edge (see below). Rows in the matrix that still say "`REFERENCES` (opaque)" describe the older behaviour; read them as "opaque node plus heuristic `GENERIC_REFERENCES_*` edges". Types with a YAML rule are listed in "Rule-parsed types" and are no longer opaque.
- **Unsupported** — only reachable with `SFGRAPH_GENERIC_WHITELIST_ONLY=1` (see "Generic routing"): a type the org describes but the curated whitelist leaves out.

Coverage is **dynamic, not hardcoded**. At ingest start, `conn.metadata.describe(apiVersion)` asks the org for its full supported type list — which automatically includes any types added by installed managed packages or by new Salesforce releases. Each type is routed to a code parser, a declarative YAML rule (built-in or from `SFGRAPH_RULES_DIR`), or the generic fallback.

Last updated: **2026-11-12** (1.8.0). Written from the code, not from a live-org run: the rules and gates below are covered by unit and golden tests with synthetic payloads, and have not been verified against a live Salesforce org.

See also: [`../README.md#coverage`](../README.md#coverage) for the high-level summary and [`../README.md#honest-disclosures--known-limitations`](../README.md#honest-disclosures--known-limitations) for the disclosure list (mirrored at the end of this file).

---

## Generic routing

Every type the org's `describeMetadata()` returns reaches the generic path, except children already read through their container (`CONTAINER_COVERED_TYPES`, e.g. `AssignmentRule` under `AssignmentRules`) and types a dedicated extractor owns. The old curated `GENERIC_TYPE_WHITELIST` is used only when `SFGRAPH_GENERIC_WHITELIST_ONLY=1`. That means a new cloud's types, or a type a newer API version added, become nodes without a code change. Types with a parser or a rule are parsed; the rest become opaque nodes. Child types that live on standard objects (validation rules, list views, ...) are routed through the generic extractor too, unless the whitelist-only switch is set. (`SFGRAPH_INCLUDE_ALL_GENERIC=1` is now only mentioned in a code comment; it changes nothing.)

## New clouds and unknown types

A metadata type with no parser and no YAML rule is not name-only:

- **Generic reference scanner.** The opaque node keeps a bounded list of candidate references found in the body (Apex classes, Flows, `ns__Name__suffix` objects, `Object.Field`, merge fields, values under `*object*` / `*apexClass*` / `*flow*` / `*actionName*` / `*field*` elements), stored in the node's attributes. After the merge, a candidate that matches a real node becomes a heuristic edge: `GENERIC_REFERENCES_APEX`, `GENERIC_REFERENCES_FLOW`, `GENERIC_REFERENCES_OBJECT` or `GENERIC_REFERENCES_FIELD` (attributes `via`, `confidence: heuristic`). Unmatched candidates are dropped. `cross_layer_flow_map` does not follow them (they are not verified steps).
- **Object recovery.** SObjects that code, flows or metadata reference but an object gate dropped are described and added after the fan-out (default on; `SFGRAPH_RECOVER_OBJECTS=0` disables, `SFGRAPH_RECOVER_OBJECTS_MAX` caps it at 50). It bypasses the classification gates (a reference is stronger evidence), but never recovers History/Share/Feed/Tag-style companion tables or names in `SFGRAPH_SKIP_SOBJECT`; standard change events (`AccountChangeEvent`) are recoverable. Costs nothing when no reference points at a missing object; otherwise one `describeGlobal` plus at most the cap in describes, through the same rate-limited pool and 12 s per-describe timeout. A recovered object uses the same envelope builder as normal extraction (`buildObjectEnvelope` in `extractors/object.ts`).
- **User rules.** Add YAML rules without a release: `--rules-dir` / `SFGRAPH_RULES_DIR`, format in [RULES.md](RULES.md). A built-in parser wins on a type or alias clash unless the file sets `override: true`.
- **Coverage report.** Each ingest stores per-type counts (`opaque`, `nameOnly`, `withGenericEdges`, `ruleParsed`, and `unknownTypes`); `staleness_check` returns it as `data.coverage`. `ruleParsed` counts the nodes a YAML rule emitted, by the labels the rule emits (so `CustomLabels` counts under `CustomLabel`), and an alias such as `GenAiPlannerBundle` lands on the `GenAiPlanner` row.

## Rule-parsed types

Declarative YAML rules live in `packages/core/src/parsers/rules/`. Types and the edge kinds they emit (besides the node):

| Type (aliases) | Edge kinds |
|---|---|
| `GenAiPlanner` (`GenAiPlannerBundle`, `GenAiPlannerDefinition`; one `GenAiPlanner:<name>` node whichever name the org used, with a `metadataType` attribute when it arrived as an alias, which the deployment manifest uses for `package.xml`) | `PLANNER_USES_PLUGIN`, `PLANNER_USES_FUNCTION`, `PLANNER_INVOKES_APEX`, `PLANNER_INVOKES_FLOW` |
| `GenAiPlugin` | `PLUGIN_INVOKES_FUNCTION` |
| `GenAiFunction` | `FUNCTION_INVOKES_APEX`, `FUNCTION_INVOKES_FLOW`, `FUNCTION_USES_PROMPT` |
| `GenAiPromptTemplate` | `PROMPT_GROUNDS_ON_OBJECT`, `PROMPT_READS_FIELD`, `PROMPT_CALLS_APEX`, `PROMPT_CALLS_FLOW` |
| `Bot`, `BotVersion` | `BOT_HAS_VERSION`, `BOT_USES_PLANNER`, `BOT_INVOKES_APEX`, `BOT_INVOKES_FLOW` |
| `ExpressionSetDefinition`, `ExpressionSetDefinitionVersion` | `EXPRESSION_SET_USES_MATRIX`, `EXPRESSION_SET_CALLS_APEX`, `EXPRESSION_SET_REFERENCES_OBJECT` (version also `CONTAINS`) |
| `DecisionMatrixDefinition` | node only |
| `DataStreamDefinition` | `DATA_STREAM_FEEDS_OBJECT` |
| `ObjectSourceTargetMap` | `MAPS_TO_OBJECT`, `MAPS_TO_FIELD` |
| `MarketSegment` | `SEGMENT_ON_OBJECT` |
| `Network` | `NETWORK_USES_BUNDLE` |
| `ApexPage`, `ApexComponent` | `CONTROLLED_BY`, `EXTENDS_CONTROLLER`, `READS_FIELD`, `WRITES_FIELD`, `REFERENCES`, `REFERENCES_LABEL`, `REFERENCES_OBJECT` |
| `FlexiPage` | `EMBEDS_LWC` |
| `Layout` | `RENDERS_FIELD` |
| `CustomTab` | `REFERENCES`, `REFERENCES_OBJECT`, `USES_LWC` |
| `Profile` | `GRANTS_OBJECT_ACCESS`, `GRANTS_FIELD_ACCESS`, `GRANTS_APEX_ACCESS`, `GRANTS_PAGE_ACCESS`, `GRANTS_TAB_ACCESS` |
| `PermissionSet` | `GRANTS_OBJECT_ACCESS`, `GRANTS_FIELD_ACCESS`, `GRANTS_APEX_ACCESS` |
| `PermissionSetGroup` | `GRANTS_USER_PERMISSION` |
| `SharingRules` | `SHARING_GRANTS`, `SHARING_TO_GROUP`, `SHARING_TO_ROLE`, `SHARING_FROM_OWNER_GROUP` |
| `Workflow` | `WORKFLOW_TRIGGERS` (also rule → its field updates), `WORKFLOW_UPDATES_FIELD`, `TRIGGER_FIRES_ON`, `CONTAINS`, `READS_FIELD` (rule criteria and formulas, field-update formulas), `WRITES_FIELD` from per-update `WorkflowFieldUpdate` nodes |
| `ApprovalProcess` | `APPROVAL_USES_FORMULA` |
| `Report`, `Dashboard` | `REPORTS_ON`, `READS_FIELD`; `DASHBOARD_USES_REPORT` |
| `DuplicateRule` | `REFERENCES` |
| `ExternalServiceRegistration` | `ESR_USES_NAMED_CREDENTIAL` |
| `CustomMetadata`, `CustomSetting` | `INSTANCE_OF` |
| `CustomLabels`, `NamedCredential`, `PlatformEvent` | node(s) only |

The Agentforce, Revenue/Industries and Data Cloud rows are new in 1.8.0. Several older matrix rows below (for example `Layout`, `FlexiPage`, `Report`, `Dashboard`, `Network`, `Profile` field access, `ApexPage`) say Generic-Only but have a rule; this table is the current list. The agent, expression-set and Data Cloud edges are configuration relationships, so cross-layer flow maps skip them as flow-map entries.

### Project folders (filesystem source)

A project checkout is read from the matching sfdx folders. Folder-per-member types are read both as flat files and as one meta file per subfolder, and only the XML file is read (never schema / input / output files): `bots` (with `BotVersion` members named `<bot>.<version>`), `genAiPlugins`, `genAiFunctions`, `genAiPromptTemplates`, `genAiPlannerBundles` (and `genAiPlanners`), `expressionSetDefinitions`, `decisionMatrixDefinitions`, `dataStreamDefinitions`, `objectSourceTargetMaps`, `marketSegments`.

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

### Long tail

Every other type returned by `describeMetadata()` goes through the generic extractor (see "Generic routing") and becomes an opaque node with scanner references. With `SFGRAPH_GENERIC_WHITELIST_ONLY=1` only the ~80 whitelisted types do and the rest are filtered out.

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

1. Not queryable — skipped, except platform events (`__e`) and the gate-exempt Data Cloud / CDC suffixes below, which describe fine but are never SOQL-queryable.
2. Companion tables (`*Feed`, `*History`, `*Share`, etc.) — always skipped (a custom object's own `__ChangeEvent` is not a companion).
3. `SYSTEM_SKIP_NAMES` hard blacklist (`ApexLog`, `EventLogFile`, etc.) — always skipped (acts as a ceiling even if `EntityDefinition` says otherwise).
4. Custom SObjects (`__c`, `__e`, `__b`, `__mdt`, `__x`, `__ka`, `__kav`, `__chn`, plus Data Cloud `__dlm` / `__dll` / `__cio` and custom CDC `__ChangeEvent`) — **included**. Covers user-owned and managed-package custom objects, and big objects (`__b`, few describable fields). A namespaced custom object that `EntityDefinition` does not list is skipped, except the Data Cloud / CDC suffixes (`__dlm`, `__dll`, `__cio`, `__ChangeEvent`), which `EntityDefinition` does not reliably list and so skip that gate.
5. Industries backstop (`INDUSTRIES_STANDARD_SOBJECTS`, `domain/industries-sobjects.ts`): core Financial Services Cloud (non-`FinServ__`), Revenue Cloud / Revenue Lifecycle Management and Insurance standard objects are kept when `describeGlobal` lists them, even if the `EntityDefinition` flags read false or the probe failed. An org without the cloud pays nothing.
6. `EntityDefinition.IsCustomizable` filter — primary signal for the other standard SObjects.
7. Static `STANDARD_SOBJECT_WHITELIST` — fallback only if `EntityDefinition` query fails or returns 0 records (some scratch / dev orgs).

Each ingest logs one summary line, `object gates: excluded N of M SObjects (namespaced-by-EntityDefinition=…, standard-by-EntityDefinition=…, standard-not-whitelisted=…, companion=…, non-queryable=…, system=…, deprecated=…)`, and adds it to the ingest warnings, so a dropped object is visible. Objects a gate dropped but that code references are brought back by object recovery (above). The Apex parsers also recognise the Data Cloud / CDC suffixes and the `finserv`, `vlocity_hc`, `vlocity_fs` and `vlocity_ins_fsc` namespaces when resolving object and class references.

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
- **Audit tables** — standard `*History`, `*Feed`, `*Share`, `*Tag` companions. → **skipped (always)** by the gates (object recovery can still describe a referenced one only if it is not a companion). Big objects (`*__b`), Data Cloud objects (`*__dlm`, `*__dll`, `*__cio`) and a custom object's `*__ChangeEvent` are described, not skipped.

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
SFGRAPH_GENERIC_WHITELIST_ONLY=1    # restrict the generic path to the curated whitelist (default: every described type)
SFGRAPH_RECOVER_OBJECTS=0           # turn off reference-driven object recovery
SFGRAPH_RECOVER_OBJECTS_MAX=50      # cap on recovered objects per ingest
SFGRAPH_RULES_DIR=./rules           # user YAML rules (CLI: --rules-dir)
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
- **Generic path is heuristic.** Types without a parser or rule are opaque nodes; their `GENERIC_REFERENCES_*` edges come from a text scan and are labelled heuristic, so they can miss references and can match a same-named node by coincidence. Only with `SFGRAPH_GENERIC_WHITELIST_ONLY=1` are ~80 of ~327 types dispatched and the rest filtered out.
- **LWC empty-bundle behavior change (Phase 1.5).** Per-bundle fetch failures now emit a `wedge:lwc:bundleFetchFailed:...` warning and NO record (previously: stub bundle with `files: {}`). Re-ingest after upgrade will remove previously-recorded empty bundles. This is correct.
- **Socket leak on wedged HTTP requests (jsforce 3.10.15 stop-waiting).** When the per-source watchdog fires, sfgraph releases the slot but the underlying jsforce HTTP request is NOT cancelled (jsforce does not expose `AbortController`). Wedged sockets are reaped by Node's idle-timeout (~10min). Worst case: 4 wedges × ~1MB ≈ 4MB transient memory per ingest, GC'd at process exit.

---

## Future hardening (cross-reference)

- **Bulk API migration** for large SOQL paths — deferred; profiling-gated. Bulk API has higher per-job overhead, so the migration is only worth it for the longest-tail label populations.
- **First-class extractors for `PermissionSetGroup` / `MutingPermissionSet` / `ProfileSessionSetting` / `ProfilePasswordPolicy`** — deferred to a future Security phase. Closing this gap requires modeling group composition (`INCLUDES_PERMSET`), mute semantics (`DENIES_*`), and session/password policy semantics that don't fit the current `GRANTS_*` schema.
- **jsforce upgrade or fork exposing `AbortController`** — needed for true in-flight HTTP cancellation; tracked in `.planning/STATE.md` backlog. Until then, the socket-leak caveat above applies.
- **Aura / VF deep parsing** — `AuraDefinitionBundle`, `ApexPage`, `ApexComponent` are currently Generic-Only. A first-class extractor would unlock LWC ↔ Aura embed edges and VF ↔ Apex controller edges. Deferred (low industry-cloud priority).
