# Metadata coverage

Coverage is **dynamic, not hardcoded**. At ingest start, `conn.metadata.describe(apiVersion)` asks the org for its full supported type list — which automatically includes any types added by installed managed packages or by new Salesforce releases. Each type is routed to either a code parser, a declarative YAML rule, or the generic opaque-node fallback.

**Code parsers (6, complex AST work)**: Apex, LWC, Flow, Object, 4 Vlocity JSON content parsers.

**Declarative rules (21 YAML files)**: Profile, PermissionSet, SharingRule, NamedCredential, ExternalServiceRegistration, PlatformEvent, ApexPage, ApexComponent, Layout, LightningPage, Report, Dashboard, GenAiPlanner, GenAiPlugin, Network, Workflow, ApprovalProcess, DuplicateRule, MatchingRule, CustomMetadataType, CustomLabel, PermissionSetGroup.

**Vlocity legacy industry clouds** — all 5 namespaces covered by a single vendored registry (`vlocity_build`'s `QueryDefinitions.yaml`, MIT, 48 DataPack types):

| Namespace | Industry cloud(s) |
|---|---|
| `vlocity_cmt` | Communications, Media, Energy & Utilities |
| `vlocity_ins` | Insurance |
| `vlocity_hc` | Health |
| `vlocity_ps` | Public Sector |
| `vlocity_fs` | Financial Services (legacy) |

**Anything else** — types `describeMetadata()` lists but no rule covers — emits an opaque NodeFact with raw fields so the agent can still answer "does X exist?". Zero-day coverage.

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

This works across Salesforce editions and industry clouds:
`AuthorizationFormConsent` (Health Cloud) returns `IsCustomizable=true` → included automatically. `AuthConfig` (SSO internal) returns false → skipped. No hardcoded list to maintain — Salesforce's own metadata tells us what's real.

### Layered filters (applied in order)

1. Companion tables (`*Feed`, `*History`, `*Share`, etc.) — always skipped.
2. `SYSTEM_SKIP_NAMES` hard blacklist (ApexLog, EventLogFile, etc.) — always skipped (acts as a ceiling even if EntityDefinition says otherwise).
3. Custom SObjects (`__c`, `__e`, `__b`, `__mdt`, `__x`, `__ka`, `__kav`, `__chn`) — always **included**. Covers user-owned and every managed-package custom object.
4. `EntityDefinition.IsCustomizable` filter — primary signal for non-custom SObjects.
5. Static `STANDARD_SOBJECT_WHITELIST` — fallback only if EntityDefinition query fails or returns 0 records (some scratch / dev orgs).

### Overrides

Bring back the full queryable surface (useful for diagnostic ingests):

```bash
SFGRAPH_INCLUDE_ALL_SOBJECTS=1 sfgraph ingest
```

`--debug` mode prints the EntityDefinition probe outcome on every run:

```
ingest: [debug] object EntityDefinition probe → 487 user-relevant SObjects classified
```

If you see `EntityDefinition unavailable — falling back to static whitelist`, your org's edition restricts that Tooling table and we use the curated list as a safe default.

Per-SObject escape hatch (skip a specific table that crashes describe):

```bash
SFGRAPH_SKIP_SOBJECT=BadTable,OtherBadTable sfgraph ingest
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

You'll see lines like this in `--debug` output:

```
ingest: [debug] lwc bundles total=1248 managed=973
ingest: [debug] lwc skip-managed clmAcceptAction (ns=vlocity_cmt; ...)
```

### Override knobs

```bash
SFGRAPH_INCLUDE_SYSTEM_SOBJECTS=1   # include ApexLog/EventLogFile/etc.
SFGRAPH_INCLUDE_MANAGED=1           # include managed-package source content globally
SFGRAPH_INCLUDE_MANAGED_LWC=1       # LWC-only override
SFGRAPH_SKIP_LWC=name1,name2        # skip specific LWC bundle DeveloperNames
SFGRAPH_INCLUDE_ALL_GENERIC=1       # invoke every metadata.describe() type, not just whitelist
```

### Per-describe timeout

Each `describe()` is wrapped in a 12-second hard timeout. A single pathological SObject whose response never returns no longer wedges the run; it's caught as a timeout and skipped while everything else proceeds.
