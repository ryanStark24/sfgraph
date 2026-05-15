# sfgraph Architecture

This document is the technical deep-dive. The README is for "how do I use this"; this is for "what is it doing under the hood and why."

## 1. Storage model

sfgraph stores everything in a per-org SQLite file under `~/.sfgraph/data/<alias>.sqlite`. The schema is **dynamically extended at ingest time** — labels and edge types each get their own physical table, created on first use.

### Per-label tables

When the ingester first encounters a new node label (e.g. `ApexClass`, `CustomField`, `Flow`), the graph store calls `ensureNodeTable(label)` which:

1. Names the physical table via a deterministic transform (`node_apexclass`, `node_customfield`, …)
2. Creates the table with `CREATE TABLE IF NOT EXISTS` and a composite PK `(org_id, qualified_name)`
3. Records the label-to-table mapping in `_sfgraph_node_labels` so subsequent lookups skip the DDL path

Edge tables work the same way (`edge_calls`, `edge_reads_field`, …), with a reverse-edge index `(org_id, dst_qname)` on every edge table so `listEdgesTo` is O(log n) instead of O(table_scan).

### Why per-label, not one big `nodes` table

- **Index selectivity.** A query like "list every `ApexMethod` for this org" is a single-table scan instead of a where-filter over millions of rows.
- **Schema evolution.** Adding label-specific columns (e.g. denormalised counters) is local to that label.
- **Storage locality.** Per-table B-trees compact better when the rows are homogeneous.

### Vector tables (sqlite-vec, migration v3)

`_sfgraph_node_vectors` and `_sfgraph_bundle_vectors` are `vec0` virtual tables **partitioned by `org_id`**. This means KNN queries against your prod org never scan your sandbox embeddings — sqlite-vec prunes the partition before the distance scan. The companion meta tables (`_sfgraph_node_vector_meta`, `_sfgraph_bundle_vector_meta`) store `content_hash` so a re-ingest with no change short-circuits the embedding step entirely.

### Snippet table (migration v6)

`_sfgraph_snippets` is a focused table for source-text stored by code parsers, keyed on `(org_id, qualified_name)`. Holding source text in `node.attributes` would force JSON serialize/deserialize on every read of a label table — moving it to its own table keeps the per-label tables lean and makes "give me the text for this qname" a single-row primary-key lookup.

The schema:

```sql
CREATE TABLE _sfgraph_snippets (
  org_id TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  source_format TEXT NOT NULL,        -- 'apex' | 'js' | 'html' | 'xml' | 'json' | 'flow' | 'soql'
  source_text TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  source_hash TEXT NOT NULL,          -- sha256 of source_text — drives the unchanged short-circuit
  llm_explanation TEXT,               -- nullable; populated lazily by explain_code
  explained_at INTEGER,               -- epoch ms; nullable
  PRIMARY KEY (org_id, qualified_name)
);
```

`upsertSnippet()` compares the incoming `source_hash` against the stored one and returns `unchanged: true` with no write when they match — same content-hash short-circuit pattern as `mergeNodes`.

### Migration registry

`packages/core/src/storage/sqlite/migrations.ts` exports `MIGRATIONS: Migration[]`. Each migration has an integer `version` and an `up(db)` callback. The `MigrationRunner` sorts by version, applies any newer than the recorded `MAX(version)` in `_sfgraph_schema_version`, and **takes a `VACUUM INTO` backup before each step** (when there is prior state worth preserving). Backups roll under `~/.sfgraph/data/.sfgraph-backups/` with a configurable retention.

## 2. Ingestion strategy

`sfgraph ingest --org <alias>` runs the pipeline in `packages/core/src/ingest/live-ingest.ts`. The pipeline is the same whether you invoke it from the CLI or via the `start_ingest_job` MCP tool.

### Phase 1 — Auth and read-only proxy

The CLI delegates to `@salesforce/core` to resolve the alias to a `jsforce` Connection. The first thing `liveIngest` does is wrap that Connection in `wrapConnectionReadOnly()` — a `Proxy` that throws `ReadOnlyViolationError` synchronously on any mutating method (`create`, `update`, `delete`, `upsert`, `deploy`, …). This is verified by ~40 adversarial tests; nothing inside sfgraph can write to Salesforce even by accident.

### Phase 2 — Capability probe

`probeCapabilities(conn)` checks for:

- Source Tracking (decides full vs incremental)
- Vlocity CMT — probes **all five** historical Vlocity namespaces (`vlocity_cmt`, `vlocity_ins`, `vlocity_ps`, `vlocity_uki`, `vlocity_emo`) so we work across CME, Insurance, Public Sector, and the regional variants
- OmniStudio (managed and native, post-merge)
- Tooling API access (some scratch orgs disable bits of it)

This decides which extractors will run and which Bottleneck pool budgets to load.

### Phase 3 — `describeMetadata()` dispatch

The Metadata API's `describeMetadata()` returns the canonical list of metadata types available **for that org's API version**. sfgraph uses this as the source of truth for what to retrieve — it does not hard-code a type list. This means a new Salesforce metadata type appears automatically the first time the org's API version supports it.

### Phase 4 — Three Bottleneck pools

```
Tooling API pool   →  5 concurrent  (default; --tooling-pool / SFGRAPH_TOOLING_POOL)
Metadata API pool  →  5 concurrent  (default; --metadata-pool / SFGRAPH_METADATA_POOL)
Data API pool      → 10 concurrent  (default; --data-pool / SFGRAPH_DATA_POOL)
```

These limits balance against Salesforce's per-org API limits (typically 100k/24h for production, lower for sandboxes). The pools are **per-process**: if you spawn two `sfgraph ingest` processes for two different orgs, each has its own pool and they don't fight over the same Bottleneck queue.

**Pool routing fix (1.0.2).** `security.ts`, `flow.ts`, and `integration.ts` used to route `metadata.list` / `metadata.read` through `scheduleQuery` (the Tooling pool) — which made `--metadata-pool` a no-op for the three slowest extractors and put their calls on the wrong budget. All Metadata API calls now correctly use `scheduleMetadata`.

**Two layers of parallelism.** Beyond per-pool concurrency, sfgraph drains source iterators in parallel via `mergeAsyncIterablesParallel` (so all three pools saturate simultaneously instead of one extractor at a time), and within each extractor every batch is fired through `Promise.allSettled` against the pool (so the pool's 5-wide budget is actually utilised instead of awaiting one batch at a time). Escape hatch for the inter-source parallelism: `SFGRAPH_SEQUENTIAL_SOURCES=1`. Inner-batch parallelism is unconditional.

**Why `allSettled`, not `all`.** A rejecting batch under `Promise.all` produces orphan rejections from the still-in-flight peers — Node 24+ terminates the process on those by default, which manifested as silent ingest deaths between log lines. `allSettled` isolates each batch and continues regardless.

### Phase 5 — Parser routing

Each retrieved member goes through `adaptParserInput()` which maps the SF metadata type to an internal parser type. Three parser flavours coexist:

1. **Code parsers** (Apex class, Apex trigger, LWC bundle) — hand-written TypeScript that uses `apex-parser` / regex / DOM walking.
2. **Declarative YAML rules** — Phase 7 introduced a `RuleBasedParser` that loads YAML rules from `packages/core/src/parsers/rules/`. 21 metadata types now run through this engine; adding a new declarative type is a YAML file, not code.
3. **Generic opaque** — fallback that records the metadata blob as a single node so it appears in the graph even if no parser understands it.

### CustomObject extractor — describeGlobal-based

The object extractor lives at `packages/core/src/extractors/live-org/extractors/object.ts`. It originally used Tooling SOQL on `EntityDefinition` + `metadata.read('CustomObject', ...)`, which silently returned 0 records on Agentforce, scratch, and certain dev orgs even for admin users. Post-1.0.0 it was rewritten:

1. `conn.describeGlobal()` enumerates every SObject visible to the user — universally available, no Metadata API permissions required.
2. Skip patterns filter out audit/junk tables (`__History`, `__Tag`, `__Feed`, `__Share`, `__ChangeEvent`, `__b`).
3. For each remaining SObject: `conn.sobject(name).describe()` returns the full field map (type, label, length, references, formula, picklists).
4. The CustomObject parser receives a JSON envelope that matches what the metadata.read path used to return, so the rest of the pipeline is unchanged.

Per-object describe is wrapped in try/catch so one entity failing doesn't kill the rest. Describes also fan out in chunks of 25 through the Data pool so the 200+ SObject case (~500ms latency each) finishes in ~10s instead of ~100s.

**Inline-fields parser path (1.0.2).** The live extractor builds CustomObject XML with inline `<fields>` elements (one per field, sourced from describe). The parser used to iterate only `input.fields` — the `Record<string, string>` populated solely by the filesystem extractor — and silently dropped the inline array. That meant every standard SObject ingested from a live org became a single node with zero edges. The parser now also walks inline `<fields>` and emits `CustomField:<obj>.<field>` nodes, `DEFINES_FIELD` edges, and `REFERENCES_OBJECT` edges for each `referenceTo` target (lookups, master-detail, polymorphic owners). A dedup set prevents double-emission when source-tree projects ship both inline and separate-file fields.

### Fail-soft per source + end-of-run skip summary

Every source iterable in `bulkRetrieve` is wrapped by `failSoft(label, factory, onError)`. If a source throws (INSUFFICIENT_ACCESS, REQUEST_LIMIT_EXCEEDED, network blip, anything), the error is captured into a shared `IngestSkipReport`, a compact `✗ skipped` line prints, and other sources continue.

At end of ingest, `printSkipSummary` groups skips by category (`insufficient_access`, `not_found`, `rate_limit`, `network`, `unknown`) and prints a targeted remediation paragraph per category. The report is also persisted to `<dataDir>/<orgId>.skips.json` so `sfgraph ingest --retry-skipped` can replay only the failed sources without a full rebuild.

### Phase 6 — Merge with content-hash short-circuit

`graphStore.mergeNodes()` is the hot path. For every incoming node:

- If no row exists → INSERT, `inserted += 1`
- If existing `source_hash` matches → UPDATE only `last_seen_at`, `unchanged += 1` (the row's `attributes` are not re-serialised)
- If `source_hash` differs → full UPDATE, `updated += 1`

This is the reason re-ingesting a quiet org takes seconds: the vast majority of rows hit the `unchanged` path.

## 3. Embedding strategy

Embeddings are side-streamed out of the ingest pipeline through an `EmbeddingQueue` (`packages/core/src/embedding/`). When `liveIngest` receives parsed nodes, it pushes a small text representation (`label: qname\n<description>`) into the queue. The queue:

1. Batches items in groups of **16** before invoking the model
2. Runs **all-MiniLM-L6-v2** via `@xenova/transformers` in WASM — fully local, zero network
3. Loads the vendored quantized ONNX model from `packages/models/models/` (vendored via Git LFS to keep the npm package small)
4. Pushes the resulting 384-dim Float32Array into `_sfgraph_node_vectors`
5. Stores the content-hash in `_sfgraph_node_vector_meta` so subsequent ingests of unchanged nodes never re-embed

### Custom model override

Operators can substitute their own model:

- CLI: `sfgraph ingest --embed-model /path/to/model.onnx`
- Env: `SFGRAPH_EMBED_MODEL=/path/to/model.onnx`

As long as the model produces 384-dim vectors, the vec0 table accepts it. For different dimensions, the schema would need a migration — out of scope.

### Lazy load

The model is loaded **on first embed**, not at startup. Operators who only run snapshot diffs never pay the model-load cost.

### vec0 partition-pruned KNN

`searchNodes(orgId, query, k)` sends `WHERE org_id = ?` into the vec0 query. sqlite-vec uses the partition key to skip every row not in the requested org before running distance. With 6 orgs and 50k nodes each, this is ~10x faster than a non-partitioned KNN.

## 4. Loading into the DB

### SQLite pragmas at open

```ts
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;        // 256 MiB
PRAGMA cache_size = -200000;         // 200 MiB cache
```

WAL keeps writers from blocking readers (the MCP server can serve `analyze_field` while ingest is running). `mmap_size` lets SQLite zero-copy-read a large chunk of the DB, which dominates the cost of full-graph scans like `dead_code_audit`.

### Lazy `CREATE TABLE` pattern

As mentioned above, label/edge tables are created on demand. The first ingest of a fresh org cascades the creates inside its transactions; subsequent ingests find the tables in `_sfgraph_node_labels` and skip the DDL.

### Pre-migration backup + retention

Every schema migration triggers a `VACUUM INTO` backup of the prior-version DB. Backups land in `~/.sfgraph/data/.sfgraph-backups/`. Default retention is 5 backups per DB; oldest are pruned on each new migration. This is the simplest possible "I want my old graph back" insurance.

## 5. Snapshot + diff model

### Copy-on-snapshot

`snapshot_create` performs an `INSERT ... SELECT` of every node and edge for the org into `_sfgraph_node_snapshots` and `_sfgraph_edge_snapshots`, tagged with the snapshot id. This is O(graph size) in I/O but only happens on the explicit operator action.

### Point-in-time and `is_auto` snapshots

Three flavours:

1. **Auto pre-sync** — `liveIngest` (when given a `snapshotStore`) takes one before each ingest, tagged `is_auto = 1`. This is what `what_broke` uses to compare "before the last sync" vs "now."
2. **Manual** — operator runs `sfgraph snapshot create --label X` (or the `snapshot_create` MCP tool) before a release.
3. **Scheduled** — user-driven: `sfgraph snapshot create --kind scheduled --label nightly-2026-01-15` from cron / GitHub Actions / etc. The `kind` is encoded as a `manual:` / `scheduled:` prefix in the stored label so they're distinguishable from auto-snapshots in `snapshot list`.

Only auto-snapshots are subject to retention. The CLI `sfgraph snapshot prune --retain-days <n>` and the implicit prune at the end of each ingest (default 30 days) both leave manual and scheduled snapshots untouched. Delete those explicitly with `sfgraph snapshot delete <id>`.

### Diff

`diffNodes(orgId, fromId, toId)` joins the two snapshot rowsets on qname and returns `added`, `removed`, and `changed` (rows where `source_hash` differs). `point_in_time_diff` and `cross_org_diff` are both thin wrappers over this.

## 6. Multi-org ingest model

### Sequential vs parallel

`sfgraph ingest --orgs a,b,c` (or `--all`) walks the list and calls `liveIngest` per alias. Sequential by default; `--parallel` fans the orgs out via `Promise.allSettled` so one alias's failure (auth error, mid-run API blip) doesn't abort the others. At the end the CLI prints a per-org results table and exits non-zero if any entry failed.

Each org has its own `SqliteGraphStore` / `SqliteSnapshotStore` instance — they don't share file handles. SQLite WAL handles concurrent writes to *different* files fine. Same-org parallel is still disallowed (two processes/threads hitting one file = lock contention).

### Per-org pool tradeoffs

- **Per-process pools.** Bottleneck pools live in module scope inside each Node process. Two ingests in the same process share the same pools and the same per-org-API budget.
- **Across processes.** If you spawn separate `sfgraph ingest --org A` and `sfgraph ingest --org B` processes, each has its own pools and Salesforce's per-org limits are separate too, so this scales linearly until you hit your machine's CPU or your network's bandwidth.
- **In-process `--parallel`.** Currently shares the default pools across orgs. Bottleneck handles concurrent `schedule()` calls safely; the conservative budget (5 Tooling / 3 Metadata / 10 Data concurrent) keeps total usage well under per-token SF limits even when several orgs are firing through it. For the spec, the priority was keeping the rate-limit refactor minimal — `createRateLimitPools()` is exported as a public factory so future work can thread per-org pools through `LiveIngestOpts.pools` without breaking the orchestrator's public surface.
- **Same-org parallel is disallowed.** Two processes for the same org will fight over the SQLite write lock and waste the API budget. Don't do it.
- **Throughput.** A representative production org (~80k metadata members) full-ingests in ~3-5 minutes on a 16-thread laptop on a fast connection. Incremental ingest after that is seconds.

## 6a. Full rebuild semantics

`sfgraph ingest --rebuild` is the "throw it all away" escape hatch. It:

1. Moves the existing per-org SQLite file to `<sfgraph-data>/backups/<orgId>.rebuild-<ISO>.sqlite` (or deletes it outright with `--no-backup`).
2. Opens a fresh DB at the original path and applies all migrations.
3. Forces `mode='full'` regardless of Source Tracking state.

Use it when:
- Parser logic has changed and you want a clean reparse rather than relying on incremental
- The graph has drifted from reality (deletions on a non-source-tracked org, partially-completed prior sync)
- A schema migration backup is from a known-bad state

The backup is intentionally a plain `.sqlite` file with a timestamp — to restore, stop sfgraph and rename it back.

## 6b. Deletion detection

Two complementary paths cover deletions:

- **Incremental (SourceMember).** `iterChanges()` polls the Tooling `SourceMember` table since the last sync. Rows where `IsNameObsolete = true` surface with `MemberRef.obsolete = true`; `liveIngest` calls `graph.deleteEdgesFor(qname)` and `graph.deleteNode(qname)` directly. Only available on Source-Tracking-enabled orgs (sandboxes, scratch orgs).

- **Full sync (`--detect-deletions`).** Production orgs without Source Tracking have no SourceMember table. After a full sync, the orchestrator collects the set of qnames touched during the run (every `parsed.nodes` entry) and reads the set of qnames already persisted via `graphStore.listAllQnames(orgId)`. The set difference is the deletion candidate list. Two safety bars:
  - Run with `parseErrors > 0` → bail out, delete nothing. A transient SF API error during apex retrieval should not wipe the apex layer.
  - Deletion is per-node-and-edges (same code path as incremental). No bulk truncate.

`--detect-deletions` is off by default — opt-in with the flag, or pair with `--rebuild` for the cleanest possible state.

## 7. WIP local-impact

`wip_impact` / `wip_diff` / `wip_test_gap` run against a **workspace overlay** — a transient view of the graph that layers your local working-tree changes on top of the ingested baseline. The `FilesystemMetadataSource` reads your sfdx-project source folder, parses with the same parsers used in live ingest, and produces a transient `(nodes, edges)` set that's joined with the persistent graph at query time. No writes hit the persistent store.

This lets developers ask "what does this WIP touch?" before they even commit, without polluting the production graph.

## 8. Snippet store + LLM annotation

The snippet table introduced in migration v6 is fed by code parsers' `ParseResult.snippets?` side-output. Today the Apex class parser emits one snippet per `ApexMethod` qname containing the raw method body and computed start/end lines. The snippet store is content-hash short-circuited just like nodes — re-ingest of unchanged source touches no rows.

The `explain_code` MCP tool reads from this table and exposes two modes:

1. **Read** — returns the source text in a fenced code block plus any prior cached explanation. The agent uses this to generate an explanation in its own response.
2. **Annotate** — when called with `annotation=<text>`, persists that text via `updateSnippetExplanation()`. The next read returns it instantly.

`listSnippetsMissingExplanation(orgId, limit)` is provided so a background worker can lazily pre-warm explanations across the org.

The `sf-explain-code` skill drives the loop: resolve qname → staleness_check → explain_code (read) → generate annotated explanation → explain_code (write annotation).

## 9. Windows support

sfgraph runs on Windows under Node 20+. The install path writes `npx.cmd` (not `npx`) into the MCP host configuration so Claude Code / Cursor on Windows invoke the right binary. Paths in the config files use forward slashes, which both Node and the host IDEs handle on Windows.

Caveats:
- `~` expansion is done by sfgraph's `getSfgraphPaths()`; the host IDE never sees a tilde.
- Git LFS must be installed before `npm install` so the vendored model resolves correctly.
