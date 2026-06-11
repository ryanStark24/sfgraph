# Design: hybrid search — FTS5 keyword + vector, camelCase tokenization, score threshold

**Status:** proposed (design only — not yet implemented)
**Author:** 2026-06-11, post-Wave-2 re-audit
**Scope:** make `find_similar` / semantic search reliable on Salesforce identifiers by (1) adding a keyword (FTS5) leg fused with the vector leg, (2) splitting camelCase/snake_case so `account` matches `AccountController`, and (3) applying a relevance threshold so weak matches are dropped.

## Problem

`find_similar` is vector-only (MiniLM-L6, 384-dim, cosine via the L2→cosine fix). Three gaps:

1. **No exact-token recall.** A query like `AccountTriggerHandler` or `Customer_Tier__c` should hit the node with that literal token even when the embedding is mediocre. Pure ANN misses exact-name matches that a keyword index would nail.
2. **camelCase/snake_case opacity.** MiniLM tokenizes `AccountController` poorly; a user searching "account controller" or "account" may not rank the class highly. Salesforce identifiers are overwhelmingly camelCase (`getAccountById`) and snake_case (`Customer_Tier__c`), so word-boundary splitting is high-leverage.
3. **No floor on relevance.** Even with correct cosine, KNN always returns *k* results ordered by distance — including near-irrelevant ones at the tail. Users read the bottom rows as "similar" when they aren't. A score threshold turns "k nearest" into "the relevant ones, up to k."

These are **net-new search features**, not bug fixes — sequenced after the correctness waves.

## Current state (grounded in code)

- `packages/core/src/storage/sqlite/vector-store.ts` `searchNodes()` — vec0 KNN (`embedding MATCH ? AND k = ?`), now over-fetches when label-filtered (Wave-C). Returns `{ qname, label, distance }`, no threshold.
- `packages/mcp-server/src/tools/find_similar.ts` — converts L2 distance → cosine (`1 - d²/2`), renders by similarity. No keyword leg, no cutoff.
- `buildEmbedText` (`ingest/live-ingest.ts`) — assembles the text that gets embedded (label + qname + description + config values + now the snippet, Wave-C). This is also the natural source text for an FTS index.
- vec0 tables: `_sfgraph_node_vectors` + `_sfgraph_node_vector_meta(org_id, qualified_name, content_hash, label, vec_rowid)`.

## Design

Three independent, independently-shippable pieces. Recommended order: **2 → 3 → 1** (camelCase is cheap and helps both legs; threshold is cheap and high-value; FTS is the biggest lift).

### Piece 1 — FTS5 keyword leg + hybrid fusion

**Index.** Add an FTS5 virtual table mirroring the embed corpus:

```sql
CREATE VIRTUAL TABLE _sfgraph_node_fts USING fts5(
  qualified_name UNINDEXED,   -- stored for join-back, not searched
  org_id UNINDEXED,
  label UNINDEXED,
  body,                       -- tokenized search text (see Piece 2 for tokenization)
  tokenize = 'unicode61 remove_diacritics 2'
);
```

Populate it from the **same `buildEmbedText` output** in the ingest write path (alongside the vector upsert in `EmbeddingQueue`/`handleParsed`), keyed by `(org_id, qualified_name)`. Dedup/refresh on the same content-hash signal the vectors use, so FTS and vectors stay in lockstep and a deleted node's FTS row is purged in `deleteNode` (extend the existing `DERIVED_QNAME_TABLES` purge + the `deleteNodeVector` path).

**Query — two legs, fused.** Run both:
- **vector leg:** existing `searchNodes` → ranked list with cosine.
- **keyword leg:** `SELECT qualified_name, bm25(_sfgraph_node_fts) AS rank FROM _sfgraph_node_fts WHERE body MATCH ? AND org_id = ? ORDER BY rank LIMIT N`.

Fuse with **Reciprocal Rank Fusion** (robust, scale-free, no tuning of incommensurate score units):

```
RRF(d) = Σ_legs 1 / (K + rank_leg(d))      // K ≈ 60 (standard)
```

RRF avoids the classic mistake of summing a cosine (0–1) and a BM25 (unbounded) directly. Return the top-k by fused rank. A node found by only one leg still ranks; a node found by both rises.

**Why RRF over weighted-sum:** weighted-sum needs per-corpus score normalization and a tuned α; RRF needs only the per-leg ordering and one constant. Easy to ship, easy to reason about. We can revisit weighted-sum later if we want a tunable keyword/semantic dial.

**Fallback:** if the embedder is unavailable (zero-vector / load failure path), the keyword leg alone still answers — strictly better than today's empty result.

### Piece 2 — camelCase / snake_case tokenization

Salesforce identifiers must split into words at index *and* query time so `account` ⇒ `AccountController`, `getAccountById`, `Account.Customer_Tier__c`.

**Approach:** a pure-function `tokenizeIdentifier(s)` that, in addition to keeping the original token, emits word-split variants:
- camelCase / PascalCase boundaries: `AccountController` → `Account Controller`; `getAccountById` → `get Account By Id`.
- snake_case / `__c` / `.` boundaries: `Customer_Tier__c` → `Customer Tier c`; `Account.Name` → `Account Name`.
- keep digits attached (`v2`), lowercase a parallel copy for case-robustness.

Apply it:
- **Index time:** enrich the FTS `body` (and optionally the embed text) with the split words appended to the original, so BM25 matches either form.
- **Query time:** expand the user's query the same way before the `MATCH`.

Keep it a small, well-tested helper (it's the kind of thing with edge cases: consecutive caps `HTTPResponse` → `HTTP Response`, trailing `__c`, numbers). Unit-test those explicitly.

This piece is independently useful: even before FTS lands, folding split words into `buildEmbedText` modestly improves the vector leg's recall on identifier queries.

### Piece 3 — relevance score threshold

Add an optional `minSimilarity` (cosine, 0–1) to `find_similar` and `searchNodes`:
- Default a conservative floor (suggest **0.30–0.35** cosine for MiniLM-L6 on this corpus — empirically the band below which matches read as noise; validate against the PLDT baseline before fixing the number).
- Filter the fused/vector results to `similarity ≥ minSimilarity`, *then* take top-k. So a query with only 2 decent matches returns 2, not 2 good + (k−2) junk.
- Surface it: when results are cut by the threshold, say so ("3 above the 0.30 relevance floor; raise `min_similarity` to see weaker matches"). Never silently return an empty list without telling the user the floor filtered everything.

Threshold is independent of FTS — ship it first; it immediately improves perceived precision.

## Sequencing & cost

| Piece | Lift | Value | Order |
|---|---|---|---|
| 3 — score threshold | XS (filter + param) | High (precision) | 1st |
| 2 — camelCase tokenizer | S (one helper + wire into embed/FTS) | Med–High (recall on identifiers) | 2nd |
| 1 — FTS5 + RRF | M (new table, write-path wire, purge, fusion, tool) | High (exact-name recall, embedder-down fallback) | 3rd |

All three are additive and behind the existing `find_similar` surface; none change stored graph semantics, so **no golden churn**. FTS adds one virtual table + one migration.

## Testing (the recurring lesson)

- `tokenizeIdentifier`: table-driven cases incl. `HTTPResponse`, `Customer_Tier__c`, `Account.Name`, `get2Records`.
- threshold: a query whose 3rd+ neighbours are below the floor returns only the above-floor set; an all-weak query returns empty **with the floor surfaced**.
- FTS leg: an exact-name query that the vector leg ranks poorly is recovered by the keyword leg; RRF ranks a both-legs hit above a single-leg hit.
- write-path parity: a node's FTS row is created/refreshed on the same content-hash signal as its vector, and **purged on delete** (extend the deleteNode/vector purge tests).
- embedder-down: with the zero-vector fallback active, keyword-only results still return.

## Open questions

- **FTS tokenizer choice:** `unicode61` + pre-split words (this design) vs a custom tokenizer extension. Pre-splitting in app code is simpler and portable; revisit only if it underperforms.
- **Default threshold value:** must be calibrated on the PLDT baseline (real distances), not guessed — treat the 0.30–0.35 above as a starting hypothesis, confirm before fixing.
- **RRF K constant:** 60 is the literature default; expose as an internal constant, not a user knob, until there's evidence to tune it.
- **Storage growth:** FTS roughly doubles the text footprint of the embed corpus. Acceptable for a local SQLite graph; note it in `freshness_report`/db-size reporting if we track size.
