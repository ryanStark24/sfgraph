# Pitfalls Research

**Domain:** sfgraph hardening + capability expansion (brownfield Salesforce metadata graph)
**Researched:** 2026-05-17
**Confidence:** HIGH (code-grounded against actual `packages/core/src` paths; MCD/SARIF/Metadata API quotas verified against Salesforce/OASIS docs)

Scope note: This document catalogs traps *inside* the Wave 1/2/3 deliverables already scoped in PROJECT.md. Generic Salesforce mistakes are excluded unless they intersect a specific Wave item. The 8 Out-of-Scope items in PROJECT.md are not re-derived here.

---

## Critical Pitfalls

### Pitfall 1: Log explosion when fixing silent catches (W1-01)

**What goes wrong:**
Replacing the three `catch {}` blocks at `extractors/live-org/vlocity/runner.ts:76, 188, 246` with `console.warn`-equivalent logging causes log-volume blow-up on managed-package orgs. Each Vlocity datapack type × namespace combination that doesn't exist in the org generates one "type not present" warning. Large orgs with Vlocity-CMT + OmniStudio-on-Core + a Vlocity-Industries managed namespace can have 3 namespaces × ~30 datapack types = ~90 warnings *per ingest*, dominated by `INVALID_TYPE` errors for namespace/type combos that are structurally absent (different industries install different DataPack types — comment at runner.ts:248 calls this out explicitly).

**Why it happens:**
The current `catch {}` silently absorbs three structurally different errors with one handler: (a) genuine SOQL/socket failure, (b) `INVALID_TYPE` because the namespace doesn't define that sobject, (c) `INSUFFICIENT_ACCESS` because the user has the namespace but no FLS. Naive "log everything we used to swallow" treats all three as equally noteworthy.

**How to avoid:**
- Classify the error before logging. Discriminate `INVALID_TYPE` / `sObject type ... is not supported` (expected, log at DEBUG) from network/permission/parse errors (unexpected, log at WARN and push to `warnings[]`).
- Aggregate identical messages: emit one summary per `(vdpType, namespace, errorClass)` tuple per ingest, not one per `catch`.
- The `warnings: string[]` field on `LiveIngestResult` must be capped (suggest 200 entries) with a `warningsTruncated: boolean` flag — unbounded arrays will OOM serialization on large orgs.
- Use a structured warning object `{ stage, vdpType?, namespace?, code, message, count }` not raw strings, so downstream consumers (MCP `get_ingest_job`) can filter.

**Warning signs:**
- Test fixture orgs producing >50 warnings on a clean ingest
- `LiveIngestResult.warnings` array length growing linearly with `caps.vlocityNamespaces.length × registry.entries.length`
- Identical warning messages repeated with different parent IDs (means per-record loop is logging, not per-batch)

**Phase to address:** Wave 1, must ship with W1-01. If W1-02 (provenance) lands before this is tested on a 3-namespace org, the noise drowns provenance signal.

---

### Pitfall 2: EdgeFact storage bloat from per-edge provenance (W1-02)

**What goes wrong:**
Adding `sourceUri?: string; line?: number; column?: number` to `EdgeFact` and threading it from `ParseContext` through every emitter naively appends three columns to the SQLite edges table. With ~88 edge types and orgs that produce 1–10M edges (typical for hybrid Vlocity-CMT + LWC + Apex orgs), the bloat is:
- `sourceUri` averages ~80 bytes (`sf://<orgId>/ApexClass/Foo.cls`)
- per-edge cost ~96 bytes uncompressed
- 5M edges × 96 bytes = ~480MB added to the per-org SQLite file

Worse: most edges share a `sourceUri` (every edge emitted from `Foo.cls` parsing has the same URI). Storing it inline duplicates the string millions of times.

**Why it happens:**
The straightforward implementation is `EdgeFact.sourceUri: string`. The `ParseContext.sourceUri` is already a string at parse time; "just thread it through" feels like the smallest change. Nobody benchmarks the SQLite file size diff on a real org.

**How to avoid:**
- **Interning required.** Store sourceUri once per parse file in a `sources` table (id, uri) and reference by integer FK on EdgeFact. parse5/Babel/antlr offsets are local to the file, not the URI.
- `line` and `column` should be `INTEGER NULL` (4 bytes when present, 0 bytes via SQLite's variable-length encoding when NULL). Do NOT serialize as JSON strings.
- Make provenance fields strictly optional — many synthetic edges (e.g. CANONICAL_OF from `resolveCrossFlavor`, MCD edges from W2-03) have no source location and should not carry placeholder values.
- Benchmark before/after sqlite file size on the largest test fixture; require <20% growth as acceptance criterion.
- Backwards-compat: existing 26 MCP tools must not break. Verify each tool's response renderer ignores unknown EdgeFact fields rather than echoing them into `markdown` (would blow response sizes).

**Warning signs:**
- SQLite file size doubling on the same fixture after W1-02 lands
- `EXPLAIN QUERY PLAN` on existing edge queries showing SCAN instead of SEARCH (added columns triggering index rebuild planning)
- MCP tool `markdown` field length growing on impact tools that render edges
- Serialization round-trip tests slowing >2× in `domain/edge-fact.test.ts`

**Phase to address:** Wave 1, W1-02. The schema decision is irreversible-cheap-to-get-right, expensive-to-fix-after-shipping. Land interning on first commit, not as a follow-up.

---

### Pitfall 3: Tightened arity resolver removes edges downstream consumers depend on (W1-04)

**What goes wrong:**
W1-04 says "tighten Apex arity resolver to match by `(name, arity, argTypes[])` … fall back to `ambiguous: true` only when statically undeterminable." The existing resolver emits `ambiguous: true` edges *liberally*. Three downstream consumers may treat the presence of an `ambiguous` edge as "this call site touches this method" and silently lose coverage when the resolver becomes precise:

1. The vector-search KNN re-ranker uses edge density as a similarity signal.
2. Several of the 21 YAML rules (the impact/usage-style ones) walk `ambiguous: true` edges to flag potentially-unsafe refactors.
3. The MCP `find_callers`/impact tools count incoming edges; precision improvements drop counts.

A correctly tightened resolver is more precise and *less* recall-preserving. Users who depended on the over-approximation see "missing dependencies" reported as a regression.

**Why it happens:**
The PROJECT.md framing — "fall back to ambiguous only when undeterminable" — treats `ambiguous` as a bug. It's actually a *feature* for over-approximation consumers. The change is a semantics shift, not a bug fix.

**How to avoid:**
- Do **not** drop the old ambiguous edges. Tighten by adding precise edges with `attributes.resolved: 'exact' | 'ambiguous'`; keep over-approximating edges as `resolved: 'ambiguous'` so existing rule consumers see the same set.
- Add a query parameter / rule option `resolvedOnly: boolean` (default `false` for backwards compat) and migrate consumers explicitly.
- Audit the 21 YAML rules in `rules/` for any `MethodCallsMethod` / `CallsMethod` predicates and document which expect over-approximation.
- Golden-test fixtures must include the *ambiguous* case (overloaded method, untyped local, dynamic dispatch) and assert that BOTH the precise edge and the ambiguous fallback edge exist when applicable.

**Warning signs:**
- Edge count *decreases* on existing fixtures after W1-04 lands
- Any of the 21 YAML rules' golden outputs change (rule output diff = consumer break)
- `find_callers` MCP tool returning empty for known overloaded method names in fixtures
- Vector-search relevance scores shifting on fixed queries

**Phase to address:** Wave 1, W1-04. Run the 21 YAML rules against the largest test fixture before/after to detect coverage drops.

---

### Pitfall 4: OmniStudio overlap detector emits structurally-identical-but-semantically-different signatures (W2-01)

**What goes wrong:**
The overlap detector compares OmniStudio process signatures using an "edge-multiset" representation (which sub-elements, in which order, calling which DataRaptors / IPs). Two processes can have identical edge multisets but diverge at runtime because:
- One has a conditional branch element (`Conditional Block`, `Decision`) with a non-trivial predicate; the multiset comparison drops the predicate.
- Element ordering matters in OmniScripts (sequential execution); a multiset is order-blind.
- `Set Values` / `Formula` elements with identical inputs may produce different outputs via expression configuration stored as JSON blobs (`PropertySet`).
- IP `Send/Response` element pairs with the same target IP but different invocation modes (sync vs queueable) collapse together.

Result: the overlap detector emits `OVERLAPS_WITH` edges (or whatever the chosen edge type) between processes that are *not actually duplicates*, and consumers (impact analysis, dedup recommenders) act on false positives.

**Why it happens:**
The Vlocity industry pattern of cloning processes between products *does* produce many real duplicates, which biases the detector design toward maximizing recall. The `parsers/cross-flavor-resolver.ts` precedent (which uses pure name-normalization at line 16–23) sets an expectation that "lexical match = semantic match", which is true for CANONICAL_OF (different flavors of literally the same component) but false for overlap (different components that happen to look alike).

**How to avoid:**
- Include `PropertySet` JSON hashes in the signature, not just element type+name.
- Preserve element *order* in the signature where the underlying OmniStudio element type executes sequentially (OmniScript root, IP root). Multiset only for genuinely commutative containers.
- Emit overlap as a *score* (0..1) on the edge attributes (`similarity: 0.0–1.0`, `signatureMatch: 'exact' | 'structural' | 'lexical'`), not a binary OVERLAPS_WITH. Lets consumers threshold.
- Co-exist with `resolveCrossFlavor`: overlap detector runs **after** cross-flavor merge and explicitly excludes pairs already connected by `CANONICAL_OF` (those are the same component in two flavors, not overlap).
- Disable by default (`disableOverlapDetect: true` until validated). PROJECT.md already specifies the flag exists; default value matters.

**Warning signs:**
- Overlap edges emitted between an OmniProcess and itself's CMT counterpart (sign that CANONICAL_OF wasn't excluded)
- High overlap edge density on managed-package orgs (managed components often share skeletons but diverge in PropertySet)
- Manual spot-check on 10 randomly-sampled overlap pairs showing <50% true positives
- User reports of "wrong overlap" in dogfooding before Wave 3 ships

**Phase to address:** Wave 2, W2-01. Design the signature schema *before* implementation; sequencing inside Wave 2 (per PROJECT.md Key Decisions row 5) already puts overlap detector first.

---

### Pitfall 5: Metadata API `retrieve()` quota & blocking semantics in OmniStudio extractor (W2-02)

**What goes wrong:**
The new `extractors/live-org/extractors/omnistudio-retrieve.ts` calls Metadata API `retrieve()`. Three traps:
1. **Quota**: `retrieve()` counts against the 10,000 Metadata API calls/24h org limit (verified: Salesforce platform-limits doc). One ingest of an OmniStudio-on-Core org with hundreds of OmniProcess/IntegrationProcedure/OmniUiCard components can be 10+ calls per type × namespace. Concurrent users on the same org compound this.
2. **Asynchronous + polling**: `retrieve()` returns an AsyncResult; the actual ZIP is only available after polling `checkRetrieveStatus()` until `done=true`. The Salesforce-documented behavior is "may take several minutes for large retrieves". A naive `await` loop blocks the ingest pipeline.
3. **5,000-component-per-package.xml limit** (Salesforce documented). Large orgs exceed this and require chunked retrieves.

**Why it happens:**
The existing Bottleneck rate-limit pools (Tooling/Metadata/Data) cover *call frequency*, not *daily quotas* or *async-job tracking*. The PROJECT.md framing "capability-gated, falls back to existing SOQL path" implies retrieve() is the better path when available — but "available" doesn't mean "free" or "fast".

**How to avoke:**
- Add `metadataRetrievesUsedToday: number` tracking to org capabilities and reject the retrieve path when within 10% of quota (use header `Sforce-Limit-Info` on response).
- Implement `retrieve()` as an async ingest job (PROJECT.md says async jobs exist via `get_ingest_job` — reuse, don't bypass). Never block the synchronous ingest pipeline on retrieve completion.
- Chunk package.xml manifests at <2,000 components per retrieve (well under 5,000 limit, leaves headroom for managed packages that auto-expand wildcards).
- Default to SOQL path when component count > N (suggest 500). Retrieve fidelity is only worth it for design-time fields that SOQL can't see; not every org needs them.
- Polling backoff: start at 5s, double up to 60s, max 30 min, then abort with a recoverable warning (not a thrown error).
- Capability gate must check `connection.metadata` exists AND user has `ModifyMetadata` OR `ModifyAllData` perm — Metadata API silently returns empty for unauthorized scopes on some org types.

**Warning signs:**
- Ingest jobs taking >10 min on a previously-fast org (retrieve polling blocking)
- `INVALID_SESSION_ID` errors mid-retrieve (session timeout during long poll)
- `API_DISABLED_FOR_ORG` or `REQUEST_LIMIT_EXCEEDED` errors
- Warnings field containing "retrieve returned 0 components" on an org known to have OmniProcess records

**Phase to address:** Wave 2, W2-02 (sequenced last in Wave 2 per PROJECT.md — this is intentional, the async job plumbing should be solid before this lands).

---

### Pitfall 6: MCD's 2,000-row LIMIT/OFFSET cap + freshness lag (W2-03)

**What goes wrong:**
The MCD fast-path extractor queries `MetadataComponentDependency` via Tooling SOQL. Two Salesforce-documented limits bite:
1. **2,000-row cap on a single query** (Salesforce-documented constraint of `MetadataComponentDependency`). LIMIT/OFFSET *cannot* be used to paginate beyond 2,000 rows — OFFSET >2000 returns empty or errors. The only documented workaround is filtering by `MetadataComponentType` or `RefMetadataComponentType` to keep each query <2,000 rows.
2. **Async refresh lag**: MCD does not reflect metadata changes for minutes to hours after deployment. Documented as "asynchronous refresh"; users see stale dependencies and wrongly assume the graph missed an edge.

If W2-03 ships without per-type filtering, large orgs silently lose dependencies (2001st row onward is dropped). If it ships without freshness annotation, users misdiagnose graph correctness.

**Why it happens:**
MCD-via-SOQL looks like any other Tooling query. The existing `tryWithSmallerQueries` rebatcher (W2-05, also in this milestone) handles HTTP 414/431, not the soft 2,000-row semantic limit. The freshness behavior is in Salesforce docs but not in any error response.

**How to avoid:**
- Iterate by `MetadataComponentType` *and* `RefMetadataComponentType` cross-product. Use a precomputed list of (type, refType) pairs known to exist on the org. Each leaf query stays well below 2,000 rows.
- Detect overflow: if `records.length === 2000` and no `LIMIT` was specified, treat as "may be truncated", emit a warning, and recurse with a tighter filter (e.g., add `MetadataComponentName LIKE 'A%'` partition).
- Stamp each MCD-sourced node/edge with `attributes.mcdQueriedAt: <ISO timestamp>` and `attributes.source: 'mcd'`. The merge rule "parsed wins on overlap" (already in PROJECT.md W2-03) handles ambiguity, but users querying MCD-only nodes need to see freshness.
- Document the lag in the `get_ingest_job` summary: "MCD reflects metadata as of ~T-15min on most orgs; recently-deployed components may not appear in MCD edges until next refresh."

**Warning signs:**
- Any single MCD query returning exactly 2,000 records (almost certainly truncated)
- Ingest finishing in <1 min for an org with >10k metadata components (MCD truncation skipping data)
- User-reported "X depends on Y but the graph doesn't show it" within 30 min of a deployment
- Diff between MCD edge count and parsed-edge count growing on the same fixture (each should overlap mostly)

**Phase to address:** Wave 2, W2-03. The freshness annotation must ship with the first cut, not as follow-up — adding the field later breaks `attributes` shape consumers.

---

### Pitfall 7: SARIF 2.1.0 spec compliance silently rejected by GitHub Code Scanning (W3-02)

**What goes wrong:**
SARIF 2.1.0 has strict `runs[].tool.driver.rules[]` and `runs[].results[].ruleId` semantics. GitHub Code Scanning validates uploads and silently rejects malformed reports — the upload API returns 200 OK with `processing_status: 'failed'` only visible via a second API call. Common breakages:
- `ruleId` referenced in `results[]` but not present in `rules[]` → silent reject
- Missing `runs[].tool.driver.informationUri` or invalid URI scheme → some validators reject
- `properties.tags` not an array → schema reject
- Results without `locations[]` or `locations[]` without `physicalLocation` → reject for code scanning (allowed by spec but rejected by GitHub)
- File URIs not starting with `file://` or being absolute when GitHub expects repo-relative → results appear with no source location
- `level` value not in `{none, note, warning, error}` → reject

**Why it happens:**
SARIF is a 200+ page spec with optional fields that look optional in the JSON schema but are *required* by specific consumers (GitHub, Azure DevOps, sonarqube each enforce a different subset).

**How to avoid:**
- Validate output against the OASIS SARIF 2.1.0 JSON schema at emit time (use `ajv` with the official schema). Reject malformed output before write.
- Adopt the GitHub-specific subset: every rule used in `results[]` MUST be in `rules[]`; every result MUST have `locations[0].physicalLocation.artifactLocation.uri` set to a repo-relative path; `level` MUST be one of the four enums; `partialFingerprints` recommended for stable result identity across runs.
- Use the W1-02 provenance fields (`sourceUri`, `line`, `column`) directly — SARIF requires file/line/column for code scanning. Without W1-02, W3-02 has nothing to emit. **Hard dependency** confirmed.
- Add a `gsd-tools.cjs`-style validator command (`node sarif-validate.js output.sarif`) before considering W3-02 done.
- Round-trip test: emit SARIF for a fixture rule violation, upload to a test GitHub repo, verify it appears in Security tab.

**Warning signs:**
- SARIF file passes JSON.parse but `ajv` validation fails
- GitHub Actions upload-sarif step succeeds but Security tab shows nothing
- `level` values like `"info"` or `"high"` (not in spec enum)
- `ruleId` strings with spaces or characters outside `[A-Za-z0-9_./-]`

**Phase to address:** Wave 3, W3-02. Hard-depends on W1-02 (provenance). Order: W1-02 → W3-01 (PMD rename) → W3-02 (SARIF emitter). PROJECT.md Key Decisions row 6 already captures the W3-01→W3-02 sequencing.

---

### Pitfall 8: ElemID rename stability merging distinct components on serviceId collision (W3-05)

**What goes wrong:**
W3-05 persists `(orgId, serviceId) → qualifiedName` and rewrites edges on rename. Managed-package contexts produce `serviceId` collisions:
- Two managed packages can both install components with the same `DeveloperName` and *different* namespace prefixes; if the serviceId derivation strips namespace, distinct components collide.
- Salesforce reuses 15/18-char IDs after permanent deletion in some sandbox refresh scenarios.
- ChangeSet-deployed components get new IDs on the target org but the source's serviceId is what users searched by — re-deploy can flip the mapping silently.

If the rename-detection code sees "same serviceId, different qualifiedName" and assumes "rename → rewrite edges", it merges two distinct components into one node, destroying graph correctness for ALL edges of the absorbed component.

**Why it happens:**
"Rename = same ID, different name" is the natural framing, but in Salesforce ID semantics, ID equality is only "same component" within a single org × within a single managed-namespace × within a non-recycled lifetime. The rename heuristic must encode all three.

**How to avoid:**
- Key the map by `(orgId, namespace, serviceId, componentType)` — never just `serviceId`.
- Detect "rename" only when:
  - The old qualifiedName no longer appears in this ingest's NodeFacts, AND
  - The new qualifiedName has the same `componentType` and `namespace`, AND
  - No other qualifiedName claims the same serviceId in this ingest.
- If multiple new qualifiedNames claim the same serviceId, log a `serviceIdCollision` warning and skip the rewrite (treat as delete+add — current behavior).
- Provide a backwards-compat escape: `sfgraph reset-elemid-map <orgId>` CLI subcommand to nuke the map when collisions get into bad state.
- Golden-test fixture: two managed packages with same `DeveloperName`, verify they remain distinct after rename of one.

**Warning signs:**
- Node count dropping unexpectedly between ingests on a stable org
- Edges suddenly pointing to a different qualifiedName than the user expects
- `warnings[]` containing `serviceIdCollision` entries
- Vector-search returning the wrong component for a known query after a re-ingest

**Phase to address:** Wave 3, W3-05. Ship with a "rename detection off" feature flag (default off until validated against a managed-package fixture).

---

## Moderate Pitfalls

### LWC parse5 directive attribute case sensitivity (W1-03)

**What goes wrong:** parse5 lowercases attribute names by default in HTML mode. LWC accepts `lwc:if` lowercase, but template authors sometimes write `lwc:If` or `LWC:if`; parse5 will normalize, but the *value* (the bound expression) is preserved verbatim including any HTML entity encoding (`&amp;&amp;` for `&&`). Visiting the value and naively splitting on `.` to extract property paths breaks on entity-encoded expressions and on expressions containing function calls or nested member access (`item.contact.account.name`).

**Prevention:** Use `parse5`'s tree-walker, not regex. Decode HTML entities before extracting identifiers. Use the existing Babel-based expression parser (already a dependency for LWC JS) to parse the directive value as a JS expression, not string splitting. Emit USES edges for each identifier reference inside the parsed expression. Reject and warn on unparseable expressions rather than silently producing wrong edges.

---

### Composite-subrequest 25-call batching error semantics (W2-06)

**What goes wrong:** Composite API batches return partial-success responses where some subrequests succeed and others fail. Naive "if response.ok throw" loses successful records when one subrequest in the batch fails.

**Prevention:** Inspect each subrequest's `httpStatusCode` independently. Successful subrequests must be yielded; failed ones must be either retried individually (fall through to the existing adaptive bisection at `MAX_BISECT_DEPTH=6`) or added to `warnings[]`. Test with a fixture that intentionally fails one of 25 subrequests.

---

### `tryWithSmallerQueries` re-batcher infinite loop on 414-in-414 (W2-05)

**What goes wrong:** If the rebatcher splits a >300-IN-clause query and one of the halves itself produces 414 (because of WHERE-clause length, not IN-list size), naive recursion produces a tree that never converges below the 414 threshold.

**Prevention:** Decrement a `depth` counter; cap recursion at 4 levels. On exhaustion, fall back to per-ID queries (max 200 ids → 200 separate queries) or emit warning and skip. Detect 414 distinct from "IN list too long" (the latter has SOQL error code `MALFORMED_QUERY`, the former is HTTP-level).

---

### Glob selector overcollection on `salesforce.Flow.instance.*` (W3-04)

**What goes wrong:** A glob like `salesforce.Flow.instance.Lead_*` against an org with thousands of Flow versions matches every version of every matching flow (each version is a separate node). Users expect "latest version" semantics; getting 50 versions per flow blows up response sizes past the sub-second MCP response budget.

**Prevention:** Add implicit `version=latest` filter on Flow-instance globs unless `**` or explicit version suffix is present. Document the rule in `find_nodes` help text. Hard-cap result count at 500 with a `truncated: true` flag.

---

### PMD-aligned rule schema field shadowing (W3-01)

**What goes wrong:** PMD's rule schema uses `priority` (1–5, integer, 1=highest); existing sfgraph rules may use `severity: 'error' | 'warning' | 'info'`. Mapping `severity → priority` ad-hoc per rule introduces inconsistency. Worse, `name` in PMD is the rule identifier; if existing rules used `name` as the human-readable title and `id` as the identifier, the rename inverts semantics silently.

**Prevention:** Define the mapping table in one place, apply via a migration script that touches all 21 YAML files in one commit, and add a schema validator (JSON schema or zod) that runs in CI. Reject rule files that don't match. Preserve old field names as `legacy_*` for one release cycle.

---

## Minor Pitfalls

### IS_TEST attribute mis-set on `@isTest`-annotated method inside non-test class (W1-05)

**What goes wrong:** A non-test class can contain a single `@isTest static void helperX()` method; whole-class `IS_TEST` would be wrong. Conversely, a `@isTest` class containing a non-test inner class can confuse a naive walker.

**Prevention:** Set `IS_TEST` at the method level when annotation is on the method; at the class level when annotation is on the class. Inner classes inherit only if explicitly annotated. Test fixtures: `class Foo { @isTest static void bar() {} }` (method only); `@isTest class Foo { class Bar {} }` (class only).

---

### Vector embedding cache invalidation on EdgeFact schema change (W1-02 side effect)

**What goes wrong:** Existing `sqlite-vec` embeddings were computed with the old EdgeFact shape (no provenance). After W1-02 lands, edge-derived embeddings drift; KNN results subtly degrade until re-ingest.

**Prevention:** Bump a `schemaVersion` on the embeddings table; mark old embeddings as stale on schema change; re-embed lazily or on demand. Do not silently mix old/new embeddings in KNN.

---

### Misleading `attributes.source: 'mcd' | 'parsed'` on edges with both sources (W2-03)

**What goes wrong:** PROJECT.md says "parsed wins on overlap" — but consumers may want to know that MCD ALSO confirmed the edge. Collapsing to a single source string loses corroboration signal.

**Prevention:** Use `attributes.sources: ['mcd', 'parsed']` (array). Existing rule "parsed wins" means parsed metadata wins for *node attributes*; edge provenance should be additive.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Log warnings as plain strings instead of structured objects (W1-01) | Faster to ship; one-line change | Cannot filter/aggregate/dedupe; warnings field becomes unparseable for MCP consumers | Never — structured from day 1, the shape is part of the public `LiveIngestResult` API |
| Store `sourceUri` inline on every EdgeFact (W1-02) | Simplest schema migration | 500MB+ SQLite bloat on large orgs; query plan regression | Never — intern from day 1 |
| Skip overlap-similarity score; emit binary OVERLAPS_WITH only (W2-01) | Smaller schema, faster query | Consumers cannot threshold false positives; detector unusable until rewrite | Acceptable if `disableOverlapDetect: true` is the default and feature is dogfood-only |
| Block on retrieve() polling synchronously (W2-02) | Simpler control flow | Ingests hang 10+ min, MCP timeouts cascade | Only if max-component cap is <50 (small orgs) |
| Single-pass MCD query without per-type chunking (W2-03) | Half the code | Silent data loss above 2,000 rows | Never — silent data loss violates milestone's "every ingest failure is loud" core value |
| Emit SARIF without ajv validation (W3-02) | One less dependency | Silent GitHub Code Scanning rejections; bug reports months later | Never — validation is cheap, debugging GitHub rejections is not |
| Key elemid map by serviceId only (W3-05) | Simpler key, faster lookup | Managed-package collisions corrupt the graph silently | Never — composite key is mandatory |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Salesforce Metadata API `retrieve()` (W2-02) | Treating as synchronous; not tracking 10k/24h quota | Async job + quota tracking via `Sforce-Limit-Info` header |
| MetadataComponentDependency (W2-03) | Using LIMIT/OFFSET to paginate past 2,000 rows | Per-type filtering; treat `records.length === 2000` as truncation signal |
| GitHub Code Scanning SARIF upload (W3-02) | Trusting 200 OK as success | Poll `/repos/{owner}/{repo}/code-scanning/sarifs/{id}` for `processing_status` |
| Tooling API SOQL (W2-05) | Catching only `MALFORMED_QUERY`, missing HTTP 414/431 | Inspect both SOQL error codes AND HTTP status; rebatcher must handle both |
| Composite REST `/composite/batch` (W2-06) | Throwing on first subrequest failure | Iterate subresponses; succeed on partial; fall through to adaptive bisection on full failure |
| sf-CLI delegation auth | Assuming session lifetime > ingest duration | Refresh session if ingest >55 min; long retrieves are the main case (W2-02 implication) |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Per-edge sourceUri storage without interning (W1-02) | SQLite file >2× larger after re-ingest | Intern via `sources` table + FK | Orgs with >1M edges (typical hybrid orgs) |
| Overlap detector O(n²) signature comparison (W2-01) | Wave 2 ingest pass >5 min on 500-OmniProcess org | Hash-bucket signatures; compare only within bucket | Orgs with >300 OmniProcess records |
| MCD per-row queries instead of per-type batched (W2-03) | Wave 2 ingest dominated by MCD time; 1+ hr | Per-type chunking; respect 2,000-row cap | Orgs with >5k metadata components |
| Retrieve() blocking the synchronous ingest path (W2-02) | MCP `get_ingest_job` showing same status for 10+ min | Async-job-ify retrieve; never block | Any org >100 OmniStudio components |
| SARIF emission inlined into MCP response markdown (W3-02) | MCP response sizes >1MB | Emit SARIF to file; MCP response returns the path | Rule runs with >100 findings |
| Glob selector linear scan over all NodeFacts (W3-04) | `find_nodes` taking >1s | Index by `(category, type, namespace)` prefix | Orgs with >50k nodes |
| Vector KNN over edge-bloated graph (W1-02 side effect) | KNN slowdown post-W1-02 | Re-embed lazily; mark stale embeddings | After any EdgeFact schema change |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Logging full SOQL strings including data values in W1-01 warnings | Sensitive field values in `LiveIngestResult.warnings` exposed to MCP clients | Log query type + table only; never values from SELECT results |
| Storing `retrieve()` ZIP content on disk without cleanup (W2-02) | Org metadata persisted in `~/Library/Application Support/sfgraph/tmp/` indefinitely | Use `fs.mkdtemp` + finally-block cleanup; never persist raw ZIPs past ingest |
| Emitting `sourceUri` with absolute filesystem paths in SARIF (W3-02 × W1-02) | Leaks `/Users/<username>/` paths to GitHub Security tab | Normalize to repo-relative paths before SARIF emission |
| Glob selector regex passed through to SQLite query directly (W3-04) | SQL injection via crafted glob like `apex.Class.'; DROP TABLE …` | Parse glob into AST; emit parameterized SQLite queries only |
| Reading `connection.accessToken` for retrieve() polling (W2-02) | Token captured in async-job state and persisted to SQLite | Polling reuses the existing `read-only-proxy.js` connection; never serialize tokens |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| `warnings[]` array shown raw in MCP `get_ingest_job` markdown (W1-01) | 90+ noise warnings hide the 3 real ones | Group by `(stage, code)`; collapse identical messages with count |
| Overlap detector emits edges users can't act on (W2-01) | "Why are these flagged as overlap?" with no explanation | Include `signatureMatch` + `similarity` + which specific elements matched on edge attributes |
| MCD edges look the same as parsed edges (W2-03) | User trusts MCD edge as ground truth, doesn't know it's 15 min stale | `attributes.source` + freshness timestamp surfaced in `markdown` renderer for impact tools |
| SARIF rule `description` defaults to rule ID (W3-02) | GitHub Security tab shows `IPCallsDR` with no human context | PMD-aligned rename (W3-01) requires `description` field; validate non-empty in W3-02 emitter |
| Rename-detected edges silently rewrite without provenance (W3-05) | User sees old qualifiedName disappear, doesn't know it became a rename | Stamp `attributes.renamedFrom: <oldQualifiedName>` on every rewritten edge |

---

## "Looks Done But Isn't" Checklist

- [ ] **W1-01 (silent catches):** Often missing structured warning shape — verify `warnings[]` is `Array<{stage, code, message, count}>` not `Array<string>`, and capped at 200 entries
- [ ] **W1-02 (edge provenance):** Often missing interning — verify SQLite file size grows <20% on the largest test fixture and `sources` table exists
- [ ] **W1-03 (LWC directives):** Often missing nested-expression coverage — verify edges emitted for `lwc:if={item.contact.account.name}` not just `lwc:if={item}`
- [ ] **W1-04 (Apex arity):** Often missing ambiguous-fallback coverage — verify total edge count is non-decreasing and 21 YAML rule golden outputs unchanged
- [ ] **W1-05 (IS_TEST):** Often missing method-level granularity — verify `@isTest static void` on a non-test class produces method-only `IS_TEST`, not class-wide
- [ ] **W2-01 (overlap detector):** Often missing PropertySet-hash inclusion in signature — verify two OmniProcesses with identical elements but different PropertySet JSON do NOT overlap
- [ ] **W2-01 (overlap detector):** Often missing CANONICAL_OF exclusion — verify components linked by cross-flavor resolver are NOT also linked by overlap edges
- [ ] **W2-02 (retrieve extractor):** Often missing async-job integration — verify `retrieve()` does NOT block the main ingest path; check `get_ingest_job` status during a retrieve
- [ ] **W2-02 (retrieve extractor):** Often missing quota guard — verify the extractor refuses to start when daily API quota <10% remaining (mock `Sforce-Limit-Info`)
- [ ] **W2-03 (MCD fast-path):** Often missing truncation detection — verify a fixture with >2,000 MCD rows triggers per-type chunking, not silent drop
- [ ] **W2-03 (MCD fast-path):** Often missing freshness annotation — verify every MCD-sourced edge carries `mcdQueriedAt` timestamp
- [ ] **W2-04 (Happy Soup gap-fills):** Often missing license isolation — verify no AGPL source copy-pasted; re-implementations independently documented
- [ ] **W2-05 (rebatcher):** Often missing recursion cap — verify depth limit + per-ID fallback exists and tests force the bottom
- [ ] **W2-06 (composite batching):** Often missing partial-success handling — verify a fixture with 1-of-25 subrequest failures yields the 24 successes
- [ ] **W3-01 (PMD rename):** Often missing migration script — verify all 21 YAML files renamed in ONE commit with schema validator running in CI
- [ ] **W3-02 (SARIF):** Often missing ajv validation — verify malformed SARIF is caught at emit time, not at GitHub upload
- [ ] **W3-02 (SARIF):** Often missing rule-ID consistency — verify every `results[].ruleId` exists in `runs[].tool.driver.rules[]`
- [ ] **W3-02 (SARIF):** Often missing repo-relative URIs — verify no absolute filesystem paths leak into SARIF output
- [ ] **W3-03 (package.xml):** Often missing follow_up_tool wiring on every impact tool — verify all 26 MCP tools that emit impact data have `package_xml_export` in `follow_up_tools`
- [ ] **W3-04 (glob selector):** Often missing Flow-version handling — verify `salesforce.Flow.instance.Lead_*` returns latest version per flow, not all versions
- [ ] **W3-05 (elemid rename):** Often missing composite key — verify the map is keyed by `(orgId, namespace, serviceId, componentType)`, not just `serviceId`
- [ ] **W3-05 (elemid rename):** Often missing managed-package fixture — verify two managed packages with same DeveloperName stay distinct after a rename of one

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| W1-01 warning noise on production user (#1) | LOW | Ship a hotfix that reclassifies common errors to DEBUG; cap `warnings[]` at 200; release as patch |
| W1-02 SQLite bloat (#2) | MEDIUM | Add `sources` table + FK migration; backfill via re-ingest; document `sfgraph migrate-provenance <orgId>` |
| W1-04 dropped over-approximation edges (#3) | MEDIUM | Re-emit `ambiguous: true` edges alongside precise edges with `resolved: 'ambiguous'`; users opt in to precision via `resolvedOnly: true` |
| W2-01 false-positive overlap edges (#4) | HIGH | Default `disableOverlapDetect: true` from day 1; ship `clear-overlap-edges <orgId>` CLI; users can re-enable after validation |
| W2-02 retrieve() quota exhaustion (#5) | HIGH | Capability gate the extractor; fall back to SOQL path; document quota recovery (24h reset); add daily-budget config |
| W2-03 MCD silent truncation (#6) | HIGH | Re-ingest with per-type chunked queries; emit one-time `mcdSchemaVersion` bump that invalidates the old MCD-sourced edges |
| W3-02 GitHub silently rejecting SARIF (#7) | LOW | Add ajv validation; re-emit with fixed rule IDs; re-upload (idempotent) |
| W3-05 corrupted graph from rename merges (#8) | HIGH | `sfgraph reset-elemid-map <orgId>` + full re-ingest; document the failure mode prominently |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| #1 Log explosion (W1-01) | Wave 1, first commit | Run ingest on 3-namespace fixture; assert warnings <50 |
| #2 EdgeFact bloat (W1-02) | Wave 1, schema-first commit | SQLite file size delta <20% on largest fixture |
| #3 Arity resolver over-tightening (W1-04) | Wave 1, after W1-02 | 21 YAML rule golden outputs unchanged; edge count non-decreasing |
| LWC directive coverage (Moderate) | Wave 1, W1-03 | Fixture with nested member access in `lwc:if` produces correct USES edges |
| IS_TEST granularity (Minor) | Wave 1, W1-05 | Mixed test/non-test class fixture |
| #4 Overlap false positives (W2-01) | Wave 2, first item per sequencing | Manual spot-check 10 sampled pairs; >70% true positive rate; `disableOverlapDetect: true` default |
| #5 Retrieve quota & blocking (W2-02) | Wave 2, last item per sequencing | Quota guard test (mocked headers); async-job test (retrieve doesn't block) |
| #6 MCD truncation (W2-03) | Wave 2, before W2-04 | Fixture with >2,000 MCD-discoverable dependencies; per-type chunking active |
| Rebatcher infinite recursion (Moderate) | Wave 2, W2-05 | Depth-cap test with synthetic 414-in-414 scenario |
| Composite partial failure (Moderate) | Wave 2, W2-06 | Fixture with 1-of-25 subrequest failure; verify 24 successes returned |
| Vector cache staleness (Minor) | Wave 2, alongside W1-02 fallout | KNN regression test post-schema-bump |
| PMD rename field shadowing (Moderate) | Wave 3, W3-01 (before W3-02) | Schema validator in CI; one-commit migration |
| #7 SARIF malformed (W3-02) | Wave 3, W3-02 | ajv validation in emit; round-trip upload to test GitHub repo |
| Glob over-collection (Moderate) | Wave 3, W3-04 | Flow-version fixture; default-latest behavior verified |
| #8 ElemID collision (W3-05) | Wave 3, W3-05 (feature-flagged off by default) | Managed-package fixture; composite-key invariant test |

---

## Sources

- `packages/core/src/extractors/live-org/vlocity/runner.ts` lines 76, 184–190, 244–252 (silent catch verification; W1-01)
- `packages/core/src/parsers/cross-flavor-resolver.ts` lines 16–23 (normalization precedent that overlap detector must NOT inherit; W2-01)
- `.planning/PROJECT.md` (Wave 1/2/3 scope; sequencing decisions; out-of-scope items)
- Salesforce Platform Limits documentation (Metadata API `retrieve()` 10,000 calls/24h; 5,000 components per package.xml; W2-02) — HIGH confidence (vendor-documented)
- Salesforce `MetadataComponentDependency` Tooling API documentation (2,000-row limit; async refresh lag; W2-03) — HIGH confidence (vendor-documented constraint, well-known limitation in the SFDX ecosystem)
- OASIS SARIF 2.1.0 specification + GitHub Code Scanning SARIF support documentation (rule-ID consistency, locations[] requirement, level enum; W3-02) — HIGH confidence
- parse5 documentation (HTML attribute case normalization; W1-03) — HIGH confidence
- Domain knowledge: Salesforce ID semantics across managed namespaces and sandbox refreshes (W3-05) — MEDIUM confidence (well-known among CTAs but not single-source documented)

---
*Pitfalls research for: sfgraph hardening + capability expansion (Wave 1/2/3)*
*Researched: 2026-05-17*
