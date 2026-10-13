# Changelog

## 1.6.0 — 2026-10-12

**Performance and stabilization.** This release makes ingest faster on large projects and orgs, fixes a wide set of audit and tool accuracy problems, and makes the MCP tool reports easier to read. Re-ingest with `sfgraph ingest --rebuild` after upgrading (see the upgrade notes below).

### Upgrade notes (readiness round: audit fixes + ingest fast path)

- **Node.js 22 or later is required.** Node 20 is end-of-life (April 2026), and `better-sqlite3` ships no prebuilt Windows binary for it, so installs on Windows + Node 20 fail. Every package's `engines` is now `>=22`, and CI tests Node 22 only.
- **Re-ingest with `sfgraph ingest --rebuild` after upgrading.**
  - Parser hash salts changed: Apex `apex-attrs:v2`, LWC `lwc-attrs:v3`, CustomObject `custom-object-attrs:v2`. Until both sides are re-ingested, `cross_org_diff`, `point_in_time_diff` and the wip-impact tools report every Apex/LWC/CustomObject node as changed when comparing a graph ingested before the upgrade with one ingested after.
  - A full `--project` ingest now removes nodes whose source file was deleted (ghost sweep). It refuses to sweep when the source yields no members, and it keeps the nodes of members that failed to read or parse.
- **Schema migration 11** runs on the first open of an existing graph. It takes a backup (`VACUUM INTO`) and backfills a new FTS rowid side table. Expect one slower first run.
- **Dead-code algorithm v5.** Cached dead-code scores from older versions are ignored and replaced on the next ingest. The semantics changed (see "Tool accuracy" below), and `export_sarif` consumers see the new semantics.
- **Apex and rules parser changes** (inline SOQL end, dynamic SOQL clause fields, relationship-path leaves, ApexPage/ApexComponent controllers, Process Builder objects) change graph output. Re-ingest with `--rebuild` to pick them up everywhere.
- **Schema migration 12** adds the per-org `embeddings_pending` flag.
- **Embedding cache.** The first ingest after upgrading computes every embedding: about 15 minutes on a corpus of roughly 22k members. Later rebuilds read the cache.
- **Schema migrations 13 and 14** run on the first open after upgrading, MCP opens included. One backup (`<db>.v<old>.<stamp>`) is taken per upgrade, and progress goes to stderr.
  - v13 records which process owns `sync_in_progress`. A killed ingest is then reported as not in progress, instead of staying stuck.
  - v14 converts existing snapshots to versioned storage, which takes a few seconds on large graphs. **It is one-way:** older sfgraph versions cannot create or delete snapshots on an upgraded DB. To go back, restore the backup.
  - The old full-copy snapshot tables are dropped, but the file does not shrink by itself. To reclaim the space, run `sqlite3 <orgId>.sqlite 'VACUUM;'` while no ingest or MCP server has the file open.
- **Aura bundles are now parsed** on `--project` ingests, so re-ingest to get them. Live-org ingests are unchanged.

### Ingest performance

- **Bulk load on rebuild.** When an org's graph is empty at the start of a full ingest, secondary indexes are dropped and rebuilt after loading. The ingest also uses relaxed pragmas, one transaction per 2,000 members and cached statements, and skips per-member delete and reconcile probes. If an ingest crashes inside this window, the next open recreates the missing indexes.
- **FTS updates delete by rowid** (side table) instead of scanning the FTS table. This removes an O(n²) cost.
- **Embeddings:** mean pooling is vectorised, batches are length-sorted, and inference runs in batches of 64. When a node is emitted more than once, the last emission wins, whether the emissions fall in one batch or across batches in flight.
- **Embeddings are off the graph-ready path.**
  - Inference runs in a worker thread. The ingest prints `graph ready in Ns` once merges, resolvers and the dead-code cache are done, then `embeddings done in Ns (cached H / computed C)`.
  - By default the CLI waits for embeddings. With `--no-wait-embeddings` it exits after graph ready, and the next ingest fills the pending vectors.
  - While vectors are pending, `find_similar` falls back to text search and says `vector index warming: N/M embedded; using text search`.
  - If embedding fails after graph ready, the CLI prints a warning and exits 0. The graph is complete; the vectors stay pending.
- **Persistent embedding cache.**
  - Location: `<dataDir>/embedding-cache/<modelId>@<model sha256 prefix>.sqlite`.
  - It is keyed by text hash and lives outside the graph DB, so `--rebuild` reuses vectors for unchanged texts.
  - Cached and computed vectors are identical.
  - It only grows; delete the directory to reclaim space.
- **Model input is capped at 256 tokens** (MiniLM's maximum), so long texts no longer inflate memory.
- **Parallel parse.** Members are parsed in a worker-thread pool, and writes stay on the main thread in input order, so the output is identical to a serial parse.
  - `SFGRAPH_PARSE_WORKERS` sets the pool size. The default is the available parallelism capped at 4, and `0` disables the pool.
  - Inputs under 500 members are parsed serially.
  - If a worker crashes or stalls, that member becomes a parse error (phase `worker`) and is retried on the next delta. After 3 crashes the pool falls back to the main thread.
- **Delta ingest.** `sfgraph ingest --project <p> --org <o> --delta` re-parses only added, changed and deleted members. It then re-runs the post-merge resolvers, scoped to the affected sources, and prints `delta: +A ~C -D (=U unchanged) in Ns`.
  - A graph built by an older sfgraph has no member hashes. In that case the delta prints a notice and runs a full rebuild.
  - The MCP `start_ingest_job` tool emits `--delta` for project sources.
  - A member whose parser throws keeps its content hash, so it is not re-parsed until the file changes.
  - On a large Vlocity repo (21.7k members): no-op 1.6 s, single file 5.9 s, 500 files 23.5 s, and typical commits p95 7.7 s against a 50–56 s full rebuild. The delta graph is identical to a full rebuild on 20/20 replayed commits.
- **Ingest lock.** `<dataDir>/<orgId>.ingest.lock` records the host, pid and process start time. A second ingest on the same org exits with `ingest already running for <org> (pid N since T); retry later`.
  - A lock is stale when its pid is dead or reused on the same host, and stale locks are removed.
  - A lock from another host is never removed automatically.
- **The formula relationship-hop resolver** now runs on full and delta ingests. It skips ambiguous relationship names.
- **Results on a large Vlocity repo** (21,763 members; graph output identical to the pre-change baseline):
  - Graph ready in 44 s (was about 31 min end to end).
  - A full rebuild with a warm cache, embeddings included, takes 57 s.
  - Peak RSS is about 1.95 GB with 4 parse workers (it was 3.0 GB before the memory fixes below).
- **Results on a large live Vlocity org** (60,376 members, warm embedding cache): graph ready in 429 s and 453 s end to end (was 3,488 s), with a peak RSS of 2.78 GiB (was 4.0 GB).
- **Embedding vectors are written in one transaction per batch**, with cached statements, instead of one commit and three fresh statement prepares per vector. Writing 5,000 vectors takes ~270 ms instead of ~900 ms. If a batch transaction fails, the batch is retried row by row.
- **Lower ingest memory.** The graph output is unchanged:
  - Each parse worker clears the Apex parser's ANTLR DFA cache every 50 parses. This was the largest saving, about 1 GB.
  - The index rebuild at the end of a bulk ingest sorts on disk (`temp_store=FILE`), then restores the previous setting.
  - The dangling-edge audit streams its edges instead of loading every one.
  - The SQLite page cache is capped at 64 MB and mmap at 64 MiB. MCP tool latency moved by at most +5.4%.
  - The 256 MB parse-worker heap cap now also holds when the process runs with `--max-old-space-size` (often set in `NODE_OPTIONS` for the `sf` CLI). That V8 flag is process-wide and used to override every worker's cap, so one huge member could grow a worker to gigabytes. The flag is cleared only while a capped worker starts, so the main heap and other workers keep it.

### Tool accuracy (readiness round)

These changes follow each tool's description and generic grammar rules (label, rel type, naming). They are not tuned to benchmark cases. The readiness report is `docs/superpowers/reports/2026-10-sfgraph-readiness-report.md`.

- **Component scoping for change tools.** `point_in_time_diff` and `what_broke` roll members up to their owning component (an ApexMethod to its ApexClass, a FlowVersion to its Flow). Record and config rows (custom metadata records, entity filters, picklists, manifests and similar) go into a separate `nonComponentChanges` bucket with its own heading, so they are never dropped silently. `what_broke` seeds dependents only from component changes, and reports untraced record/config seeds.
  - The split lives in one constant, `COMPONENT_LABELS`. **When a new metadata label gets a parser, add it there**; until then the label is treated as record/config.
- **`dead_code_audit` semantics.**
  - A reference from test code now counts as a reference.
  - Test classes with no inbound references are reported, flagged `isTest: true`.
  - Production components whose only references come from tests are listed separately as `referencedOnlyByTests`.
  - A custom metadata record naming an Apex class counts as a use.
- **`trace_downstream`, `cross_layer_flow_map`, `explain_code`.** Non-custom field rows carry `role: "standard-field"`. `ns.Type` targets with no node, where `ns` is a namespace learned from the graph, are reported as the pseudo kind `managed-package`.
- **`cross_layer_flow_map`** follows every cross-layer rel type. A reached method stays member-precise: it adds its owner class as a participant, but no longer expands the class's other methods.
- **`trace_upstream`** hops are member-precise by default. Callers of unrelated sibling methods are no longer counted.
- **`wip_impact`** uses component-level hops, as its description says ("every component that depends on a changed component"). It also seeds the dependents pass from removed components.
- **`impact_from_git_diff` / test-gap from git diff.** Seeds are member-level when the hunks identify the method. Every parsed type is mapped, renames are followed, and unmapped paths are listed. An ambiguous hunk, or an insertion at the end of a method, still seeds the whole class.
- **`governor_risk_check`** sorts by severity before applying its limit; it used to cut alphabetically. SOSL and dynamic SOQL inside loops are reported (dynamic queries on the regex parser path only).
- **`find_similar`** filters the keyword leg by label before its limit, so the filter no longer starves that leg. It collapses members to their component, never returns the focal's own component, and ranks test and record rows lower.
- **Test coverage** (`test_gap_intelligence_from_git_diff`, `wip_test_gap`) decides coverage and test-ness on the owning class, with one verdict per unit.
- **Apex parsing.**
  - Inline SOQL ends at its depth-0 bracket outside string literals, so bind expressions such as `:ids[0]` no longer cut a query short.
  - Dynamic SOQL WHERE / GROUP BY / ORDER BY fields are emitted when FROM is a literal. With a variable FROM they are counted as skipped. A variable FROM object is still not resolved.
  - A relationship as the last path segment reads its lookup field, or is skipped. A `<Seg>Id` relationship leaf resolves only to a lookup field.
  - Class-level SOQL and `Database.*` DML are parsed. `FeatureManagement` is a platform namespace.
- **Other parsers.**
  - ApexPage / ApexComponent controllers and extensions are read from filesystem input, quoted with single or double quotes.
  - Process Builder flows get their object from `processMetadataValues`.
  - `lightning-*` base tags are not `EMBEDS_LWC`.
  - Vlocity Set Values elements that name an Integration Procedure link to it.
- **MCP during a sync or rebuild.** A tool result now warns when a sync or rebuild of the org it read is running. It does not refuse, and direct handler calls get no warning.
- **Ingest robustness.**
  - A member whose content crashes parse workers repeatedly is quarantined, instead of being retried on every delta.
  - An aborted member stream is reported in the ingest result.
  - A resolver or dead-code failure during a delta is never recorded as a clean sync.
  - The DataRaptor relationship resolver never takes over an edge a parser owns.
- **Benchmark harness.** The layer-2 token cap now counts cache-creation and cache-read tokens (the old input+output figure is a separate column), so earlier layer-2 results are not directly comparable. Layer-2 agents are scoped to the corpus path.

### Accuracy and safety fixes (audit)

- **Aura components** (filesystem and project ingests). `AuraComponent:<bundle>` nodes now have these edges:
  - `CONTROLLED_BY` to the Apex controller. A foreign namespace becomes `ApexClass:ns.Cls`.
  - `EMBEDS_AURA` and `EMBEDS_LWC` for `<c:name>`. These resolve against the bundles that exist; letter case is only the tiebreak.
  - `REFERENCES_LABEL` for `$Label.c.X`.

  Apex classes and LWCs used only from Aura are no longer reported as dead code. On a large Vlocity repo this adds 41 components and 58 edges. Not parsed yet: server actions (`c.method`), events, `extends`, and a regex literal right after `)` or `]` in controller JS.
- **Edge reconcile is case-insensitive.** A live edge is no longer deleted when only the case of its emitted target changes.
- **Snapshots are versioned (schema v14).** A snapshot stores only the rows that changed, so an unchanged graph adds none; this used to take 6-10 s and about 0.7 GB per snapshot. `point_in_time_diff` runs in SQL, where it used to take 22 s and 4.3 GB of RAM.
  - Diff output is ordered by key.
  - An unchanged node or edge keeps the `last_seen_at` of the snapshot that first recorded its current version.
  - A change to `last_seen_at` alone was never reported as a diff, so the diff sets are unchanged.
- **Long-lived readers see new data.** The label and edge-type caches reload when another connection commits, and read statements are cached; graph traversal used to prepare about 69 statements per BFS node.
- **MCP server during `ingest --rebuild`.** The server keeps answering from the previous complete graph and switches to the new file only once the rebuild completes. A failed rebuild is never adopted. A server *started* mid-rebuild still opens the partial file; that is a known limitation.
- **Locked database.** Opening a DB that needs a migration while an ingest holds the write lock now fails with a clear retry message, not a raw `database is locked`. `busy_timeout` is set on open.
- **A stale sync flag is ignored.** A killed ingest no longer leaves `sync_in_progress` set for readers, including the MCP analysis caches.
- **Ctrl-C with `SFGRAPH_DEBUG_INGEST=1`** now stops the ingest; the debug handler used to swallow the signal.

- **Dead code:**
  - `@isTest` classes are excluded.
  - A class referenced only by tests is reported with reason `referenced_only_by_tests`.
  - Method references keep their class alive.
  - `export_sarif` excludes tests by default (`includeTests`).
- **Org alias resolution** never shells out to the `sf` CLI by default. Opt in with `SFGRAPH_ALIAS_SF_FALLBACK=1`; the timeout is `SFGRAPH_ALIAS_RESOLVE_TIMEOUT_MS`. `list_orgs` reads the registry only.
- **Formula and relationship paths:**
  - `Owner.` / `CreatedBy.` / `LastModifiedBy.` / `$User.X.Y` resolve through the `…Id` lookup to User fields.
  - Formula second hops on self-lookups match the field by its relationship name.
- **Apex:**
  - Inner-class methods see the enclosing classes' static fields.
  - Resolved call edges are re-derived when the caller changes.
- **LWC record bindings** use static context. With no context they bind only when the field name is unique in the org; they never fan out.
- **Dangling-reference audit:**
  - Namespaces are learned only from `ns__Name__<suffix>` names.
  - Custom metadata types (`__mdt`) expect exactly the platform's standard and audit fields.
  - `SetupOwnerId` is expected only on known custom settings. CustomObject nodes now carry `customSettingsType`.
- **CustomTab** metadata has a parser, and `tabs/` folders are routed to it.
- **Live-org ingest no longer loses data silently.**
  - Before this fix, a Tooling `queryMore` that failed during a dropped connection ended the Apex drain without an error. One org graph lost 1,493 of its 1,738 local classes this way.
  - Transient errors are now retried with backoff (`SFGRAPH_LIVE_RETRY_*`). Anything still lost is recorded as a skip, which `--retry-skipped` re-runs. This applies to the Apex, LWC, Flow, security, integration, generic-metadata, custom-settings, OmniStudio and Vlocity sources.
  - A source that hangs, a failed metadata discovery, and a failed Vlocity or OmniStudio probe are now reported as skips instead of silently dropping members.
  - Members the org refuses to return are reported in their own group: "Unreadable (org refused; re-run with --retry-skipped to try again)".
    - A refusal counts as unreadable when the error is deterministic (for example `INVALID_CROSS_REFERENCE_KEY`), or when the same `UNKNOWN_EXCEPTION` repeats on 3 attempts.
    - These members are not auto-retried. `--retry-skipped` reads them again.
    - After 10 identical refusals, the first pass stops reading that type. A later successful read resumes it.
  - Settings members are read as `<name>Settings`. EntityDefinition object classification is read in prefix-split pages, so large orgs are no longer truncated.
  - The CLI exits as soon as the ingest finishes. Before, a leftover watchdog timer kept the process alive for minutes after the last line.
  - Live-org request throttling no longer inherits a cancelled source's stop signal.
- **A local ApexClass wins over a managed class of the same name**, and carries `shadowsManaged: true`.
- **Platform events** (`__e`) are kept by the live object extractor.

- Vlocity DataPack scanner: `Cards` string lists → VlocityCard, any `dataSource`/`Datasource` (object or string) → `classifyDataSource` (ApexRemote data sources now resolve to ApexClass/ApexMethod), `c:x` / `c__target=c:x` strings → `LWC:x` (CSS-like `-c:hover` excluded). Exact, unique name matches of string values to an IntegrationProcedure/DataRaptor/OmniScript become REFERENCES with `inferred: "name-match"` (post-ingest `resolveVlocityNameMatches`; never overrides an explicit edge). Orphan `*_Element_*.json` siblings are inlined into their OmniScript/IP.
- Apex (default regex parser): `new Foo(…)` → INSTANCE_OF and `Foo.CONST` / enum / inner-type use → REFERENCES to user Apex classes. Trigger bodies, constructors and field initializers now get static-call, constructor and static-member edges. Static-call arity counts string-literal arguments (`Foo.bar('x')` was recorded as `bar(0)`).
- Dynamic SOQL: SELECT string literals built by concatenation (and directly following `q +=`) with a literal FROM object yield READS_FIELD edges marked `dynamic: true`.
- LWC: compiled-OmniScript `_def.js` (OMNIDEF) yields IP/DR/remote/LWC/OS edges plus `REFERENCES OmniScript:<Type>_<SubType>_<Lang>`. `import 'c/x'` and `c__target` link LWC → LWC. Record-literal `X__c` keys bind to a field when its API name is unique in the org (`LWC_BINDS_FIELD`, `inferred`; post-ingest `resolveLwcFieldKeys`).
- Flow: READS_FIELD / WRITES_FIELD from `Flow:<name>` for record-element filters and assignments, `$Record`/`$Record__Prior`, typed variables, Get Records outputs and formulas. Screen components `c:x` → EMBEDS_LWC.
- FlexiPage: embedded custom components now point at `LWC:<name>` (previously a dangling `LightningComponentBundle:` label). Run `sfgraph ingest --rebuild` to drop the old edges.
- `dead_code_audit`: labels outside the scored set (e.g. DataRaptor) are computed live as zero-inbound nodes (label match is case-insensitive; confidence/freshness filters do not apply and the output says so) instead of reporting "no dead code detected".
- Dead code: a node is dead when it has zero real inbound references; freshness now only sets confidence (≤30 days low, 31–180 medium, >180 high) instead of hiding recently modified nodes. Cached and live paths share `scoreDeadCode` and return the same set. LWC bundle-to-own-component containment no longer counts as usage, LWC is scored, and a legacy cache with no current rows falls back to the live scan.
- `analyze_field`: the description says Flow field refs are tracked and that commented-out code and string-only mentions are excluded from the graph.
- DataRaptor field targets: Extract output rows (`Alias:Field`, nested `A:B:Field`) resolve through the step row's `InterfaceObjectName`; the DataPack `%vlocity_namespace%__` token is replaced with the Vlocity namespace detected from the source tree's object folders (stripped otherwise); `Rel__r.Field` paths are stored on the DataRaptor node (`drRelationshipPaths`) and resolved after merge through the lookup field's `referenceTo` (each hop's lookup field is emitted too; unknown or polymorphic targets emit nothing). `Formula`/`Configuration` pseudo pairs and `$Vlocity.*` tokens no longer become field targets. Disabled mapping rows (`IsDisabled: true`) are skipped. Filesystem CustomField nodes now carry `referenceTo` / `relationshipName`. Existing graphs: a plain re-ingest picks this up (the CustomField and DataRaptor node hashes carry a parser-version salt, so unchanged sources re-merge); a DataRaptor that now emits no edges at all keeps its old pseudo-target edges until `sfgraph ingest --rebuild`.
- Object folders with `fields/*.field-meta.xml` but no `<O>.object-meta.xml` now yield a stub CustomObject (`attributes.stub: true`) with its CustomField nodes and DEFINES_FIELD edges. `analyze_field` no longer stops at "field not found" when edges target the qname: it says the node is missing and lists the inbound edges (other rels under "Other inbound").
- Apex member-access field refs: a receiver resolves only to a declaration before the use, then to fields/properties (`T x { get; set; }` included) of its own enclosing class (constructor/initializer locals and other inner classes no longer leak; conflicting outer types are skipped). `Id` is no longer emitted from member access or constructors. AST mode no longer duplicates member-access READS_FIELD.
- Apex classes and triggers now emit READS_FIELD / WRITES_FIELD (`CustomField:<Object>.<Field>`, attribute `via: "member-access"`) for member access on SObject-typed locals, params, enhanced-for vars and class fields, `list[i]` / `.get()` elements, `Trigger.new[i]` / `Trigger.old[i]` / `Trigger.newMap.get()` / `Trigger.oldMap.get()` (trigger object), assignment LHS (write; `+=`/`++` also read) and `new Obj(F = v, ...)` constructors (write). The object comes from the declared type; untyped and `SObject` receivers are skipped. Comments and strings yield nothing. Duplicates of SOQL select-list READS_FIELD are not re-emitted. The AST extractor keeps the `__c` suffix on dotted field refs. The standard-SObject whitelist moved to `domain/standard-sobjects.ts`.
- Apex classes using the null-coalescing operator `??` no longer become ParseError nodes: code-level `??` is rewritten to the same-length `||` for grammar validation only (comments, strings and stored source are untouched). ParseError messages are now `line:column message` instead of `[object Object]`.
- Generic DataPack scanner: fields whose normalised name ends in `DRBundleName`/`BundleName` (DocumentTemplate DataExtract/Token DR, …) with a non-empty string produce REFERENCES edges to `DataRaptor:<value>`.
- Vlocity DataPack types without a dedicated parser (VlocityAction, …) now go through a generic reference scanner: OmniScript launch URLs (`OmniScriptType/<T>/OmniScriptSubType/<S>/OmniScriptLang/<L>` or the query form `OmniScriptType=<T>&…`, URL-decoded) become REFERENCES edges to `OmniScript:<T>_<S>_<L>`.
- VlocityCard parser: `dataSource` objects (any nesting, plus the top-level `Datasource` field) now yield VC_USES_DR (`value.bundle`), VC_CALLS_IP (`value.ipMethod`) and VC_INVOKES_REMOTE (`value.remoteClass`/`remoteMethod`, resolved to Apex by `resolveVlocityApex`).
- Vlocity parsers: any element whose propertySet has a `remoteClass` (Try Catch Block, Log Catch Block, …) now yields a remote ref, so `resolveVlocityApex` links it to Apex. References from inactive elements (`Active`/`IsActive` false, or under an inactive ancestor) are kept and tagged `inactive: true`; an edge is inactive only when every contributing element is inactive, and the flag carries onto the resolved ApexClass/ApexMethod edges.
- `trace_downstream`: containment is no longer a dependency. A reached CustomObject/CustomField/ValidationRule/RecordType/NamedCredential is a leaf (no DEFINES_FIELD, HAS_VALIDATION_RULE, HAS_RECORD_TYPE, CONTAINS, field→field READS_FIELD or DEPENDS_ON_FIELD expansion); new `include_structure: true` restores the old expansion. Reaching an ApexMethod now also reaches its ApexClass and the class's other methods at the same hop (class roll-up). Core `findDependencies` gains opt-in `leafStructure` / `rollupApexClass` options (default off, so `impact_from_git_diff` is unchanged). `trace_upstream` traversal is unchanged.
- `trace_downstream` / `trace_upstream` text output is now a lossless plain list: full qnames grouped by label with min hop and rel, a per-label count header, dangling endpoints marked `(no node)`, capped at 300 entries with an omitted count. New `labels` filter; mermaid only with `mermaid: true`. `data.reached` carries the same list.
- `analyze_field`: readers/writers now include every `*_READS_FIELD` / `*_WRITES_FIELD` rel (DataRaptor `DR_READS_FIELD` / `DR_WRITES_FIELD` were ignored), enumerated by suffix. Output is a plain list of full `<Label>:<Name> — REL`. GRANTS_FIELD_ACCESS sources are hidden unless `include_grants: true` (`data.grants_count` always set); mermaid only with `mermaid: true`. Description now lists every component kind.
- `dead_code_audit`: new `label` and `pattern` (name prefix or glob) filters; output is a plain list instead of a table, capped at `limit` with a narrowing hint. `find_nodes` default cap is 200 with a "N more, narrow with ..." line.
- `trace_downstream` roll-up: sibling methods reached by Apex class roll-up are collapsed under their class line (`ApexClass:C (+k methods via roll-up)`) so they cannot crowd other labels out of the 300-entry cap; core roll-up lists each class's siblings once.
- OmniScript/IntegrationProcedure nodes are now keyed `Type_SubType[_Language]` (was record Id). Existing graphs: run `sfgraph ingest --rebuild` once.

## 1.5.0 — case-insensitive qnames + hybrid search

Two features that subsume the unreleased 1.4.1 line (the audit hardening below
ships as part of 1.5.0). Packages bumped: core/server/cli/`sfgraph` → 1.5.0,
skills → 1.2.1. Two schema migrations run automatically on next open (existing
graphs are upgraded in place; `--rebuild` also works).

### Case-insensitive qnames (migration 9)

Salesforce API names are case-insensitive (`Account` == `account`), but qnames
were stored/looked-up case-sensitively, so a SOQL `from account` produced a
`CustomObject:account` edge that never matched the `CustomObject:Account` node —
dangling edges, duplicate rows, missed joins, case-sensitive lookups. Every
qname-keyed column now uses `COLLATE NOCASE`, so `=`, PK uniqueness, and JOINs
fold case while the original display string is preserved (no data rewrite).
Migration 9 upgrades existing tables (rewriting each table's own CREATE SQL,
collapsing case-duplicate rows); `find_nodes`/`explain_code`/`analyze_field` now
resolve regardless of the case queried. See `docs/design/case-sensitivity.md`.

### Hybrid search: FTS5 keyword leg + relevance floor + identifier word-split (migration 10)

`find_similar` now fuses two legs via Reciprocal Rank Fusion:

- **Vector leg** (MiniLM cosine KNN) with a new `min_similarity` floor (default
  0.3) so it returns the *relevant* matches up to k, not always k including
  irrelevant tail — and reports how many weaker ones were hidden.
- **Keyword leg**: a new FTS5 index (`_sfgraph_node_fts`) over each node's
  embed-text, queried with bm25. Gives exact-name recall the ANN leg misses, and
  answers even when the embedder/vector index is unavailable.
- **Identifier word-split**: `AccountController` → "account controller",
  `Customer_Tier__c` → "customer tier", folded into both the embedding input and
  the FTS body so word queries match camelCase/snake_case identifiers.
- **Label-filtered search** no longer starves (over-fetch then slice to k).

See `docs/design/hybrid-search.md`.

## 1.4.1 — post-1.4.0 audit hardening (two re-audit waves)

Driven by two independent re-audits of the 1.4.0 fix wave. The first found four
regressions the 1.4.0 changes themselves introduced; the second swept the
remaining correctness/cohesion backlog. Every fix below ships with a regression
test that would have caught it (the recurring lesson: the green suite covered
none of these). Packages bumped: core/server/cli/`sfgraph` → 1.4.1, skills → 1.2.1.

### Regressions introduced by 1.4.0 (fixed)

- **Edge reconcile no longer full-table-scans.** `reconcileSources` ran
  `SELECT * FROM <every edge table>` per parsed member (O(members×edges), and it
  read other orgs' rows) — now scoped to `WHERE org_id=? AND src_qname IN (…)`,
  chunked and index-served on the PK.
- **Reconcile no longer deletes MCD/foreign-pass edges.** It now skips edges
  carrying a provenance marker (`attributes.source` = mcd/reflection, or
  `attributes.resolvedBy` = arity), so the pre-fan-out MCD baseline's long-tail
  dependency edges survive a re-parse.
- **Constructors are no longer captured as phantom methods.** Making the method
  modifier optional (for implicit-private methods) let `public Foo(...) {`
  backtrack to a fake `ApexMethod:Foo.Foo`; `findMethods` now rejects a match
  whose return-type is a modifier or whose name equals the class name.
- **Incremental holds its watermark.** When incremental detects changed members
  it can't fetch yet, it no longer advances `last_synced_at` past them (which
  made two consecutive incrementals lose those changes permanently).

### Tool correctness

- **Governor detection is real.** `findGovernorRisks` read a `hasSoqlInLoop`
  attribute no parser ever set → empty SARIF and a fabricated "no risks
  detected" on the no-cache path. It now reads the real `EXECUTES_SOQL/DML`
  edges stamped `inLoop` by the Apex + trigger parsers. `governor_risk_check`
  also gained a `limit`.
- **dead_code_audit** no longer counts permission grants (`GRANTS_*`) or
  reflection-sourced references as "usage" (kept dead code alive).
- **snapshot_create** honors its `kind` argument (was hardcoded `is_auto=false`).
- **test_gap** no longer reports test methods/`@isTest` classes as coverage gaps.
- **deployment_manifest_gen** surfaces an `incomplete` block (diff truncated +
  dropped unmapped labels) instead of silently emitting a partial package.xml.

### Parser / ingest

- **SOQL subquery object** taken from the `FROM` at parenthesis depth 0 — a
  child subquery or `WHERE … IN (SELECT … FROM X)` no longer misattributes the
  query; the stored `query` is now the full bracketed text.
- **All named credentials** captured (the loop re-scanned the wrong string and
  dropped every credential after the first).
- **Braceless loops** (`for (…) doIt();`, `do x(); while(y);`) no longer bleed a
  loop range onto the next unrelated block → no false SOQL/DML-in-loop findings.
- **Incremental deletes resolve + cascade.** Obsolete members are keyed by the
  node label (LWC was a silent no-op under the raw member type); deleting a
  class/trigger cascades to its `CONTAINS_METHOD` children instead of orphaning
  them.
- **Cross-flavor hash churn fixed** — the `+canonical:` suffix no longer
  accumulates, so matched Vlocity/OmniStudio nodes stop reading as "modified"
  every sync.
- **Analysis tables purge stale rows** and repopulate in one transaction
  (also removes the per-node N+1 write storm).
- **start_ingest_job** dropped the bogus `--from-fs` command (the CLI has no
  such flag); live-org only.

### Embeddings / search

- **Unchanged nodes skip the model.** The content-hash is now checked BEFORE
  MiniLM runs (`VectorStore.getContentHash`), so an unchanged org no longer
  re-pays embedding inference every full sync — only the write was skipped before.
- **Descriptions are embedded.** Object/field `description` was extracted then
  dropped by the parser; it's now carried on the node and folded into the
  embedding. Apex/trigger/Flow **snippet source** is folded into the embed input
  too, so `find_similar` matches on what code does.
- **Label-filtered search no longer starves** — `searchNodes` over-fetches then
  slices to `k` (the label filter was applied after the KNN bound, often
  returning < k or zero).

### Skills

- Corrected the now-false "graph stores source only for Apex methods" wording in
  `sf-graph-router`, `sf-debug-root-cause`, `sf-debug-log-analysis`, and the
  `explain_code` description (triggers + Flows now store source).
- Fixed Mermaid claims: `sf-what-broke` embeds the diagram the tool emits;
  `sf-governor-risk-fix` / `sf-deployment-manifest` build their own from tool
  data (those tools return tables/XML, not diagrams).
- Added an **Evidence rule** ("say it only if something backs it") to all 20
  skills, and a CI contract test validating every SKILL.md `tools_used` against
  the live tool registry.

## skills 1.2.1

Shipped with 1.4.1 (skills versioned independently). The Evidence-rule guardrail
across all 20 skills, the source-storage + Mermaid wording corrections, and the
SKILL.md↔registry contract test. See the **1.4.1 — Skills** section above.

## skills 1.2.0

Shipped as part of the 1.4.0 release (the skills package is versioned independently). Adds the `sf-graph-router` start-here/grounding-first skill, `sf-debug-root-cause`, and `sf-debug-log-analysis`; grounding-first cross-links from the `sf-architect-*` design skills; and playbook corrections aligned with real tool behavior. See the **1.4.0 — Skills** section below for detail.

## 1.4.0 — real-org correctness: Vlocity/OmniStudio lineage, config values, tool & skill hardening

Driven by validating sfgraph against a large real Vlocity-CMT enterprise org (89k+ nodes). Every fix below was caught or confirmed by a real ingest, not just unit tests — several were "green tests, broken on a real org" seams. Packages bumped: core/server/cli/`sfgraph` → 1.4.0, skills → 1.2.0, web → 1.1.9.

### Ingest correctness (the "green tests, broken org" class)

- **Members no longer silently dropped.** `adaptParserInput` returned `null` for any metadata type outside a hardcoded switch, so ~250 generic-extractor types (Layout, CustomTab, Bot, GenAi…) were extracted, logged ✓, and never merged — leaving 59k+ grant edges dangling on nodes that were never created. Unknown types now route to their registered rule parser or an opaque node. Visible for months as `fan-out complete (963)` vs `complete members=503`.
- **Vlocity lineage now actually populates.** The runner emits `memberType: "DataRaptor"` but the rich parsers register as `"VlocityDataRaptor"`; dispatch fell through to the opaque parser, so a full ingest produced **zero** DataRaptor/IP/OmniScript lineage edges (only `VlocityCard` happened to align). Added the member→parser-type mapping + an end-to-end runner→dispatch→parser test. Confirmed on a large Vlocity org: `dr_reads_field` 131, `ip_calls_dr` 185, `os_uses_dr` 31.
- **DRMapItem children load by Name, not a non-existent FK.** The DataRaptor child query selected `Input/OutputFieldName__c` (absent on `DRMapItem__c`) and filtered on `DRBundleId__c` (also absent in `vlocity_cmt`). Both threw `INVALID_FIELD` → childless DataRaptors. Now selects the real mapping columns and correlates by `Name` (`linkBy`). Cleared the prior 8 DataRaptor skips.
- **OmniDataTransform field mappings** captured structurally from `OmniDataTransformItem` (SOQL child fetch) + the Metadata-API retrieve XML shape; SOQL/retrieve dedup so a component isn't ingested twice.
- **Apex paginates** (`queryMore`) — was capped at the first 200 of thousands of classes. **Rate-limiter deadlock fixed** (bottleneck@2.19.5 disarms `reservoirRefreshInterval` on any `updateSettings()`; replaced with a self-managed refill) — the cause of full-run hangs. **Full generic coverage** by default (opt-out `SFGRAPH_GENERIC_WHITELIST_ONLY=1`) + child types (ValidationRule/ListView on standard objects) dispatched.
- **Embeddings no longer silently zero.** `sharp`/`sqlite-vec` added to pnpm `onlyBuiltDependencies`; the embedder now warns loudly (once) on the zero-vector fallback instead of swallowing it.

### Config VALUES captured (config resolves to real values)

- **Custom Metadata records** carry their field `values` (endpoints, matching keys, toggles); **Custom Labels** carry `value`/`language` (the redundant singular `CustomLabel` path is suppressed so it can't clobber them); **Custom Settings** get a new `CustomSetting:<obj>` node holding their org-default/hierarchy rows, linked to the schema object. All three are **folded into node embeddings**, so `find_similar("endpoint for product push")` reaches the record holding it.

### Analysis & MCP tools — work on real data, denoised

- **`governor_risk_check`** detects SOQL/DML-in-loop from the graph (the Apex AST and the **default regex** parser both stamp `inLoop`) — was returning 0 on every live org because it scanned an Apex body that live ingest discards.
- **`analyze`/CLI now wires `analysisDb`** — the findings / dead-code / governor / test-coverage tables were never populated, so the analysis tools silently returned empty.
- **`trace_upstream`/`trace_downstream`** hide security-grant and reflection-inferred edges by default (a class granted to 100+ profiles no longer buries its real callers); `include_security` / `include_inferred` / `rel_types` to opt in.
- **`dead_code_audit`** summarizes by confidence/type with a capped list (was a multi-MB dump that blew the token budget). **`security_audit`** filters CMDT/system/audit fields from FLS gaps (was dominated by `__mdt` system-field noise). **Dangling-edge audit** classifies platform-builtin refs (standard tabs / standard-schema fields) separately from real gaps.

### Skills — cohesion, routing, and a debugging spine (skills 1.2.0)

- **`sf-graph-router`** — "start here": routes intent → the right skill+tool across dev/design/debug/quality, and enforces a **grounding-first** rule (query the org graph before generating/changing metadata — the antidote to hallucinated fields/classes).
- **`sf-debug-root-cause`** (symptom → graph cause) and **`sf-debug-log-analysis`** (parse an Apex debug log → ground in the graph) round out the debugging pillar.
- Grounding-first cross-links from the `sf-architect-*` design skills into the graph; playbooks aligned with real tool behavior; `explain_code` documents its method-level qname requirement.

### Tooling

- **`pnpm test:kit`** — one-command Tier-1 pre-publish gate (lint → typecheck → build → test → preflight pack/tarball scan) with a GO/NO-GO verdict, plus `TESTKIT.md` documenting the Tier-2 org-validation checklist.

## 1.3.0 — Phase 1.5: wedge isolation + ingest correctness

A real-org ingest no longer reports a metadata type as "skipped" because of a wedge in an unrelated source. Seven atomic commits closed a cascade failure that, in a baseline run against a Vlocity-CMT org, caused **37 metadata types** (including `security`, `vlocity`, `object`, `flow`, `lwc`, `layout`, `customMetadata`, GenAi types, ExperienceBundle, ConnectedApp, and SamlSsoConfig) to be silently skipped after a single LWC bundle wedged the pool for 440 seconds. Also closed a latent **graph-extinction risk** where the `--detect-deletions` sweep could wipe an entire label on a wedge-induced empty stream.

### Added

- **Wedge isolation (W1.5-01 + W1.5-02).** When the per-source watchdog (90 s first-yield, 5 min inactivity) fires, the source's pool slot is released so the next queued source runs. The wedged iterator continues in the background; late records are drained with `attributes.lateYield: true`. Background-wedge count capped at `SFGRAPH_MAX_BACKGROUND_WEDGES` (default 4); when exceeded, oldest entries are marked `stopWaiting: true` and skipped from the late-drain pass.
- **Stop-waiting semantics (W1.5-03).** New `StopWaitingError` sentinel. `withTimeout` / `soqlWithTimeout` / `scheduleQuery` accept an optional `stopSignal`. On flip: the race rejects with `StopWaitingError`, the local `setTimeout` is cleared, queued Bottleneck jobs are dropped before their callable runs. **Known limitation:** the underlying HTTP request continues until Node's socket idle timeout (~10 min) — jsforce 3.10.15 creates its `AbortController` internally and never exposes it. Worst-case memory leak: 4 wedges × ~1 MB ≈ 4 MB per ingest, garbage-collected at process exit.
- **LWC per-bundle parallelization (W1.5-04).** Replaced the serial for-loop in `extractors/lwc.ts` with a sliding window of 8 concurrent per-bundle `LightningComponentResource` Tooling SOQL calls. Yields as each bundle completes (order-independent). Tooling pool cap = 5 prevents oversubscription; Bottleneck queues the extra 3. One slow bundle no longer freezes the `lwc` source; the watchdog heartbeat stays fresh.
- **Detect-deletions drop-ratio guard (W1.5-07).** The `--detect-deletions` sweep at end of full-sync now refuses to wipe any label whose drop ratio exceeds `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO` (default 0.30), and unconditionally refuses when a label has prior nodes but zero touched (empty-stream case). Refused labels keep their `last_seen_at` so staleness reports still surface them. Emits `wedge:detect-deletions:refuse:label=X:reason=...` warning.
- **Sync-generation counter + MCP `_meta.staleness` (W1.5-08).** New columns on `_sfgraph_orgs`: `sync_generation INTEGER`, `sync_in_progress INTEGER`, `sync_started_at TEXT` (additive migration v8). Every MCP tool response now carries:
  ```ts
  _meta.staleness: { generation, in_progress, started_at, last_sync_at }
  ```
  Concurrent MCP clients can detect `in_progress: true` and warn the user that the graph is being rewritten. No global ingest transaction; per-resolver isolation preserved.
- **`sfgraph diagnose <orgId>` CLI subcommand (W1.5-05).** Runs an ingest with concurrency forced to 1, captures per-source timing + wedge events + capability probe results + detect-deletions refusals, and writes a structured JSON report to:
  - macOS: `~/Library/Application Support/sfgraph/diagnostics/<orgId>-<timestamp>.json`
  - Linux: `~/.local/share/sfgraph/diagnostics/<orgId>-<timestamp>.json`
  - Windows: `%APPDATA%\sfgraph\diagnostics\<orgId>-<timestamp>.json`

  Flags: `--output <path>`, `--max-duration <seconds>`, `--verbose`, `--keep-graph`. Defaults to a temporary graph DB so the user's main graph is untouched.
- **New environment variables.** `SFGRAPH_MAX_BACKGROUND_WEDGES` (4), `SFGRAPH_DETECT_DELETIONS_MAX_DROP_RATIO` (0.30), `SFGRAPH_WATCHDOG_FIRST_YIELD_MS` (90 000), `SFGRAPH_WATCHDOG_INACTIVITY_MS` (300 000), `SFGRAPH_LATE_DRAIN_BUDGET_MS` (60 000). All documented in the new "Environment variables" reference table in the README.
- **`docs/COVERAGE.md`** (new). Authoritative matrix of every metadata type sfgraph ingests, status (Full / Partial / Generic-Only / Unsupported), edges emitted, known limitations, and source file. Replaces the old narrative-style coverage page.

### Changed

- **README reconciled with shipped reality.** Corrected MCP tool count (was claimed "26", actual **28**). Added Reliability, Diagnostics, MCP staleness signal, Environment variables (36 vars documented, sorted alphabetically with type / default / purpose / since-version), Honest disclosures, and Coverage sections. Honest disclosures call out the four security types that are Generic-Only (`PermissionSetGroup`, `MutingPermissionSet`, `ProfileSessionSetting`, `ProfilePasswordPolicy`), the `SECURITY_PER_LABEL_CAP=5000` analysis truncation, the 80-of-327 generic whitelist, the LWC empty-bundle behavior change (see below), and the socket-leak limitation.
- **Warning surface format.** Warnings emitted into `LiveIngestResult.warnings: string[]` now use a namespaced colon-delimited convention: `wedge:<sourceLabel>:firstYield:90s:lastYieldedRecord=...`, `wedge:<sourceLabel>:inactivity:300s`, `wedge:<sourceLabel>:resolvedLate:atMs=N`, `wedge:cap:backgroundWedgeAborted:source=...`, `wedge:lwc:bundleFetchFailed:bundleId=...:bundleName=...:error=...`, `wedge:detect-deletions:refuse:label=L:reason=empty-stream|drop-ratio:...`. Forward-compatible with a future structured shape via a documented parse schema.

### Behavior changes (read before upgrading)

- **LWC empty-bundle nodes will disappear on re-ingest.** Prior versions yielded a stub `RawMember` with `files: {}` on per-bundle resource-fetch failure, creating empty `LightningComponentBundle` nodes in the graph. 1.3.0 emits a `wedge:lwc:bundleFetchFailed:...` warning and no record. Users upgrading from 1.2.x may see previously-recorded empty LWC bundles disappear from their graph on the next re-ingest. **This is correct** — those nodes were artifacts of a silent failure.
- **No public API changes.** All new options are optional with safe defaults; existing call sites of `liveIngest`, `bulkRetrieve`, `withTimeout`, `soqlWithTimeout`, `scheduleQuery`, and `graph.touchSync` keep their pre-1.3.0 contract.

### Tests

- **+59 new tests across the workspace.** Full suite: 807/807 passing.
  - Wedge isolation: 4 cases (`packages/core/src/extractors/live-org/__tests__/wedge-isolation.test.ts`)
  - Detect-deletions guard: 19 cases (`packages/core/src/ingest/__tests__/live-ingest.detect-deletions-guard.test.ts`)
  - LWC parallelization: 5 cases (`packages/core/src/extractors/live-org/extractors/__tests__/lwc.parallel.test.ts`)
  - Sync-generation: 11 cases (`packages/core/src/storage/__tests__/sync-generation.test.ts`)
  - MCP staleness surface: 5 cases (`packages/mcp-server/src/__tests__/staleness-surface.test.ts`)
  - Stop-waiting: 10 cases (`packages/core/src/extractors/live-org/__tests__/stop-waiting.test.ts`)
  - Diagnose CLI: 11 cases (`packages/cli/src/__tests__/diagnose.test.ts`)

### Versions

| Package | 1.2.x | 1.3.0 |
|---|---|---|
| `@ryanstark24/sfgraph-core`    | 1.2.0 | **1.3.0** |
| `@ryanstark24/sfgraph-cli`     | 1.2.1 | **1.3.0** |
| `@ryanstark24/sfgraph-server`  | 1.2.1 | **1.3.0** |
| `@ryanstark24/sfgraph`         | 1.2.1 | **1.3.0** |

Unchanged in this release: `-shared@1.1.3`, `-skills@1.1.4`, `-models@1.1.0`, `-web@1.1.8` (no source changes).

### Publish

Use `pnpm publish` (not `npm publish`) per the 1.2.1 release-hygiene note — required to rewrite `workspace:*` specifiers to concrete versions at pack time.

### Deferred to future phases

- **Bulk API 2.0 migration** for large SOQL paths — gated on profiling proof that parsing is CPU-bound. Tracked in `.planning/STATE.md` backlog.
- **Parallel `processOne` + buffered SQLite writes** — gated on profiling proof; speculative 3–5× throughput claim was rejected without per-record timing data.
- **First-class extractors for PermSetGroup / Muting / ProfileSessionSetting / ProfilePasswordPolicy** — currently Generic-Only; deferred to a future Security phase.
- **`SECURITY_PER_LABEL_CAP` removal** — analysis-layer cap stays at 5000; documented in `docs/COVERAGE.md`.
- **jsforce upgrade exposing `AbortController`** — required for true in-flight HTTP cancellation; tracked as backlog. Worst-case socket leak (4 MB per ingest) is the documented bound.

## 1.2.1 — packaging fix (re-publish of 1.2.0 for `-cli`, `-server`, `sfgraph`)

**No source changes.** This release exists only because `1.2.0` of three
packages (`@ryanstark24/sfgraph-cli`, `@ryanstark24/sfgraph-server`,
`@ryanstark24/sfgraph`) shipped to npm with **unresolved `workspace:*`
dep specifiers** that `npm install` rejects with
`EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`.

Root cause: pnpm's `workspace:*` protocol must be rewritten to a
concrete version at pack time. **`pnpm publish` does this; `npm publish`
does not.** The 1.2.0 release used `npm publish` for those three
packages by mistake (`-core@1.2.0` was packed via pnpm and is
fine — no change here).

Affected, now fixed:

| Package | 1.2.0 (broken) | 1.2.1 (fixed) |
|---|---|---|
| `@ryanstark24/sfgraph-cli`    | `workspace:*` in deps | concrete versions |
| `@ryanstark24/sfgraph-server` | `workspace:*` in deps | concrete versions |
| `@ryanstark24/sfgraph`        | `workspace:*` in deps | concrete versions |

Unchanged (1.2.0 was correct):

| Package | Version |
|---|---|
| `@ryanstark24/sfgraph-core` | 1.2.0 (kept) |
| `@ryanstark24/sfgraph-shared` | 1.1.3 |
| `@ryanstark24/sfgraph-skills` | 1.1.4 |
| `@ryanstark24/sfgraph-web` | 1.1.8 |

**Migration:** if you tried `npm i -g @ryanstark24/sfgraph@1.2.0` and got
the `EUNSUPPORTEDPROTOCOL` error, re-run with `@1.2.1`:

```bash
npm i -g @ryanstark24/sfgraph@1.2.1
```

The 1.2.0 broken versions have been deprecated on npm with a pointer to
1.2.1, so `@latest` resolution now skips them automatically.

**Publish hygiene going forward:** every release MUST use `pnpm publish`
(not `npm publish`) from within a pnpm workspace. Added to release docs.

## 1.2.0 — hardening + capability expansion

Eighteen feature commits across six work phases. Every change ships with
tests (core grew 389 → 474, +85 tests). All four new optional passes
default to **on**; see "Default-behavior change" below for the off-switch
filters consumers can use to recover the 1.1.8 precision-first behavior.

### Added — new MCP tools

- **`export_sarif`**. Emit every audit finding (governor risks, security
  gaps, dead code, dangling edges) as a single SARIF 2.1.0 report that
  round-trips into GitHub Code Scanning and the VS Code SARIF Viewer.
  Per-rule definitions come from a new `RULE_CATALOG` indexed by stable
  ruleId (`governor.soql-in-loop`, `security.fls-gap`, etc. — PMD-aligned
  vocabulary). Hand-rolled emitter; no `node-sarif-builder` dep.

- **`find_nodes`**. Glob-pattern node lookup (`ApexClass:*`,
  `CustomField:Account.*`, `Flow:{Lead,Account}_*`, `**:*Email*`). Uses
  `picomatch` with `.` as the path separator (not `/`) so qname-shaped
  globs work the way they read. Sub-millisecond on warm graph; capped at
  500 matches with `truncated: true` on overflow.

### Added — new CLI command

- **`sfgraph reset-elemid-map --org <alias> --yes`**. Clears the new
  service-id ↔ qname rename-stability map (see W3-05 below). Non-
  destructive — touches only the rename-detection lookup table, not
  nodes/edges/snapshots/vectors. Used as recovery hatch when the
  rename layer has produced incorrect inferences (e.g. serviceId
  collisions across managed packages with the same DeveloperName).

### Added — new typed edge relations

- **`USES_GLOBAL_VALUE_SET`** — CustomField (picklist) → GlobalValueSet.
  Synthesized from the field's `valueSet.valueSetName` describe column.
- **`DEPENDS_ON_FIELD`** — CustomField (dependent picklist) → controlling
  CustomField on the same object. Synthesized from
  `valueSet.controllingField`.

Total typed rel-types: **88 → 90**. Both gap-fills cover edge classes
Salesforce's `MetadataComponentDependency` SObject silently omits.

### Added — ingest result fields

- **`LiveIngestResult.warnings: string[]`**. Per-source skips collected
  during ingest (formerly only available in stdout). MCP consumers of
  `get_ingest_job` can now read "what got skipped and why" without
  parsing log lines.
- **`LiveIngestResult.overlap: { matched, diverged, empty, annotated }`**.
  OmniStudio overlap-detector summary.
- **`LiveIngestResult.reflectionEdges: number`**. Edges emitted by the
  reflection walker (zero when disabled).

### Added — post-merge passes (default on; opt-out flags noted)

- **OmniStudio overlap detector** (`disableOverlapDetect: true` to skip).
  Annotates every `CANONICAL_OF` pair (Vlocity DataRaptor ↔ Omni
  DataTransform, IntegrationProcedure ↔ OmniIntegrationProcedure,
  OmniScript ↔ OmniProcess, VlocityCard ↔ OmniUiCard) with
  `signaturesMatch: boolean` and `divergencePoints: string[]`.
  Signature = sorted multiset of `(relType, normalisedDstLabel)` across
  the node's outgoing edges with the four cross-flavour prefixes
  collapsed. Lets a migration audit tell a true duplicate (cleanup
  candidate) from a diverged implementation (manual reconciliation).

- **MCD baseline extractor** (`disableMcdBaseline: true` to skip).
  Queries `MetadataComponentDependency` for Layouts, FieldSets,
  EmailTemplates, CustomTabs, Groups, and Queues with Id-range
  pagination around Salesforce's documented 2000-row LIMIT/OFFSET cap.
  Edges tagged `attributes.source: 'mcd'`; coexist with parsed edges
  via separate rel-type tables. Includes Happy-Soup-equivalent
  `isDynamicReference` heuristic (`id == name` → `dynamic: true`).

- **OmniStudio retrieve()** (`disableOmnistudioRetrieve: true` to skip).
  Metadata API `retrieve()` for `OmniUiCard`,
  `OmniIntegrationProcedure`, `OmniDataTransform` alongside the
  existing SOQL path. Yields `RawMember` records with full design-time
  XML envelopes that the SOQL `PropertySet` JSON path can't reach.
  Auto-skips at ≥90% Metadata API quota utilisation
  (`Sforce-Limit-Info` header). Uses `jszip` for zip extraction.

- **Reflection-based generic walker** (`disableReflectionWalker: true`
  to skip). Walks every node's attributes for string values matching
  an existing qname's bare name; emits low-confidence `REFERENCES`
  edges tagged `attributes.source: 'reflection'`. Catches dependency
  references buried in undocumented blob schemas (OmniStudio
  PropertySet, Vlocity Definition, etc.). Self-references, reserved
  words, whitespace strings, and short strings (<4 chars) filtered;
  ambiguous matches across labels tagged `ambiguous: true`. Per-source
  cap of 200 edges (configurable).

### Added — provenance on every edge

- **`EdgeFact` attributes now carry `sourceUri`, `line`, `column`**
  automatically. `makeEdge` mirrors `makeNode`: threads
  `ParseContext.sourceUri` (and optional AST `loc`) onto every emitted
  edge. All 104 `makeEdge` call sites across parsers picked this up
  for free.

### Added — LWC directive handling

- **`lwc:if / lwc:elseif / lwc:else / lwc:for:each`** (and legacy
  `if:true / if:false / for:each / iterator:each`) directive
  attributes are now harvested by the HTML visitor. Bindings are
  emitted as `LWC_BINDS_PROPERTY` edges with `attributes.directive`
  set so consumers can distinguish conditional-rendering bindings
  from regular property reads. `for:each` records the `for:item`
  alias for future child-binding resolution.

### Added — Apex regex-mode arity counting

- The regex-mode Apex parser now counts call-site arguments with a
  balanced-paren scan (handles nested calls, string literals,
  line/block comments). Emits precise dst arities
  (`ApexMethod:Util.doWork(2)`) tagged
  `resolvedBy: 'regex-arg-count'`, matching what AST mode already
  produced. Falls back to `(?)` + `unresolvedArity: true` only when
  the counter can't determine arity — preserves the existing arity-
  resolver's overload fan-out for genuine unknowns.

### Added — IS_TEST attribute

- `attributes.isTest: boolean` now appears on every Apex method node
  derived from the `@isTest` / `@TestSetup` annotation (or `@isTest`
  on the enclosing class with the method static). The label
  (`TestMethod` vs `ApexMethod`) already encoded this; now the
  attribute lets consumers filter uniformly without knowing both
  labels.

### Added — service-id rename stability

- New SQLite table `_sfgraph_service_ids` (migration v7) with
  composite PK `(org_id, service_id)`. Three storage helpers in
  `storage/sqlite/rename-stability.ts`:
  `lookupServiceId(db, orgId, serviceId)`,
  `recordServiceId(db, orgId, serviceId, qname, label)`, and
  `rewriteEdgesForRename(db, orgId, oldQname, newQname)`. When a
  metadata component's Salesforce Id is unchanged but its
  `fullName` changes (rename), the rewriter migrates every edge
  (both directions) from the old qname to the new one in a single
  transaction — replacing the delete+add pattern that silently
  broke the call graph until the next full sync.

- **Mechanism shipped, ingest-time wiring deferred.** Extractor
  integration (calling `recordServiceId` at emit time, triggering
  rewrites in `mergeNodes`) is a follow-up that benefits from
  incremental rollout against real-org data. The reset CLI command
  exists today so any incorrect inferences can be cleared
  non-destructively.

### Added — SOQL infrastructure

- **`runSoqlInRebatchable`** in `extractors/live-org/rate-limit.ts`
  pre-splits oversized ID sets and recursively halves on HTTP 414/
  431 (URI Too Long / Request Header Fields Too Large) errors.
  Bounded by `maxDepth` (default 6); non-rebatchable errors pass
  through to caller's failSoft. Used by the MCD baseline; available
  to future extractors.

- **`readMetadataBatchAdaptive`** now pre-chunks to the
  Metadata-API per-call cap (`METADATA_READ_BATCH_SIZE = 10`) before
  any bisection. Configurable via `SFGRAPH_METADATA_READ_CHUNK_SIZE`
  (clamped ≤10 — the SOAP-side cap). Bisection only fires on
  legitimate errors now.

### Added — pre-PMD-aligned finding catalog

- `analyze/findings.ts` defines the canonical `Finding` type, the
  `RuleDescriptor` shape (name / shortDescription / fullDescription /
  defaultLevel / helpUri — mirrors PMD), and `RULE_CATALOG` indexing
  every rule sfgraph emits. Adapters
  (`governorRisksToFindings`, `securityAuditToFindings`,
  `deadCodeToFindings`, `danglingEdgesToFindings`,
  `collectFindings`) convert each audit's native shape into
  `Finding[]` for downstream SARIF / IDE / CI consumption.

### Fixed — class-level @isTest detection (latent bug)

- `extractClassHeader` was parsing class-level annotations from an
  empty slice (the regex consumed annotations via its leading
  `(?:@[\w()=,'"\s.]+\s+)*` group; the code looked for them in
  `src.slice(0, headerStart)` which was empty). Every `@isTest`
  class had been reporting `isTest: false` on its node, silently
  disabling the `IS_TEST_FOR` edge emission gated on
  `header.isTest`. Fix wakes up the dormant edges — visible in the
  regenerated `AccountControllerTest` golden showing
  `IS_TEST_FOR` edges to `AccountController` and `System`.

### Fixed — silent Vlocity failures

- The three `catch {}` blocks in `extractors/live-org/vlocity/
  runner.ts` (per-type query failure, child-fetch failure) now
  route through an `onError(label, err)` callback wired to
  `bulkRetrieve`'s existing `skipReport`. Schema drift (e.g.
  `DRBundleId__c` removed in newer `vlocity_cmt` versions) and
  "type genuinely absent" now produce distinguishable telemetry
  on `LiveIngestResult.warnings`.

### Default-behavior change — breadth over precision

The four new post-merge passes (overlap detector, MCD baseline,
OmniStudio retrieve, reflection walker) ship on by default. Two of
them — overlap detector and reflection walker — were flagged in
Pitfalls research as "false-positive recovery cost is high"; we
ship them on regardless because the breadth they add to migration
audits and OmniStudio coverage outweighs the cost of an occasional
false positive.

**Recovering 1.1.8-equivalent precision** on any of the four:

```ts
// At ingest time — disable specific passes
liveIngest({
  ...,
  disableOverlapDetect: true,        // skip CANONICAL_OF annotations
  disableMcdBaseline: true,           // skip MCD long-tail edges
  disableOmnistudioRetrieve: true,    // skip Metadata API retrieve()
  disableReflectionWalker: true,      // skip pattern-match REFERENCES
})

// At query time — filter on edge attributes
edges.filter((e) => e.attributes.source !== 'reflection');  // parsed-only
edges.filter((e) => e.attributes.source !== 'mcd');         // skip MCD
edges.filter(                                                 // skip overlap-flagged divergences
  (e) => !(e.relType === 'CANONICAL_OF' && e.attributes.signaturesMatch === false),
);
```

### Schema migration — v7 (auto-applied)

`MigrationRunner` adds `_sfgraph_service_ids` on next ingest. Single
`CREATE TABLE` + index; no data migration. Backup of the prior
schema taken automatically before the migration runs (default
retention: 5 backups under `<data-dir>/.sfgraph-backups/`). Safe to
roll back by replacing the live DB with a backup file.

### Internal — new dependencies

- `jszip@^3.10.1` (runtime — for OmniStudio retrieve() zip parsing)
- `picomatch@^4.0.4` (runtime — for find_nodes glob matching)
- `@types/picomatch@^4.0.0` (devDependency)

All three were already transitively available via `@salesforce/core`;
now pinned as direct deps.

### Internal — README + docs corrected

`docs/DATA_LOCATIONS.md`, `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`,
`docs/DESIGN.md`, `docs/TROUBLESHOOTING.md`, `docs/CLI.md`, and the
top-level README all corrected to reflect the actual platform-
specific storage paths (`~/Library/Application Support/sfgraph/` on
macOS, `~/.local/share/sfgraph/` on Linux, `%APPDATA%\sfgraph\` on
Windows — resolved via the `env-paths` library) and the real env
var inventory (`SFGRAPH_DATA_DIR` / `_CONFIG_DIR` / `_CACHE_DIR` /
`_LOG_DIR` / `_TEMP_DIR`, not the non-existent `SFGRAPH_HOME`). Rel-
type count updated to **90**.

## Unreleased — known parser limitations (file as follow-ups)

- **DataRaptor / OmniDataTransform field-reference regex** doesn't match
  the colon-separated path format Salesforce uses in real DRMapItem /
  OmniDataTransformItem records (`Step:Field`, `Object:Field`). The
  parsers' `extractFieldRefs()` uses a `/\bObject\.Field\b/` regex
  matching dot-separated paths only — which exist in some Vlocity
  legacy DataPacks but not in modern on-core or namespaced DRs. Effect:
  `DR_READS_FIELD`, `DR_WRITES_FIELD`, and `OMNI_USES_DATA_TRANSFORM`
  edges are silently missing on most real Vlocity-CMT and OmniStudio-on-
  Core orgs. Documented by 0-edge golden tests in
  `packages/core/src/parsers/__tests__/{vlocity,omnistudio}.golden.test.ts`.
  Fix requires walking the JSON structure looking for the structured
  `InputObjectName + InputFieldName` (on-core) / `InterfaceObjectName +
  InterfaceFieldAPIName` (Vlocity) pairs rather than regex-matching the
  flattened JSON string. ~30-50 LOC per parser. Help wanted.

## 1.1.8 — follow_up_tools wire-up, parser bug fixes, dead-code cleanup

### Fixed

- **Parser walk() false-positives**. Five parsers (vlocity/integration-
  procedure, vlocity/omni-script, vlocity/vlocity-card, omnistudio/process,
  omnistudio/integration-procedure, omnistudio/ui-card) previously used
  the parent JSON KEY as a fallback "type" when the visited object had
  no `Type` property. PropertySet blobs contain nested objects under
  keys like `remoteOptions` — each one false-positive matched
  `type.includes("remote")` and emitted phantom `IP_INVOKES_REMOTE →
  Remote:unknown` edges. Eliminated 27 false-positive edges across the
  three real-data golden fixtures.

- **`IP_CALLS_IP` edge type never emitted**. The Vlocity IntegrationProcedure
  parser checked `type.includes("integrationprocedure")` but real elements
  have `Type: "Integration Procedure Action"` (with spaces). Normalized
  type strings now strip non-alphanumerics before substring checks.
  Also enables the parallel `"DataRaptor Post Action"` → DataRaptor
  edge match in OmniProcess.

- **OmniProcess field-name fallback**. After the routing fix above,
  OmniProcess parser also needed to accept Vlocity-flavoured
  `dataRaptorBundleName` and `bundle` PropertySet keys alongside the
  on-core `dataTransformName` — real Vlocity-exported metadata can
  appear with either depending on the source tooling.

### Added

- **`follow_up_tools` populated on all 22 affected tools** (was 1/26).
  Maps each tool's natural next-steps (e.g. `analyze_field` →
  `trace_upstream`, `trace_downstream`, `security_audit`,
  `find_similar`). MCP clients that consume the `_meta.follow_up_tools`
  field can now auto-suggest the next action.

- **Tests for 1.1.5 / 1.1.6 features**: `embedTexts` / `embedSingle`
  contract tests (~5), liveness-probe tests with mocked conn (~5),
  `find_similar` tests with stub VectorStore (~6). Closes the
  "shipped without coverage" gap in the audit.

- **Golden parser tests** for all 4 Vlocity DataPack types and 3
  OmniStudio on-Core types. Closes the 6 originally-skipped tests
  (down from 6 to 0).

### Removed

- 5 dead exports across `core` (`vlocityFallback`, `findTestsFor`,
  `rethrowAsIngestError`, `stripNamespace`, `fieldRefEdge`). Internal-
  only, zero importers; cleaned for clarity.

### Docs

- Full env-var reference in `docs/TROUBLESHOOTING.md` covering paths,
  ingest tuning, coverage knobs, embedding overrides, and parser
  internals (13 previously-undocumented vars surfaced).

## 1.1.3 — edge resolution, Apex AST, dangling-edge audit

### Added

- **Apex AST extractor** (`packages/core/src/parsers/apex/ast-extractor.ts`) —
  full AST walk over `apex-parser` output: class/method/property
  declarations, SOQL/SOSL queries, DML statements, method invocations,
  field access, type references. Replaces the prior regex-driven
  approximation with structured edges and resolves the long tail of
  false-negative impact-trace misses.
- **Apex arity resolver** (`arity-resolver.ts`) — disambiguates overloaded
  Apex methods by (name, arg count, arg-type signature) so cross-class
  call edges land on the right target instead of fanning out across every
  overload.
- **Flow invocable-action resolver** (`invocable-resolver.ts`) — resolves
  `Flow → invocable Apex method` and `Flow → subflow` edges that the
  flow parser used to drop on the floor.
- **LWC binding extractor** — HTML visitor now harvests `@wire`,
  `lwc:if/elseif/else`, template event handlers, and slot bindings; JS
  visitor follows them through to the Apex method they ultimately call.
- **`sfgraph audit` command** (`packages/cli/src/commands/audit.ts`) —
  graph-completeness audit that surfaces dangling edges (edges pointing
  at non-existent nodes), unresolved Apex calls, and orphan invocable
  references. Catches silent extraction regressions before they reach
  consumers.
- **Edge-resolution post-passes** in `liveIngest` — second-pass resolver
  fires after every source completes, re-walking unresolved Apex
  invocations / Flow invocables / LWC bindings now that the full node
  graph is populated. Fixes the prior ordering problem where edges
  emitted by an early extractor had nothing to bind to.

### Changed

- **Skill descriptions tightened for unambiguous routing** — 7 SF
  skills had overlapping triggers that made the host LLM coin-flip
  between them:
  - `sf-explain-code` now scoped to Salesforce code only; cross-refs
    `sf-cross-layer-trace` / `sf-schema-overview` for broader scope.
  - `sf-cross-layer-trace` dropped its "proactively volunteer on every
    explain-style question" override and the `explain this LWC` /
    `explain this component` triggers that double-fired with
    `sf-explain-code`. Now offered as an opt-in follow-up.
  - `sf-cross-org-diff` / `sf-what-broke` / `sf-snapshot-compare` no
    longer all trigger on bare "what changed" — each now requires the
    user to name two orgs, name a deploy, or name a snapshot
    respectively, with explicit "use X instead when…" pointers.
  - `sf-impact-from-diff` (committed git history) vs `sf-wip-impact`
    (uncommitted working tree) now state their scope in caps so the
    LLM can't pick the wrong one for "what would this change do."

### Fixed

- **CodeRabbit review feedback on edge-resolution PR** (commit `9ce141e`).
- **Per-call timeouts on every `conn.*` invocation** — every jsforce
  call (`describe`, `query`, `bulkRetrieve`, `metadata.list`,
  `metadata.read`, `tooling.*`) now wraps in a per-call timeout so a
  single hung Salesforce call cannot wedge the ingest. Previously only
  some extractors had this.
- **Vlocity parallel refactor** — Vlocity extractor was serialising
  every datapack-type query; now fans out across types through the
  shared rate-limit pool, matching the rest of the extractor suite.

## 1.1.2 — per-call timeouts, Vlocity parallelism, auto-retry

### Added

- **Auto-retry transient skips when >10 sources skipped** (commit
  `52c5e84`) — when a debug-mode ingest finishes with more than 10
  fail-soft skips, the orchestrator now reruns `--retry-skipped`
  automatically once before reporting. Recovers cleanly from transient
  rate-limit storms that previously required a manual second pass.

### Fixed

- **Per-call timeouts on every `conn.*`** — see 1.1.3 entry; this
  release shipped the first half of the rollout (commit `4da3edb`).
- **Vlocity parallel refactor** — same commit; restored intra-extractor
  parallelism.
- **Publish must go via `pnpm`** (commit `acddbff`) — version-bump
  commit documenting that `npm publish` from inside the workspace
  resolves wrong dependency tree; only `pnpm publish --filter
  @ryanstark24/sfgraph` produces a correct tarball.

## 1.1.1 — README in tarball

### Fixed

- **`README.md` missing from `@ryanstark24/sfgraph` tarball** (commit
  `0ca9c30`) — npm page rendered blank because the published package
  had no README at root. `prepack` / `postpack` scripts now copy the
  monorepo root README into the package on pack and remove it after,
  so the published tarball ships a README without committing a
  duplicate file.

## 1.1.0 — visualiser, ingest hardening, MCP surface fixes

### Fixed

- **Silent process exit during ingest** — the event loop could drain
  mid-run on managed-package-heavy orgs, killing the process with no
  error and no completion log. A keep-alive timer now anchors the loop
  for the lifetime of the ingest.
- **Mass data-wipe risk in `detect-deletions`** — when `bulkRetrieve`
  aborted mid-stream, the deletion pass treated the partial result set
  as authoritative and removed every qname not in it. Now bails out
  unless every source completed cleanly.
- **Signal-handler leak on multi-org ingest in debug mode** — each
  org registered its own SIGINT/SIGTERM handler; running `--all` on a
  large fleet hit Node's MaxListenersExceededWarning. Handlers are now
  registered once per process.
- **MCP server hang on SIGINT** — `shutdown.ts` now force-exits after
  the watchdog timeout rather than waiting forever on stuck handles.
- **EmbeddingQueue concurrent flush race** — two flushes could
  overlap and double-emit vectors for the same node-hash; the flush
  loop is now serialised.
- **Stale `@sfgraph/*` package names in `.changeset/`** — refer to
  current `@ryanstark24/sfgraph-*` names.
- **better-sqlite3 binding auto-rebuilds on Node ABI mismatch** —
  preflight in `apps/sfgraph/bin/sfgraph.mjs` compiles from source on
  ABI mismatch (~20 s first run, instant after).
- **Object-phase chunk barrier replaced with sliding window** — the
  describe fan-out used to wave-bound at chunk boundaries (every
  describe in the chunk had to finish before the next chunk started),
  which serialised slow managed-package SObjects. Replaced with a
  sliding window: 40–60 % faster on managed-package-heavy orgs.

### Changed

- **`start_ingest_job` no longer enqueues** — the MCP server has no
  in-process ingest worker. The tool now returns
  `{ executed: false, run_this_command: "sfgraph ingest --org <alias>" }`
  for the user to run in a shell.
- **`analyze_field` validates inputs** — `object` and `field` must
  match `/^[A-Za-z][A-Za-z0-9_]*(?:__[a-zA-Z])?$/`. Malformed inputs
  are rejected before any graph query.
- **`cross_layer_flow_map` BFS uses a per-node cap (100)** — response
  includes `data.truncated: boolean`; markdown gains a `_truncated_`
  marker when the cap is hit.
- **Source-iterator merge is sliding-window** — replaced wave-bounded
  merger with a sliding window in `bulk-retrieve.ts` (default
  concurrency 12, override `SFGRAPH_SOURCE_CONCURRENCY`).

### Added

- **`sfgraph serve` + `packages/web`** — local 3D web visualiser at
  `http://localhost:7777`. Obsidian-style force-graph with Trace /
  Overview / Schema tabs, `L` / `F` / `Esc` shortcuts, "Render entire
  org" button against `/api/full`. Loopback only by default;
  `--i-understand-public-bind` to expose. EADDRINUSE auto-recovers by
  killing the stale process holding the port.
- **Per-call timeouts on metadata.list / metadata.read** in
  `security.ts`, `flow.ts`, `integration.ts`, and `generic-metadata.ts`
  extractors. A single hung Metadata API call no longer wedges the
  whole ingest.
- **Source-level inactivity safety net in `failSoft`** — sources that
  stop emitting without erroring are now caught and surfaced.
- **WAL checkpoint hygiene during ingest** — periodic
  `wal_checkpoint(TRUNCATE)` keeps the journal bounded on long runs.

## 1.0.2 — graph completeness + ingest performance + macOS stability

### Graph completeness (silent-data-loss fixes)

- **`CustomObject` parser inline-fields path** — live-org ingest builds
  CustomObject XML with **inline `<fields>` elements** sourced from
  `conn.sobject(name).describe()`. The parser previously only handled
  the source-tree layout (separate `*.field-meta.xml` files via
  `input.fields`), so every SObject ingested from a live org produced a
  parent node with **zero CustomField children and zero edges**. Parser
  now walks the inline array and emits `CustomField:<obj>.<field>`
  nodes, `DEFINES_FIELD` edges, and `REFERENCES_OBJECT` edges for every
  `referenceTo` target on the field (lookups, master-detail, polymorphic
  owners). `trace_downstream` on standard objects (Account, Contact,
  Opportunity, …) now returns the full schema neighbourhood.
- **OmniStudio element graph** — `omnistudio.ts` extractor previously
  queried only `SELECT Id, Name, OmniProcessType FROM OmniProcess`, but
  parsers walked `metadata.elements[].propertySet` looking for
  `dataTransformName` / `integrationProcedureKey` / `cardName`. None
  existed on the parent row. New second-pass batches
  `OmniProcessElement` per parent and JSON-parses each row's
  `PropertySet`. Parsers now emit `OMNI_CALLS_DATA_TRANSFORM` /
  `OMNI_EMBEDS_UI_CARD` / `OMNI_CALLS_INTEGRATION_PROCEDURE` /
  `OMNI_INVOKES_REMOTE` edges.
- **Vlocity datapack content** — the vendored `vlocity_build`
  `QueryDefinitions.yaml` selects only `Id, Name, GlobalKey`; never the
  long-text blobs (`Content__c`, `PropertySet__c`, `Definition__c`)
  where the datapack body lives. SOQL is now enriched per-type with
  those columns, namespace-prefixed keys are normalised
  (`vlocity_cmt__Type__c` → `Type`), blobs are JSON-parsed server-side,
  and a second-pass child fetch runs against `Element__c` /
  `DRMapItem__c` for OmniScript / IntegrationProcedure / DataRaptor.
  Parser walks now emit `IP_CALLS_DR` / `OS_USES_DR` / `DR_READS_FIELD` /
  `DR_WRITES_FIELD` / `VC_USES_DR` / `EMBEDS_VC` edges; the Vlocity
  surface was previously a graph of disconnected nodes.
- **Apex `apiVersion` from live ingest** — `ApexClass` / `ApexTrigger`
  Tooling SOQL now selects `ApiVersion` + `Status`. Extractor wraps
  body in a `{body, metaXml}` JSON envelope; adapter unwraps and
  forwards a synthesised `<apiVersion>` meta XML to the parser. Live-
  ingested Apex nodes used to have `apiVersion: null` while filesystem-
  ingested ones had the real value.

### Ingest performance (3–5× on metadata-heavy orgs)

- **Default Metadata pool 3 → 5** — Salesforce Metadata API tolerates
  5–10 concurrent read calls comfortably; 3 left perf on the table.
- **Three new CLI flags / env vars** for pool sizing:
  `--tooling-pool <n>` / `SFGRAPH_TOOLING_POOL`,
  `--metadata-pool <n>` / `SFGRAPH_METADATA_POOL`,
  `--data-pool <n>` / `SFGRAPH_DATA_POOL`. CLI flags win over env vars.
  `configureDefaultPools()` live-mutates the Bottleneck singletons via
  `updateSettings`.
- **Parallel inter-extractor drain** — `mergeAsyncIterablesParallel`
  advances every source iterator concurrently via `Promise.race`.
  Previously serial: while Security ground through Profiles, Apex /
  Vlocity / Data pools sat at 0%. Now all three pools saturate
  simultaneously. Escape hatch: `SFGRAPH_SEQUENTIAL_SOURCES=1`.
- **Parallel intra-extractor batches** — every extractor's
  `metadata.read` calls now fire concurrently through
  `Promise.allSettled` against the rate-limit pool, instead of awaiting
  one batch at a time. Also fixes three pool-routing bugs in
  `security.ts` / `flow.ts` / `integration.ts` (which were using
  `scheduleQuery` / Tooling pool for what are clearly Metadata API
  calls). `object.ts` chunks `describe()` 25-at-a-time through the Data
  pool.
- **`Promise.allSettled` not `Promise.all`** — a rejecting batch no
  longer produces orphan rejections that crash the Node process under
  the default unhandled-rejection policy.

### macOS stability (silent-SIGKILL fix)

- **Auto re-sign all `.node` addons** in postinstall on darwin.
  macOS 26+ rejects "linker-signed adhoc" stamps on `dlopen()` and
  SIGKILLs the process — at kernel level, bypassing every JS handler.
  Postinstall now walks the install tree and re-signs every binding
  with `codesign --force --sign -` (no developer cert needed). Both
  on fresh install and after any rebuild.
- **`sfgraph doctor` macOS code-signing check** — verifies the binding
  signature via `codesign --verify --strict` and flags the brittle
  linker-signed stamp before the next ingest hits it. Emits the exact
  copy-paste `codesign` command in the fix hint.
- **Unhandled rejection + uncaught exception handlers** on the CLI
  entry print loudly instead of letting the process exit silently.

### Diagnostics

- **`sfgraph ingest --debug`** — heartbeat every 10s with heap/RSS/
  last-active source label, per-record parse and graph-merge phase
  logs, SIGTERM/SIGINT stack traces. Names the exact extractor and
  record on any silent exit. Cheap to leave on.
- **Per-record trace** in debug mode logs every `processOne` phase:
  `[trace] parse ←`, `[trace] parse ✓`, `[trace] graph-merge ←`,
  `[trace] graph-merge ✓`. The phase that completes vs. the one that
  doesn't disambiguates JS parser failure from native better-sqlite3
  crash.

## 1.0.1 — security + UX patches (post-v1.0.0)

### Security (audit findings)

- **P0**: read-only Proxy now blocks every top-level Tooling write method —
  `tooling.create`, `tooling.update`, `tooling.delete`, `tooling.executeAnonymous`,
  `tooling.deploy`, `tooling.runTests`, `tooling.request*` — not just
  `tooling.sobject(...)`. 9 new adversarial tests.
- **P1**: path-traversal in MCP org input. New `validateOrgIdentifier`
  rejects `..`, path separators, NUL bytes, Windows reserved names, etc.
  `safeOrgDbPath` containment-checks via `path.resolve` before opening
  any DB. Applied at every entry that builds an org DB path.
- **P1**: cross-org tools (`cross_org_diff`, `deployment_manifest_gen`)
  now correctly open two contexts — one SQLite per org — instead of
  comparing two org IDs inside one DB.
- **P1**: pinned `protobufjs` to `^7.2.5` via `pnpm.overrides` to clear
  the @xenova/transformers → onnxruntime-web → onnx-proto CVE chain.

### Ingest hardening

- **describeGlobal-based object extractor** replaces the EntityDefinition
  + metadata.read path that returned 0 records on Agentforce / scratch
  orgs. Now enumerates every visible SObject via `conn.describeGlobal()`
  and pulls fields via `conn.sobject(name).describe()` — universally
  available, no Metadata API permissions needed.
- **Fail-soft per metadata source**: one extractor failing (e.g.
  INSUFFICIENT_ACCESS on a single type) no longer aborts the run.
  Per-source skip is recorded and surfaced in an end-of-run summary
  bucketed by category (insufficient_access / rate_limit / not_found /
  network / unknown) with a targeted remediation recipe per bucket.
- **Skip report persisted** to `<dataDir>/<orgId>.skips.json` so
  `--retry-skipped` can replay only failed sources on the next run.
- **Per-source progress + 5s heartbeat** during fan-out so long ingests
  show liveness instead of going silent for minutes.

### CLI surface

- `sfgraph ingest --rebuild [--no-backup]` — move existing graph to
  `backups/` and start fresh; forced full sync.
- `sfgraph ingest --detect-deletions` — after a clean full sync, remove
  qnames present in the graph but not touched this run. Bails out on
  parse errors to avoid mass-wipe on transient SF errors.
- `sfgraph ingest --orgs a,b,c` / `--all` / `--parallel` —
  multi-org orchestrator (sequential by default).
- `sfgraph ingest --only <labels>` / `--retry-skipped` — partial refresh
  flows for rate-limit recovery and post-permission backfill.
- `sfgraph ingest --embed-model <path> / --embed-model-id <id> /
  --embed-model-dim <n>` — BYO embedding model (also via
  `SFGRAPH_EMBED_MODEL_PATH/ID/DIM` env vars).
- `sfgraph snapshot {list,create,diff,prune,delete}` — full snapshot
  subcommand the README's Step 5 referenced but wasn't actually wired.
- `sfgraph link --org <alias>` + `sfgraph wip` — WIP local-impact
  workflow for uncommitted sfdx-source changes. Workspace concept stored
  at `~/.sfgraph/workspaces/<projectHash>.json`.
- `sfgraph install --local` — write an MCP entry pointing at the local
  build (`node <absPath> mcp`) instead of npx-ing a not-yet-published
  package. Lets you wire Cursor / Claude / VS Code into a dev checkout.

### MCP tools added

- `list_orgs` — enumerates orgs from sf CLI auth AND local data dir
  (two-pass fallback so an unreachable sf auth context doesn't hide
  ingested graphs).
- `staleness_check` — single-org freshness with the exact CLI command
  to refresh.
- `explain_code` — read a stored code snippet + cache an LLM
  explanation back to the graph (migration v6: `_sfgraph_snippets`).
- `wip_impact` / `wip_diff` / `wip_test_gap` — uncommitted local source
  overlay tools.

### Skills

- `sf-wip-impact`, `sf-schema-overview`, `sf-snapshot-compare`,
  `sf-metadata-refresh`, `sf-explain-code` — 5 new playbooks. Total now 15.
- All existing skills got `## Visualization` and `## Staleness check`
  sections.
- Cursor `.mdc` writer now emits proper Cursor frontmatter
  (`description / globs / alwaysApply`) so rules actually auto-attach
  on Salesforce file patterns instead of just being listed in the UI.

### MCP wiring fixes

- `@salesforce/core` and `better-sqlite3` now declared as direct deps
  on `@ryanstark24/sfgraph-server` so ESM resolution from
  `mcp-server/dist/...` actually finds them. Without this, `list_orgs`
  silently returned empty when invoked from a Cursor child process.
- Auth resolves alias → username via `@salesforce/core`'s
  `StateAggregator` before calling `AuthInfo.create({username})`. Fixes
  `E_SF_AUTH: No authorization information found for <alias>` on orgs
  that ARE registered and connected per `sf org list`.
- Windows: MCP config writer emits `npx.cmd` on win32 + platform-aware
  VS Code path (`%APPDATA%/Code/User/mcp.json`).

### Documentation

- `docs/ARCHITECTURE.md` deep-dive added covering ingestion / embedding
  / DB-loading / parallel-org math / snapshot model / WIP workflow /
  snippet store / Windows.
- README rewritten for npm-page consumption (Python → TS pivot
  disclaimer, design decisions table, initial ingestion walkthrough,
  Windows note, custom-model usage, multi-org refresh).
- `docs/TOOLS.md` covers all 25 tools.
- `docs/SKILLS.md` covers all 15 skills.
- `docs/PRIVACY.md` corrected: machine-id is a random UUIDv4 generated
  only on opt-in (was incorrectly described as a hash of OS user + host).

### Quality

- Test count grew from 298 → 433 (post-1.0.0 patches added ~130 tests
  including the audit-fix suites).
- `pnpm audit` clears all high/critical CVEs; only 2 moderate dev-only
  findings (vitest → vite, esbuild) remain — never ship to users.

## 1.0.0

First general-availability release. The TypeScript engine is now feature-
complete for the v1 charter.

### Phase 0 — Scaffold

- pnpm workspace, 7 packages stubbed.
- TS strict-mode, Biome lint/format, Vitest, GitHub Actions CI.
- Read-only Salesforce connection Proxy.
- Telemetry scaffolding (`NullSink`, `LocalFileSink`, `Sanitizer`) with 50+
  adversarial tests.

### Phase 1 — Storage, snapshots, freshness

- `GraphStore` SQLite impl with composite PK `(org_id, qualified_name)`.
- `VectorStore` via `sqlite-vec` partitioned by `org_id`.
- `SnapshotStore` with copy-on-snapshot tables and 30-day retention.
- Migration registry with pre-migration auto-backup.
- Freshness columns on every node; 50k synthetic-node perf gate.

### Phase 2 — Typed parsers

- Apex (apex-parser), LWC (Babel + parse5), Flow (fast-xml-parser).
- Object/Field + record types + validation rules.
- Vlocity hot-4: DataRaptor, IntegrationProcedure, OmniScript, Card.
- OmniStudio native: OmniProcess, OmniDataTransform, OmniUiCard,
  OmniIntegrationProcedure.
- Security: Profile, PermissionSet, SharingRule.
- Integration: NamedCredential, ExternalServiceRegistration, PlatformEvent.
- Cross-flavor resolver + piscina worker pool.

### Phase 3 — Live sync

- `@salesforce/core` auth, `jsforce` wrapped read-only.
- Capability probe, bulk-retrieve, SourceMember polling.
- `sfgraph ingest --org <alias>` end-to-end.

### Phase 4 — Tools + render + visuals

- 19 MCP tools (impact, trace, cross-org, security, governor, dead-code,
  deployment manifest, snapshot, what-broke, freshness, ...).
- Mermaid render layer with dual `{ summary, markdown, data }` envelope.

### Phase 5 — Skills + installer + binary

- 10 SKILL.md playbooks under `packages/skills`.
- `sfgraph install` writes Cursor / Claude / VS Code MCP config.
- Vendored MiniLM-L6-v2 (Git LFS) + checksum loader.

### Phase 6 — Long-tail parsers, analysis tables, manifest, docs

- 15 long-tail parsers: ApexPage, ApexComponent, FlexiPage, Layout, Report,
  Dashboard, GenAiPlanner, GenAiPlugin, Network, Workflow, ApprovalProcess,
  DuplicateRule, MatchingRule, CustomMetadata, CustomLabels,
  PermissionSetGroup, plus a generic OpaqueNodeParser fallback for the rest
  of the metadata long-tail.
- Schema v5: pre-computed `_sfgraph_findings`, `_sfgraph_dead_code_scores`,
  `_sfgraph_governor_risks`, `_sfgraph_test_coverage` tables.
- `analyze/populate.ts` runs in `liveIngest` to materialize cached analysis.
- `governor_risk_check`, `dead_code_audit`, `security_audit` read cached
  tables when present (< 50 ms hot path).
- `deployment_manifest_gen` emits real package.xml + destructiveChanges.xml
  with API-version fallback and label-aware member formatting.
- Documentation: `TOOLS.md`, `SKILLS.md`, `PRIVACY.md`, root `README.md`.

### Notes

- SQLite divergence: `_sfgraph_findings` PK uses `line` directly (sentinel
  `-1` for "no specific line") instead of `IFNULL(line,0)` because SQLite
  does not permit expressions in PRIMARY KEY declarations.
