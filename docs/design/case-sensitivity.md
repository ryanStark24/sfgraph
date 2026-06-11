# Design: case-insensitive qnames

**Status:** proposed (design only — not yet implemented)
**Author:** 2026-06-11, post-Wave-2 re-audit
**Scope:** how sfgraph should treat Salesforce API-name case so references resolve to definitions regardless of the case they were written in.

## Problem

Salesforce API names are **case-insensitive**: `Account` ≡ `account` ≡ `ACCOUNT` for objects, fields, Apex classes/methods/triggers, Flows, relationship names, and Vlocity/OmniStudio component names. Apex and SOQL are case-insensitive for identifiers; the Metadata API treats developer names case-insensitively.

sfgraph stores qnames (`Label:Name`, e.g. `CustomObject:Account`) as **case-sensitive** strings and uses them as primary keys and for every lookup. Consequences observed:

- A SOQL `[SELECT Id FROM account]` emits `EXECUTES_SOQL → CustomObject:account`, which never matches the `CustomObject:Account` node → the edge is **dangling** and `analyze_field` / `trace_*` miss it.
- `mergeNodes`/`mergeEdges` dedup on the exact qname (PK), so `account` and `Account` become **two rows** instead of one.
- `listDanglingEdges`' JOIN is case-sensitive → false "dangling" reports.
- `find_nodes`, `getNode`, `explain_code` all do exact matches → a user querying the "wrong" case gets nothing.

This is the largest systemic correctness hole left after the two audits: it silently fragments the graph wherever a reference's case differs from its definition's.

## What must stay case-sensitive

Almost nothing in the qname space. The case-insensitive set covers every API-name component of a qname. The genuinely case-sensitive values in Salesforce — **record IDs**, text **external IDs**, field **values** — are never qnames; they live in node `attributes`, which this design does not touch. So we can treat the entire qname namespace as case-insensitive safely.

(One nuance: Vlocity/OmniStudio component *names* are case-insensitive at the API level, but the `cross-flavor-resolver` already lowercases via `normalizeKey()` for matching, so it's unaffected either way.)

## Current surface (grounded in code)

**Construction choke points** — every qname flows through exactly two functions in `packages/core/src/parsers/common.ts`:
- `makeNode(ctx, label, qualifiedName, …)` (passes qname straight to `asQualifiedName()`, no normalization)
- `makeEdge(ctx, src, rel, dst, …)` (same for src/dst)

~26 parser files build the `Label:${name}` strings before calling these; 43 distinct label prefixes.

**Lookup choke points** — `packages/core/src/storage/sqlite/graph-store.ts`, all plain `WHERE … = ?` (SQLite default = case-sensitive):
- `getNode` / `_sfgraph_node_index` lookup
- `listEdgesFrom` (`src_qname = ?`), `listEdgesTo` (`dst_qname = ?`)
- `mergeNodes` dedup (`qualified_name = ?`), `mergeEdges` dedup (PK `(org_id, src_qname, dst_qname)`)
- `listDanglingEdges` JOIN on `qualified_name = dst_qname`

No column uses `COLLATE NOCASE` today. `normalizeKey()` (cross-flavor-resolver) lowercases but is in-memory-match-only, never touches storage.

**Blast radius:** 38 golden fixtures, all asserting original-case qnames (`CustomObject:Account`). Any approach that *changes stored case* regenerates all 38.

## Options

### Option A — `COLLATE NOCASE` at the storage layer (recommended)

Make case-insensitivity a property of the **store**, not the parsers. Define the qname columns and their PKs/indexes with `COLLATE NOCASE` so `=`, PK uniqueness, and JOINs all fold case — while the **stored string keeps its original case** (display stays `CustomObject:Account`).

- **Parsers:** unchanged.
- **Stored values:** unchanged → **zero golden churn.**
- **Dedup:** `account` after `Account` hits the existing row (no duplicate). First-seen case wins the display; add a small refinement (below) so a *definition* node overwrites a *reference*-cased row.
- **Lookups/joins/dangling:** correct automatically.

**Migration mechanics (the real cost).** SQLite can't `ALTER COLUMN … COLLATE`; a column's collation is fixed at table creation. So:
1. Bump `MIGRATIONS` with a step that, for every existing `_sfg_n_<label>` and `_sfg_e_<rel>` table (+ `_sfgraph_node_index`), rebuilds it: `CREATE TABLE …_new (… qualified_name TEXT NOT NULL COLLATE NOCASE, … PRIMARY KEY(org_id, qualified_name))`, `INSERT … SELECT` (collisions that differ only by case collapse — pick the row whose label is a definition, else first), drop old, rename. Edge tables: `src_qname`/`dst_qname` `COLLATE NOCASE`, PK `(org_id, src_qname, dst_qname)`.
2. Update `ensureNodeTable` / `ensureEdgeTable` so *future* dynamically-created tables carry `COLLATE NOCASE` on the qname columns.
3. The migration is the one heavy lift; it's a per-table rebuild but bounded (tens of tables) and one-time.

**Definition-case-wins refinement.** In `mergeNodes`, when an incoming node's label is a *definition* type (`CustomObject`, `CustomField`, `ApexClass`, `ApexTrigger`, `Flow`, …) and the existing row's stored case differs, `UPDATE … SET qualified_name = ?` to adopt the definition's canonical case. References (SOQL-derived) never overwrite. This keeps the displayed qname authoritative regardless of ingest order.

**Caveat:** `COLLATE NOCASE` folds only ASCII A–Z (SF API names are ASCII — fine). It's column-wide, which is exactly what we want here.

### Option B — normalize at construction (`canonicalizeQname` in makeNode/makeEdge)

Lowercase (or PascalCase) the name portion at the two choke points; store the canonical form; keep the original in an attribute (`displayName`).
- **Pro:** explicit, store-agnostic, per-label rules possible.
- **Con:** **regenerates all 38 goldens**; stored qnames become lowercase (`apexclass:accountcontroller`) unless we resolve true PascalCase (which we can't do generically for references); tools must read `displayName` everywhere they show a qname.
- Verdict: more invasive and uglier than A for no extra correctness.

### Option C — normalize at lookup only (`WHERE LOWER(qualified_name)=LOWER(?)`)

- **Pro:** no schema change, no golden churn.
- **Con:** does **not** fix dedup (PK still case-sensitive → duplicates persist); `LOWER()` defeats the index (full scan); must touch every query site. Half-fix.

## Recommendation

**Option A (`COLLATE NOCASE`) + the definition-case-wins refinement.** It fixes all four symptoms (lookup, dedup, join, dangling) at one layer, preserves readable display case, and churns zero goldens. The cost is a single table-rebuild migration + a 2-line change in the two `ensure*Table` helpers.

## Implementation sketch (when built)

1. **Migration** `NN_qname_nocase`: rebuild existing node/edge tables + node index with `COLLATE NOCASE` qname columns; collapse case-duplicates (definition-row wins).
2. **`ensureNodeTable` / `ensureEdgeTable`**: add `COLLATE NOCASE` to qname columns in the `CREATE TABLE` templates.
3. **`mergeNodes`**: definition-label rows adopt their canonical case on conflict.
4. **Tests (the part the audits keep flagging):**
   - `from account` SOQL edge resolves to the `CustomObject:Account` node (no dangling).
   - `mergeNodes([Account]); mergeNodes([account])` → one row, stored case `Account`.
   - reference-first then definition: `account` row's display flips to `Account` when the object is ingested.
   - a record-ID-shaped attribute is untouched (case preserved) — guards against over-folding.
5. **Re-ingest note:** existing graphs get fixed by the migration on next open; a `--rebuild` also works. Document in CHANGELOG.

## Risks / open questions

- **Migration on large graphs**: table rebuilds copy all rows. Bounded (one-time, tens of tables) but should run inside the existing backup-guarded migration runner.
- **Collision resolution order** during the rebuild `INSERT … SELECT`: needs a deterministic "definition beats reference" rule; if two definitions disagree on case (shouldn't happen) pick lexicographically and log.
- **Edge display case**: edge rows may store a reference-cased dst even after the node adopts canonical case. Joins are correct (NOCASE); if we ever surface raw edge qnames we should resolve through the node index. Low priority.
