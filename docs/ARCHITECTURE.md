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
Tooling API pool   →  5 concurrent
Metadata API pool  →  3 concurrent
Data API pool      → 10 concurrent
```

These limits balance against Salesforce's per-org API limits (typically 100k/24h for production, lower for sandboxes). The pools are **per-process**: if you spawn two `sfgraph ingest` processes for two different orgs, each has its own pool and they don't fight over the same Bottleneck queue.

### Phase 5 — Parser routing

Each retrieved member goes through `adaptParserInput()` which maps the SF metadata type to an internal parser type. Three parser flavours coexist:

1. **Code parsers** (Apex class, Apex trigger, LWC bundle) — hand-written TypeScript that uses `apex-parser` / regex / DOM walking.
2. **Declarative YAML rules** — Phase 7 introduced a `RuleBasedParser` that loads YAML rules from `packages/core/src/parsers/rules/`. 21 metadata types now run through this engine; adding a new declarative type is a YAML file, not code.
3. **Generic opaque** — fallback that records the metadata blob as a single node so it appears in the graph even if no parser understands it.

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

Two flavours:

1. **Manual** — operator runs `snapshot_create` before a release.
2. **Auto pre-sync** — `liveIngest` (when given a `snapshotStore`) takes one before each ingest, tagged `is_auto = 1`. This is what `what_broke` uses to compare "before the last sync" vs "now."

Pruning runs at the end of each ingest using `snapshotRetentionDays` (default 30).

### Diff

`diffNodes(orgId, fromId, toId)` joins the two snapshot rowsets on qname and returns `added`, `removed`, and `changed` (rows where `source_hash` differs). `point_in_time_diff` and `cross_org_diff` are both thin wrappers over this.

## 6. Parallel-org ingest math

- **Per-process pools.** Bottleneck pools live in module scope inside each Node process. Two ingests in the same process share the same pools and the same per-org-API budget.
- **Across processes.** If you `sfgraph ingest --org A &` and `sfgraph ingest --org B &` (different orgs), each process has its own pools. Salesforce's per-org limits are separate too, so this scales linearly until you hit your machine's CPU or your network's bandwidth.
- **Same-org parallel is disallowed.** Two processes for the same org will fight over the SQLite write lock and waste the API budget. Don't do it.
- **Throughput.** A representative production org (~80k metadata members) full-ingests in ~3-5 minutes on a 16-thread laptop on a fast connection. Incremental ingest after that is seconds.

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
