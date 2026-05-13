# Phase 7 — Capability-Driven, Declarative Parsers

> Status: planned. Replaces ~30 hand-coded parser files and a hardcoded
> bulk-retrieve fan-out with a runtime metadata-discovery flow, declarative
> rule files, and three parallel API pools. Apex / LWC / Flow keep their
> code parsers; everything else becomes data.

## Motivation

Today's Phase 2 design forces a new TypeScript file for every metadata type
we want to recognize. That's ~30 files and an ongoing maintenance burden
because:

1. **Salesforce + managed packages keep adding metadata types.** Every
   release ships new XML metadata types; every installed managed package
   adds more. Hardcoding the list means we lag behind reality.
2. **Vlocity has 7 industry clouds with different namespace prefixes** but
   the same DataPack schema. Today's probe only detects `vlocity_cmt`.
3. **Vlocity is in maintenance / sunset mode.** Salesforce's official
   direction is OmniStudio Standard Runtime. New types land in OmniStudio
   (which we cover via Metadata API), not in Vlocity. So Vlocity scope is
   bounded — vendor the registry once and stop chasing it.
4. **The runtime can tell us the type list.** `conn.metadata.describe(api)`
   returns every metadata type this org supports at this API version,
   including package-installed types. We should drive dispatch off that.
5. **jsforce hides the XSD.** When we call `conn.metadata.read('Profile',
   names)`, jsforce returns parsed JS objects whose shape matches the
   Metadata WSDL. We don't have to parse XML; we walk a JS tree. That
   makes declarative rules trivial.

## Goal

End state:

```
~6 code parsers   (Apex, LWC, Flow, Object, plus 4 Vlocity JSON content parsers)
~25 rule files    (Profile, PermSet, Layout, Report, Workflow, ApprovalProcess,
                   ApexPage, LightningPage, GenAiPlanner/Plugin, etc.)
1 generic fallback (opaque-node for any unknown type)
1 vendored YAML   (Vlocity QueryDefinitions.yaml; covers all 5 industry namespaces)
3 parallel pools  (Tooling / Metadata / SObject — separate rate-limit budgets)
1 embedder pool   (batched transformers.js inference; runs alongside parsing)
```

Adding support for a new metadata type becomes:
- For a typical XML/SObject type: drop a YAML rule file, write 1 golden fixture
- For something complex (new AST format): write a code parser following the
  existing `Parser` interface

The dispatch is dynamic — if Salesforce ships a new type tomorrow,
`describeMetadata()` returns it and the generic fallback emits opaque-node
records until we author a specific rule. Zero-day coverage.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Type-list source | `conn.metadata.describe(apiVersion)` at ingest start. Cached for the session. |
| 2 | XSD parsing | None on our side. Trust jsforce to deserialize via the bundled WSDL. Rules consume JS objects, not XML. |
| 3 | Selector language | JSONPath-style (`${record.field}`, `${item.x}`) evaluated against jsforce-parsed JS objects. Use the `jmespath` library. |
| 4 | Rule file format | YAML, validated by a zod schema at load time. Errors fail at startup, never mid-ingest. |
| 5 | Vlocity registry | Vendor `vlocity_build/dataPacksJobs/QueryDefinitions.yaml` (MIT). Re-sync quarterly via CI. |
| 6 | Vlocity namespaces | Probe 5: `vlocity_cmt`, `vlocity_ins`, `vlocity_hc`, `vlocity_ps`, `vlocity_fs`. Multi-namespace installs supported. |
| 7 | API pools | Three: Tooling SOQL (5 concurrent), Metadata retrieve+poll (3 concurrent), SObject SOQL/Bulk (10 concurrent). Each with its own Bottleneck + 429 retry. |
| 8 | Code parsers retained | Apex (AST), LWC (Babel + parse5), Flow (deep XML), Object (sfdx-source dir layout), 4 Vlocity JSON content parsers (procedure trees). |
| 9 | Embedding pipeline | Dedicated piscina pool with batched transformers.js (16-32 texts per call). Side-stream from parsers, doesn't block. |
| 10 | Backwards compatibility | Existing parser tests must produce byte-identical output after migration. No semantic changes to NodeFact/EdgeFact shape. |

## Architecture

```
liveIngest()
  │
  ├─ 1. resolveOrg() ─────────────────────►  read-only proxy wraps conn
  │
  ├─ 2. probeCapabilities() ──────────────►  OrgCapabilities {
  │                                            vlocityNamespaces: [...],
  │                                            omnistudioOncore, sourceTracking,
  │                                            agentforce, experienceCloud, ...
  │                                          }
  │
  ├─ 3. discoverMetadataTypes() ──────────►  DescribedType[] from metadata.describe()
  │
  ├─ 4. buildDispatchTable() ─────────────►  { 'ApexClass': toolingSoql,
  │                                            'Profile':   metadataReadList,
  │                                            'DataRaptor': sobjectSoql,
  │                                            ... }
  │
  ├─ 5. snapshotStore.create({kind:'pre-sync'})
  │
  ├─ 6. Three pools running concurrently:
  │     ├─ toolingPool   → Apex, LWC, Flow extractors
  │     ├─ metadataPool  → list + read for everything else
  │     └─ dataPool      → Vlocity (per detected namespace) + CMDT records
  │
  ├─ 7. For each RawMember:
  │     ├─ Look up parser via registry (by metadata type)
  │     ├─ Code parser? Run it.
  │     ├─ Rule file? Run RuleBasedParser.
  │     ├─ Unknown? Generic-opaque-node rule emits `{ qname, raw_props }`.
  │     └─ Push embedding job onto embedding queue.
  │
  ├─ 8. embeddingPool (parallel side-stream):
  │     ├─ Pull batch of 16-32 from queue
  │     ├─ Run transformers.js mean-pooled embedding
  │     └─ vectorStore.upsertNodeVector()
  │
  ├─ 9. crossFlavorResolver() ────────────►  CANONICAL_OF edges
  │
  ├─ 10. populateAnalysisTables() ────────►  findings, dead-code, governor risks
  │
  └─ 11. graphStore.touchSync(); snapshot.prune()
```

## File layout

```
packages/core/src/
  extractors/live-org/
    capabilities.ts                       # extended: vlocityNamespaces[]
    discovery.ts                          # NEW: describeMetadata() wrapper
    dispatch.ts                           # NEW: type → fetch-strategy table
    rate-limit.ts                         # extended: 3 pools instead of 1
    bulk-retrieve.ts                      # rewritten to use dispatch
    vlocity/
      query-definitions.yml               # VENDORED from vlocity_build (MIT)
      LICENSE-VLOCITY-BUILD.txt
      runner.ts                           # NEW: YAML-driven extractor
    extractors/
      apex.ts                             # unchanged
      lwc.ts                              # unchanged
      flow.ts                             # unchanged
      object.ts                           # unchanged
      generic-metadata.ts                 # NEW: metadata.list + read for any type
      generic-sobject.ts                  # NEW: SOQL for any SObject-backed type

  parsers/
    contract.ts                           # unchanged
    registry.ts                           # unchanged (still the Map)
    apex/                                 # KEEP (code)
    lwc/                                  # KEEP (code)
    flow/                                 # KEEP (code)
    object/                               # KEEP (code)
    vlocity/                              # KEEP (4 JSON content parsers)
    rules/                                # NEW: declarative rule files
      _engine.ts                          # RuleBasedParser
      _loader.ts                          # YAML loader + zod validation
      _selectors.ts                       # JSONPath evaluator (jmespath wrapper)
      _schema.ts                          # zod schema for rule format
      _generic-opaque.ts                  # fallback rule
      profile.yml
      permission-set.yml
      sharing-rule.yml
      named-credential.yml
      external-service-registration.yml
      platform-event.yml
      apex-page.yml
      apex-component.yml
      layout.yml
      lightning-page.yml
      report.yml
      dashboard.yml
      gen-ai-planner.yml
      gen-ai-plugin.yml
      network.yml
      workflow.yml
      approval-process.yml
      duplicate-rule.yml
      custom-metadata-type.yml
      custom-label.yml
      permission-set-group.yml
      __tests__/
        engine.test.ts
        loader.test.ts
        selectors.test.ts
        rule-fixtures.test.ts

  embedding/                              # NEW
    pool.ts                               # piscina pool + batched inference
    queue.ts                              # async queue parsers push to
    worker.ts                             # piscina worker entry
    __tests__/
      pool.test.ts
```

## Rule file format

```yaml
# packages/core/src/parsers/rules/profile.yml
type: Profile
category: security
input: object                              # the jsforce-parsed JS object

applies_when:
  always: true                             # or { capability: vlocityCmt }
                                           # or { not: { capability: omnistudioOncore } }
                                           # or { any_of: [...] } / { all_of: [...] }

nodes:
  - label: Profile
    qname: "Profile:${record.fullName}"
    props:
      userType: "${record.userType}"
      description: "${record.description}"
      userLicense: "${record.userLicense}"

edges:
  - relType: GRANTS_OBJECT_ACCESS
    iterate: "${record.objectPermissions}"
    when: "${item.allowRead || item.allowEdit}"
    src: "Profile:${record.fullName}"
    dst: "CustomObject:${item.object}"
    props:
      readable: "${item.allowRead}"
      editable: "${item.allowEdit}"
      createable: "${item.allowCreate}"
      deletable: "${item.allowDelete}"

  - relType: GRANTS_FIELD_ACCESS
    iterate: "${record.fieldPermissions}"
    when: "${item.readable || item.editable}"
    src: "Profile:${record.fullName}"
    dst: "CustomField:${item.field}"
    props:
      readable: "${item.readable}"
      editable: "${item.editable}"

  - relType: GRANTS_APEX_ACCESS
    iterate: "${record.classAccesses}"
    when: "${item.enabled}"
    src: "Profile:${record.fullName}"
    dst: "ApexClass:${item.apexClass}"
```

### Zod schema (high-level)

```ts
const RuleSchema = z.object({
  type: z.string(),
  category: z.string(),
  input: z.enum(['object', 'json', 'xml-string']),
  applies_when: z.union([
    z.object({ always: z.literal(true) }),
    z.object({ capability: z.string() }),
    z.object({ not: WhenSchema }),
    z.object({ any_of: z.array(WhenSchema) }),
    z.object({ all_of: z.array(WhenSchema) }),
  ]),
  variants: z.array(z.object({
    when: WhenSchema,
    bindings: z.record(z.string()),       // namespace prefix etc.
  })).optional(),
  nodes: z.array(NodeRuleSchema),
  edges: z.array(EdgeRuleSchema),
});
```

## Selector evaluator

Use `jmespath` library (small, MIT-licensed, well-tested). Selector strings
are JSONPath-style: `${record.fullName}`, `${item.allowRead}`.

For interpolation in a string template, the engine:
1. Finds all `${...}` segments
2. Evaluates each against `{ record, item, ns, caps }` context
3. Concatenates results as strings

The `${ns.vlocity_cmt}` interpolation reads from the detected namespaces
bag, so rule files can adapt to the org's installed packages.

## Vlocity registry

Source: [`vlocity_build/dataPacksJobs/QueryDefinitions.yaml`](https://github.com/vlocityinc/vlocity_build/blob/master/dataPacksJobs/QueryDefinitions.yaml)

Vendored to `packages/core/src/extractors/live-org/vlocity/query-definitions.yml`.

Format (excerpt):
```yaml
DataRaptor:
  VlocityDataPackType: DataRaptor
  query: Select Id, Name from %vlocity_namespace%__DRBundle__c where %vlocity_namespace%__Type__c != 'Migration'
IntegrationProcedure:
  VlocityDataPackType: IntegrationProcedure
  query: Select Id, ... from %vlocity_namespace%__OmniScript__c where %vlocity_namespace%__IsProcedure__c = true
# ~50 entries
```

License: MIT (same as `vlocity_build`). Vendored with attribution comment +
`LICENSE-VLOCITY-BUILD.txt`.

Runtime usage:
1. Load YAML once at module init
2. For each detected `vlocity_namespace`:
3.   For each YAML entry:
4.     Substitute `%vlocity_namespace%` → `${namespace}__`
5.     Run SOQL → stream RawMember records into the parser pipeline

## Capability probe extension

```ts
interface OrgCapabilities {
  apiVersion: string;
  detectedNamespaces: string[];           // all installed package namespaces

  // Existing
  vlocityCmt: boolean;                    // back-compat alias for 'vlocity_cmt' in vlocityNamespaces
  omnistudioOncore: boolean;
  agentforce: boolean;
  experienceCloud: boolean;
  sourceTracking: boolean;

  // NEW in Phase 7
  vlocityNamespaces: string[];            // subset of detectedNamespaces matching ['vlocity_cmt','vlocity_ins','vlocity_hc','vlocity_ps','vlocity_fs']
  vlocityLegacy: boolean;                 // vlocityNamespaces.length > 0
}

const VLOCITY_NAMESPACE_CANDIDATES = [
  'vlocity_cmt',                          // Communications, Media, Energy & Utilities
  'vlocity_ins',                          // Insurance
  'vlocity_hc',                           // Health
  'vlocity_ps',                           // Public Sector
  'vlocity_fs',                           // Financial Services (legacy)
] as const;
```

## Three parallel API pools

```ts
// rate-limit.ts (rewritten)
export const toolingPool  = new Bottleneck({ maxConcurrent: 5,  minTime: 50  });
export const metadataPool = new Bottleneck({ maxConcurrent: 3,  minTime: 100 });  // retrieve is slow + async
export const dataPool     = new Bottleneck({ maxConcurrent: 10, minTime: 50  });

// Each pool has its own 429 + Retry-After handler.
// Sustained: tooling 20 req/s, metadata 10 req/s, data 20 req/s.
// Peak concurrent: ~18 in-flight SF calls without violating per-API limits.
```

## Embedding worker pool

```ts
// embedding/pool.ts
const pool = new Piscina({
  filename: resolve(here, 'worker.js'),
  minThreads: 1,
  maxThreads: 4,
  idleTimeout: 60_000,
});

// embedding/queue.ts
class EmbeddingQueue {
  push(qname: QualifiedName, text: string): void;
  // Drains by pulling batches of 16-32 from the queue, calling pool.run({texts}),
  // and writing results to VectorStore.
}
```

Parsers don't await embeddings; they push and continue. The pool drains
concurrently. For a 50K-node org, ~10K bundle-level embeddings is ~20s on a
single thread, ~5-7s across 4 threads. Fully overlapped with parsing.

## Migration plan (per commit)

### Commit A — Vlocity multi-namespace + vendored registry

**Files added**
- `packages/core/src/extractors/live-org/vlocity/query-definitions.yml`
- `packages/core/src/extractors/live-org/vlocity/LICENSE-VLOCITY-BUILD.txt`
- `packages/core/src/extractors/live-org/vlocity/runner.ts`

**Files modified**
- `packages/core/src/extractors/live-org/capabilities.ts`
  - Extend `OrgCapabilities` with `vlocityNamespaces[]`, `vlocityLegacy`
  - Probe all 5 candidate namespaces
  - Keep `vlocityCmt` as a back-compat alias
- `packages/core/src/extractors/live-org/extractors/vlocity.ts`
  - Becomes a thin wrapper around `vlocity/runner.ts`
  - Iterates over `caps.vlocityNamespaces`

**Files removed**: none (the existing Vlocity parsers stay; only the extractor changes).

**Tests added** (~5)
- YAML loader produces 50+ entries
- Namespace substitution: `%vlocity_namespace%` → `vlocity_ins`
- Multi-namespace probe: org with both `vlocity_cmt` and `vlocity_ins` yields records from both
- Empty namespace list: extractor is a no-op (no requests made)
- Probe gracefully falls back when an sObject doesn't exist

**Exit gate**
- All existing tests green
- `OrgCapabilities.vlocityNamespaces` populated correctly across cases
- Net zero regressions in Vlocity ingest path

### Commit B — describeMetadata-driven dispatch + three pools

**Files added**
- `packages/core/src/extractors/live-org/discovery.ts` — `discoverMetadataTypes(conn)`
- `packages/core/src/extractors/live-org/dispatch.ts` — fetch-strategy table
- `packages/core/src/extractors/live-org/extractors/generic-metadata.ts` — metadata.list + read for any type
- `packages/core/src/extractors/live-org/extractors/generic-sobject.ts` — SOQL for any SObject-backed type

**Files modified**
- `packages/core/src/extractors/live-org/rate-limit.ts` — split into 3 pools
- `packages/core/src/extractors/live-org/bulk-retrieve.ts` — rewrite to use dispatch
- `packages/core/src/ingest/live-ingest.ts` — call `discoverMetadataTypes` before fan-out

**Tests added** (~8)
- `discoverMetadataTypes` returns parsed list with xmlName/suffix/directoryName
- `dispatch.routeFor('ApexClass')` returns `toolingSoql` strategy
- `dispatch.routeFor('Profile')` returns `metadataReadList`
- `dispatch.routeFor('vlocity_cmt__DRBundle__c')` returns `sobjectSoql`
- Unknown type routes to generic fallback (emits opaque-node)
- Three pools enforce separate concurrency limits
- 429 retry on each pool independently
- Mock org with new MDAPI type: ingest emits opaque-node, doesn't crash

**Exit gate**
- All existing tests green
- New mock orgs with 50+ types complete ingest in same wall-time as before
- Generic-opaque emits valid NodeFact for any type the dispatch doesn't know

### Commit C — Declarative rule engine + long-tail migration + embedding pool

**Files added**
- `packages/core/src/parsers/rules/_engine.ts` — `RuleBasedParser`
- `packages/core/src/parsers/rules/_loader.ts` — YAML loader + zod validation
- `packages/core/src/parsers/rules/_selectors.ts` — JSONPath evaluator
- `packages/core/src/parsers/rules/_schema.ts` — zod schemas for rule format
- `packages/core/src/parsers/rules/_generic-opaque.ts` — fallback rule
- 20 rule files (one per migrated parser)
- `packages/core/src/embedding/pool.ts`, `queue.ts`, `worker.ts`

**Files modified**
- `packages/core/src/parsers/index.ts` — load rules on barrel import
- `packages/core/src/ingest/live-ingest.ts` — wire embedding queue

**Files removed**
- The 15 Phase-6 long-tail TS parsers (now YAML)
- The 6 Phase-2 trivial parsers: profile.ts, permission-set.ts, sharing-rule.ts, named-credential.ts, external-service-registration.ts, platform-event.ts

**Files KEPT as code** (genuinely complex)
- All Apex parsers (AST extraction)
- All LWC parsers (Babel + parse5 + XML)
- All Flow parsers (deep nested XML)
- All Object parsers (sfdx-source dir handling)
- 4 Vlocity JSON content parsers (procedure trees)

**Tests added** (~25)
- Rule loader: valid rule loads cleanly
- Rule loader: invalid rule (missing required field) fails at startup with clear error
- Rule loader: unknown REL_TYPE rejected
- Selector: nested object access, array iteration, conditional `when`
- Selector: undefined-safe (missing fields return empty string, not throw)
- Engine: rule produces same output as the old TS parser (golden re-point)
- Engine: variants with `${ns.X}` interpolation work for multi-namespace
- Generic-opaque emits NodeFact with raw props for any unknown type
- Embedding queue: push/drain
- Embedding pool: batched inference produces 384-dim vectors
- Embedding pool: graceful when transformers not installed (logs warning, no crash)

**Golden tests re-pointed** (15+6 = 21)
- All 21 migrated parsers' existing golden fixtures now run against
  `RuleBasedParser` instead of the deleted TS parser. Outputs must match
  byte-for-byte (deterministic via `stripVolatile` + sort).

**Exit gate**
- All 300+ existing tests green
- Total new tests ~38 across the three commits
- Parser test suite still under 30s
- 50K perf test still under 5s
- Rule engine handles 100% of migrated parsers; output bit-identical
- Embedding pool runs without blocking ingest

## Out of scope (deferred to v1.1 or beyond)

- **OmniStudio standard runtime parsers**: covered by `describeMetadata`
  dispatch + generic-metadata extractor today. Rules can be added incrementally.
- **Discovery Framework, CDP data streams, CMS Content, Einstein Discovery**:
  hybrid SObject + REST types. Generic-sobject extractor handles them with
  raw-props nodes; specific rules to be added on demand.
- **XSD validation against the WSDL**: not needed; we trust jsforce.
- **HTTP telemetry sink**: telemetry stays local-only, per privacy pillar.
- **Real-org integration smoke testing**: user-owned.
- **ONNX model vendoring**: existing Phase 5 hook (`pnpm models:refresh`)
  unchanged.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Rule format proves too restrictive for some types | Variants block + JS-expression fallback in selectors. If a real edge case appears, drop to a code parser. |
| Selector evaluator perf hit on 50K nodes | Benchmark in Commit C. If hot, switch from jmespath to inline closure compilation. Storage layer not affected. |
| `describeMetadata` returns types we can't fetch (deprecated, restricted) | Wrap each `metadata.list/read` in try/catch; log + emit zero records for that type. Never abort the ingest. |
| Embedding pool can't load transformers on user's machine | Pool is lazy; absence logs a warning and ingest continues without vectors. Tools that need vectors (search) surface a clear error. |
| Vlocity YAML upstream changes break our parser | Quarterly CI job re-fetches; opens a PR with the diff for human review. |

## Final test target

- Phase 6 end: 298 passing + 6 skipped
- Phase 7 Commit A: +5 → 303 passing + 6 skipped
- Phase 7 Commit B: +8 → 311 passing + 6 skipped
- Phase 7 Commit C: +25 → 336 passing + 6 skipped (21 of those are re-pointed goldens; net new ~25)

## Documentation updates after Phase 7

- `README.md`: update the "metadata coverage" section to reflect the dynamic
  discovery model. Update "how analysis works" with the new dispatch flow.
  Update the on-disk file layout if anything moved.
- `docs/TOOLS.md`: no changes; tool surface is unchanged.
- `docs/SKILLS.md`: no changes.
- `docs/PRIVACY.md`: add the "telemetry is local-only by design" clarifier
  in the telemetry section so users don't expect data to be uploaded.
