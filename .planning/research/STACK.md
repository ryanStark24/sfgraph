# Stack Research

**Domain:** Salesforce metadata graph + dependency analysis tooling (sfgraph fork hardening; Waves 2 & 3)
**Researched:** 2026-05-17
**Confidence:** MEDIUM-HIGH (npm versions verified live against registry on 2026-05-17; SARIF 2.1.0 Errata 01 spec verified at OASIS; PMD schema verified as XML-not-YAML; Salesforce SOQL/MCD constraints from training data + community sources — flagged LOW where applicable)

> **Scope:** This document recommends only the *new* libraries and schemas needed to land Wave 2 and Wave 3. The existing stack (TypeScript / Node 20+ / apex-parser / Babel / parse5 / fast-xml-parser / better-sqlite3 / sqlite-vec / Bottleneck / jsforce / @salesforce/core / 3d-force-graph) is locked per PROJECT.md "Constraints" and is **not** re-researched here.

---

## Recommended Stack — Wave 2 (Capability gaps)

### W2-01: OmniStudio overlap detector

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| (none — pure TypeScript) | — | Signature-comparison pass over already-parsed OmniProcess/IP/DR nodes | Overlap detection is a graph-walk + set-difference problem; adding a library here is over-engineering. The existing `domain/edge-fact.ts` and post-merge resolver chain in `resolveCrossFlavor` is the entire surface. Confidence: HIGH. |

**Do NOT pick:** jsondiffpatch, deep-diff, fast-json-patch. They produce noisy structural diffs; overlap detection needs *semantic* equivalence (e.g. an OmniScript step calling DR `Foo` overlaps with an IP step calling DR `Foo`), not field-by-field JSON diff.

---

### W2-02: OmniStudio-on-Core `retrieve()` extractor

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **`@salesforce/source-deploy-retrieve` (SDR)** | **^12.35.10** (published 2026-05-17, daily-released) | Wraps Metadata API retrieve(), generates package.xml, unzips MDAPI ZIPs, exposes typed metadata registry (covers OmniStudio types: OmniIntegrationProcedure, OmniDataTransform, OmniUiCard, OmniScript) | Officially maintained by Salesforce CLI team; same lineage as `sf project retrieve`. Handles ZIP-stream parsing and package.xml generation natively — exactly what W2-02 (retrieve envelope) and W3-03 (`package.xml` follow-up tool) both need. Composes cleanly with the existing `@salesforce/core@^8.30.0` Connection. Confidence: HIGH (verified on npm + github.com/forcedotcom/source-deploy-retrieve). |
| **`jszip`** | **^3.10.1** | Fallback ZIP unpacking if SDR's stream API is awkward for the retrieve-result envelope | Pure-JS, no native deps, works in the worker pool. Optional — only pull in if SDR's `ComponentSet.retrieve()` doesn't expose raw entries. Confidence: HIGH. |

**Do NOT pick:**
- **`jsforce-metadata-tools` (1.3.1)** — last published 2022-06-19, unmaintained. Confidence: HIGH (verified npm date).
- **Hand-rolled `conn.metadata.retrieve()` via jsforce alone** — jsforce gives you the AsyncResult but you re-implement polling, retry, ZIP unpack, and package.xml generation. SDR is the de-facto standard for this in the SF ecosystem.
- **`adm-zip`** — synchronous file-system-first API; doesn't fit the streaming pattern in `extractors/live-org/extractors/`. Use jszip if SDR isn't enough.

---

### W2-03: MCD fast-path baseline extractor

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **`jsforce` Tooling API** | **^3.10.14** (already installed) | Query `MetadataComponentDependency` via `conn.tooling.query()` | Already the project's Tooling SOQL client. No new library needed. Confidence: HIGH. |

**Schema constraints to encode in the extractor (verify before shipping — these are well-known in the Salesforce dev community but Salesforce's own docs page is opaque):**
- MCD returns at most ~2000 rows per query; pagination via `queryMore` is documented in jsforce.
- Queries should filter by `RefMetadataComponentId` (or `MetadataComponentId`) for predictable result sets.
- MCD does **not** cover all metadata types — Layouts, FieldSets, EmailTemplates, Tabs, Groups/Queues are the documented gaps W2-04 backfills. Confidence: MEDIUM (community-validated; Salesforce does not publish a complete coverage matrix).

**Do NOT pick:** Salesforce Dependency API beta endpoints — flaky, not GA, and MCD is the supported path.

---

### W2-04: Happy Soup MCD gap-fills

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| (none — pure TypeScript over existing parsers) | — | `createLookupFieldDependencies`, `createValueSetDependencies`, `createControllingPicklistDependencies`, `isDynamicReference` heuristic | Re-implementing documented behavior on top of existing `parsers/object/` and `fast-xml-parser` Flow output. **Critically: re-implement, do NOT vendor — Happy Soup is AGPL-3.0; this fork is Apache-2.0 (per PROJECT.md "License surface").** Confidence: HIGH. |

**Do NOT pick:** Vendoring `lukecotter/HappySoup-online` source files. License incompatibility. Re-implement from documented behavior only.

---

### W2-05: `tryWithSmallerQueries` auto-rebatcher

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| (none — pure TypeScript wrapper over `jsforce` + `Bottleneck`) | — | Detect HTTP 414/431 and >300 ID IN-clause, bisect query, retry | The existing `MAX_BISECT_DEPTH=6` adaptive pattern in `extractors/live-org/metadata-bisect.ts` is the model. Re-apply to Tooling SOQL paths. No new library. Confidence: HIGH. |

---

### W2-06: Composite-subrequest batching (25 per request) for `metadata.read`

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **`jsforce` Composite API** | **^3.10.14** (already installed) | `conn.request({ url: '/services/data/vXX.0/composite', ... })` with up to 25 subrequests | jsforce 3.x exposes the Composite endpoint via `conn.requestPost`. Salesforce's documented hard cap is **25 subrequests per composite call** — encode as a constant, not a tunable. Confidence: HIGH (Salesforce REST API guide). |

**Do NOT pick:**
- A separate REST client (`got`, `undici`, `axios`) — would duplicate auth, retry, and refresh-token logic already handled by jsforce/@salesforce/core. Confidence: HIGH.
- Composite Graph API (different endpoint, allows up to 500 nodes but with referential dependency constraints). Composite is the right tool for parallel independent reads; Graph is for ordered DML chains.

---

## Recommended Stack — Wave 3 (Distribution & Interop)

### W3-01: PMD-aligned YAML rule schema

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **`yaml`** | **^2.9.0** (already installed) | Continue parsing the 21 existing YAML rule files; only the *field names* change to align with PMD vocabulary | The fork's design choice (per PROJECT.md "Out of Scope" — "keep YAML; PMD alignment in W3-01 expands the schema rather than replacing the language") explicitly diverges from PMD's XML format. Confidence: HIGH. |
| **`zod`** | **^3.25.76** (already installed) | Validate rule files against the PMD-aligned schema at load time | Already used for MCP tool I/O schemas. Stay on Zod 3 — Zod 4 (^4.4.3) is stable but adopting it triggers a churn-y migration across all tool schemas; not worth doing in this milestone. Confidence: HIGH. |

**PMD canonical fields to mirror in YAML keys** (from PMD's public ruleset XML schema — `pmd-code.org` docs):
- `name` — rule identifier (required, unique within ruleset)
- `message` — single-line violation message, supports `${variable}` interpolation
- `description` — long-form CDATA / multiline
- `priority` — integer 1 (high) → 5 (low)
- `externalInfoUrl` — link to docs
- `properties` — typed `<property name="..." type="..." value="..."/>` list; in YAML, model as `properties: { foo: { type: 'string', value: 'bar', description: '...' } }`
- `example` — code block(s)

Confidence: MEDIUM-HIGH (PMD docs verified to use XML; field list synthesized from PMD's public rule reference. Validate against one canonical PMD rule like `EmptyCatchBlock` before locking the schema.)

**Do NOT pick:**
- **Converting rules to PMD XML format** — out of scope per PROJECT.md; loses the readability advantage of YAML.
- **JSON Schema (ajv)** — Zod is already in the dep tree; adding a second schema validator doubles the surface for no gain. Confidence: HIGH.

---

### W3-02: SARIF 2.1.0 emitter

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **`@types/sarif`** | **^2.1.7** (published 2025-08-03) | TypeScript types for SARIF 2.1.0 Log/Run/Result/Rule shapes; DefinitelyTyped maintained, matches Microsoft's authoritative TS interfaces | Lets you build SARIF JSON as typed objects (no string concatenation). Microsoft uses the same types internally. Confidence: HIGH (verified npm). |
| **Hand-rolled emitter in `render/sarif.ts`** | — | Construct `SarifLog` object using `@types/sarif`, `JSON.stringify` to file | A SARIF Log is a ~6-field tree; a generator library adds dependency surface for negligible value. The pattern Microsoft endorses (per SARIF tutorial samples) is "build the object literal in your language's natural way." Confidence: HIGH. |
| **`ajv`** | **^8.20.0** | One-time validation of emitted SARIF against the official 2.1.0 JSON schema during CI/tests | Schema URL: `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json` (verified at OASIS). Confidence: HIGH. |

**Do NOT pick:**
- **`node-sarif-builder` (^4.1.0)** — actively maintained (2026-04-19), but adds a thin builder facade over what is fundamentally an object literal. The maintainer's own README recommends hand-construction for non-trivial cases. Skip unless prototyping. Confidence: MEDIUM.
- **`@microsoft/sarif-multitool` (^4.6.4)** — this is a CLI conversion tool (XML/CSV → SARIF), not a library. Useful for *test fixtures* (convert PMD/ESLint output to expected SARIF for golden tests) but not a runtime dep. Confidence: HIGH.
- **`sarif-builder`** — does not exist on npm (verified). Confidence: HIGH.

**Schema URL to embed in emitted logs:**
```json
"$schema": "https://json.schemastore.org/sarif-2.1.0.json",
"version": "2.1.0"
```

---

### W3-03: `package.xml` generator wired as `follow_up_tool`

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **`@salesforce/source-deploy-retrieve`** | **^12.35.10** | `ComponentSet#getPackageXml()` produces the canonical package.xml for any set of components | Same dep introduced for W2-02; no incremental install cost. Output is guaranteed valid because SDR is what `sf project deploy` itself uses. Confidence: HIGH. |
| (fallback) `fast-xml-parser` | ^5.8.0 (already installed) | Emit hand-rolled package.xml if SDR's typeshape doesn't fit | Already in tree; `XMLBuilder` covers the simple `<types><members>...<name>...` shape. Confidence: HIGH. |

**Do NOT pick:** A standalone "package.xml generator" npm package — none have meaningful adoption and SDR is authoritative.

---

### W3-04: Glob-selector `find_nodes` MCP tool

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **`micromatch`** | **^4.0.8** | Compile glob patterns like `apex.Class.Foo.*` and `salesforce.Flow.instance.Lead_*` into matcher functions over node qualifiedName | The most widely-used (1B+ weekly downloads) and feature-rich glob lib in Node. Supports `*`, `**`, `?`, `[abc]`, `{a,b}`, `!negation`, and extglobs. Battle-tested in mocha, gulp, jest, fast-glob. Confidence: HIGH (verified npm 2024-09-18 release, still current stable). |
| **`picomatch`** | **^4.0.4** | Lower-level matcher under micromatch; use directly only if you need single-pattern hot path | picomatch is the engine behind micromatch. For single-pattern selectors, picomatch is ~10× faster. For the MCP `find_nodes` tool which accepts a single user pattern, prefer **picomatch directly**. Confidence: HIGH (npm verified 2026-03-24). |

**Recommendation:** Use **picomatch** for `find_nodes` (single-pattern, hot path, sub-second SLA per PROJECT.md). Reserve micromatch for the rule engine if rules ever take multi-pattern selector arrays.

**Do NOT pick:**
- **`minimatch` (^10.2.5)** — older, slower than picomatch, but bundled with npm itself so often "free." Picomatch's extglob support and speed win. Confidence: HIGH.
- **`fast-glob` (^3.3.3)** — filesystem-oriented; designed to walk directory trees. Wrong shape for matching against an in-memory list of qualifiedNames. Confidence: HIGH.
- **Hand-rolled regex** — globstar (`**`) and brace expansion (`{a,b}`) are the hard parts; don't reinvent. Confidence: HIGH.

---

### W3-05: ElemID rename stability

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| (none — schema change in `better-sqlite3` storage layer) | — | Add `elem_id_map(org_id, service_id, qualified_name, first_seen, last_seen)` table; on ingest, `UPDATE edges SET src/dst WHERE service_id = ?` on rename | Pure DDL + 2 statements in the existing storage layer. No new library. Salto's NaCl model is the inspiration but the implementation is a single index. Confidence: HIGH. |

---

## Supporting Libraries (cross-wave)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/sarif` | ^2.1.7 | SARIF TS types | W3-02 only |
| `@salesforce/source-deploy-retrieve` | ^12.35.10 | Metadata retrieve(), package.xml | W2-02, W3-03 |
| `picomatch` | ^4.0.4 | Single-pattern glob matcher | W3-04 |
| `ajv` | ^8.20.0 (dev) | SARIF schema validation in tests | W3-02 tests only |
| `jszip` | ^3.10.1 (optional) | ZIP entry walking if SDR's API insufficient | W2-02 fallback |

## Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `@microsoft/sarif-multitool` | CLI to convert/validate SARIF; produce golden fixtures | Install globally for dev only; don't add to package deps |
| Existing: vitest, biome, tsc | — | No additions needed |

---

## Installation

```bash
# Wave 2 — runtime
pnpm --filter @ryanstark24/sfgraph-core add \
  @salesforce/source-deploy-retrieve@^12.35.10

# Wave 2 — optional fallback for ZIP handling
pnpm --filter @ryanstark24/sfgraph-core add jszip@^3.10.1

# Wave 3 — runtime
pnpm --filter @ryanstark24/sfgraph-core add \
  picomatch@^4.0.4

# Wave 3 — dev-only (types + SARIF validation in tests)
pnpm --filter @ryanstark24/sfgraph-core add -D \
  @types/sarif@^2.1.7 \
  @types/picomatch@^3.0.0 \
  ajv@^8.20.0
```

> Versions verified live against `npm view <pkg> version` on 2026-05-17.

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `@salesforce/source-deploy-retrieve` | Hand-rolled `jsforce` `conn.metadata.retrieve()` + `jszip` | If SDR's ESM interop with the existing Node 20 build is rough; jsforce path is well-understood already. |
| `picomatch` (single-pattern) | `micromatch` | If `find_nodes` ever accepts arrays of patterns (multi-rule batches). |
| Hand-rolled SARIF object literals | `node-sarif-builder` | Rapid prototyping the first `export_sarif` tool before committing to a typed layout. Throw away once stable. |
| Re-implement Happy Soup gap-fills | Vendor + relicense negotiation | Never — AGPL incompatibility is dispositive. |
| Zod 3 (stay) | Zod 4 (^4.4.3) | Next milestone, as a dedicated migration; not bundled with W3-01. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `jsforce-metadata-tools` | Last release 2022-06-19 (verified npm); unmaintained | `@salesforce/source-deploy-retrieve` |
| `sarif-builder` | Does not exist on npm (verified) | Hand-rolled emitter with `@types/sarif` |
| `node-sarif-builder` for production | Thin wrapper over object construction; adds dep with no leverage | Build the SARIF Log as a typed object literal |
| `@microsoft/sarif-multitool` as a runtime dep | CLI tool, not a library | Use only as a dev tool for fixture generation |
| `adm-zip` | Synchronous, FS-coupled API mismatches streaming extractor pattern | `jszip` (only if SDR insufficient) |
| `minimatch` | Slower than picomatch on the same patterns; fewer extglob features | `picomatch` |
| `fast-glob` | Filesystem-walker, not an in-memory string matcher | `picomatch` for in-memory node-name matching |
| Vendoring Happy Soup TS source | Original is AGPL-3.0; this fork is Apache-2.0 | Re-implement from documented behavior |
| PMD XML rule format | Out of scope per PROJECT.md; loses YAML readability win | Expand existing YAML schema to mirror PMD field *names* |
| `axios`/`got`/`undici` for Composite API | Duplicates auth/refresh-token logic in jsforce | `jsforce` `conn.request()` / `requestPost()` |
| Custom CQL/SQL DSL | Out of scope per PROJECT.md "Out of Scope" | Glob selectors (W3-04) + existing 26 MCP tools |
| Global atomic ingest transaction | 5+ min DB lock; existing per-resolver isolation is correct | Keep per-resolver try/catch |

---

## Stack Patterns by Variant

**If OmniStudio-on-Core is detected (no `vlocity_cmt__` namespace):**
- Use SDR `ComponentSet.retrieve()` with the OmniStudio metadata types (`OmniIntegrationProcedure`, `OmniDataTransform`, `OmniUiCard`)
- Because: SOQL on `OmniProcess` exposes only runtime state; design-time fields (`PropertySetConfig`, version strings) only appear in the retrieved XML envelope. (W2-02)

**If MCD coverage is sufficient for the metadata type (Apex, Flow, ApexTrigger, AuraDefinitionBundle, LightningComponentBundle, CustomField, ValidationRule, etc.):**
- Use the MCD fast-path; tag edges `attributes.source: 'mcd'`
- Parsed-source edges win on overlap (per W2-03 merge rule)

**If MCD coverage is missing (Layouts, FieldSets, EmailTemplates, Tabs, Groups/Queues):**
- Use the parsed-source path + Happy Soup gap-fills
- Tag `attributes.source: 'parsed'`

**If a Tooling SOQL fails with HTTP 414/431 or >300 IN-clause IDs:**
- Auto-bisect via `tryWithSmallerQueries` (W2-05), mirroring the existing `MAX_BISECT_DEPTH=6` adaptive pattern in metadata-bisect

**If the user requests SARIF output:**
- Emit SARIF 2.1.0 Errata 01 (the current stable; verified at OASIS 2023-08-28 publication)
- Embed `$schema: https://json.schemastore.org/sarif-2.1.0.json`
- Validate in CI with `ajv` against the OASIS schema URL

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@salesforce/source-deploy-retrieve@^12.35.10` | `@salesforce/core@^8.30.0` (installed) | SDR 12.x peer-depends on core 8.x; matches. Confidence: HIGH. |
| `@salesforce/source-deploy-retrieve@^12.35.10` | Node 20+ | SDR 12.x requires Node 18+, project pins 20+; safe. |
| `picomatch@^4.0.4` | Node 12+ | Pure JS, no native deps; safe. |
| `@types/sarif@^2.1.7` | TypeScript ^5.6.0 (installed) | Pure type-only; no runtime concern. |
| `jszip@^3.10.1` | All Node versions ≥10 | Stable, no breaking changes since 3.0. |
| `ajv@^8.20.0` | Node 12+ | Stay on 8.x; ajv 2024.x rewrite (codename "ajv-next") not yet GA. |
| Zod stay-on-3 | All current deps | Zod 4 (^4.4.3) is stable but migrating triggers churn in every MCP tool schema; defer. |

---

## Confidence Summary

| Recommendation | Confidence | Why |
|----------------|------------|-----|
| `@salesforce/source-deploy-retrieve` for W2-02, W3-03 | HIGH | Official Salesforce CLI library; verified daily release cadence; right shape |
| `picomatch` for W3-04 | HIGH | Verified npm; ecosystem-standard; benchmarked engine under micromatch/fast-glob |
| Hand-rolled SARIF + `@types/sarif` for W3-02 | HIGH | OASIS spec verified; Microsoft's own pattern; minimal surface |
| `ajv` for SARIF schema validation in tests | HIGH | Verified npm + OASIS schema URL |
| `yaml` + `zod` (existing) for W3-01 | HIGH | Already in tree; PMD field names verified at pmd-code.org |
| PMD canonical field list (name/message/description/priority/externalInfoUrl/properties/example) | MEDIUM-HIGH | PMD docs confirm XML schema and these field names appear in their rule reference; validate against `EmptyCatchBlock` canonical example before locking |
| MCD 2000-row cap + filter requirement | MEDIUM | Community-validated; Salesforce's own page renders empty in WebFetch — treat as a runtime assumption, not a spec citation. Validate in W2-03 spike. |
| Don't pick `jsforce-metadata-tools` | HIGH | npm last-modified 2022-06-19; unambiguously unmaintained |
| Don't pick `sarif-builder` | HIGH | Package does not exist on npm |
| Don't vendor Happy Soup source | HIGH | License surface verified in PROJECT.md |

---

## Sources

- npm registry (`npm view <pkg> version time.modified`) — verified live 2026-05-17 for: `micromatch@4.0.8`, `picomatch@4.0.4`, `minimatch@10.2.5`, `node-sarif-builder@4.1.0`, `@microsoft/sarif-multitool@4.6.4`, `fast-glob@3.3.3`, `jsforce-metadata-tools@1.3.1` (last-mod 2022), `@salesforce/source-deploy-retrieve@12.35.10` (last-mod 2026-05-17), `ajv@8.20.0`, `@types/sarif@2.1.7`, `jszip@3.10.1`, `adm-zip@0.5.17`, `zod@4.4.3`
- OASIS SARIF 2.1.0 Errata 01 — `https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html` (verified; current stable as of 2023-08-28)
- SARIF JSON schema — `https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json`
- `github.com/forcedotcom/source-deploy-retrieve` — verified retrieve(), package.xml gen, ZIP handling capabilities
- `pmd-code.org` documentation — confirmed PMD uses XML rulesets (not YAML); field list synthesized from rule writeup pages (MEDIUM confidence on exact field enumeration — validate against canonical PMD `EmptyCatchBlock` rule before locking schema)
- Existing `packages/core/package.json` — verified current dep tree to avoid duplicates
- PROJECT.md — license, scope, and stack-locking constraints

---

*Stack research for: Salesforce metadata graph + dependency analysis tooling (sfgraph Waves 2 & 3)*
*Researched: 2026-05-17*
