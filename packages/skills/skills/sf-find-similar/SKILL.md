---
name: sf-find-similar
description: Find Salesforce metadata that is semantically similar to an existing node OR a free-text concept. Two modes — pass a qname to anchor on an existing node (e.g. "show me other Apex methods like BillingSvc.run"), or pass free text to discover code by meaning when no name fits (e.g. "find code that handles order cancellation"). Use when exact-name search misses, when an agent wants to surface near-misses for review, or when the user describes a concept rather than a node. Powered by the MiniLM-L6 embeddings produced during ingest and the `vec0` SQLite KNN index. Filter by label to restrict to one node type. Do NOT use for structural edge traversal — for "what does X call" / "who reads field Y" use trace_downstream / analyze_field, which give exact answers; this skill is for fuzzy / conceptual matches.
triggers:
  - "find similar"
  - "show me code like"
  - "what else is like"
  - "find nodes similar to"
  - "semantically similar"
  - "find code that handles"
  - "where do we"
  - "anything related to"
  - "fuzzy search"
  - "more like this"
tools_used:
  - find_similar
  - explain_code
  - trace_downstream
  - analyze_field
  - staleness_check
---

# sf-find-similar

Use this skill when the user wants discovery rather than exact lookup: *"what other Apex methods are like this one"*, *"find code that handles order cancellation"*, *"is there anything similar to `accountTile`?"*. Powered by the in-process MiniLM-L6 embeddings sfgraph produces during every ingest.

## When to choose this vs. the other tools

| Question shape | Use |
|---|---|
| "What does X call?" / "Who reads field Y?" | `trace_downstream` / `analyze_field` — exact graph edges |
| "Explain method X" | `sf-explain-code` |
| "What else is like X?" / "Find code that does Y" | **`sf-find-similar`** |
| "What changed?" / "What broke?" | `sf-what-broke`, `sf-cross-org-diff`, `sf-impact-from-diff` |

If the user mentions an exact qname *and* asks for relationships, prefer the structural tool. Reach for `find_similar` when names don't match or the user is describing a concept.

## Two modes

### Mode A — anchored on an existing node (`qname`)

```
find_similar(org="my-org", qname="ApexClass:BillingSvc", k=10, label="ApexClass")
```

Use when the user names a node and wants "more like this." Pass `label` when restricting matters (e.g. "other LWCs like accountTile" — set `label="LWC"`).

### Mode B — free-text concept (`text`)

```
find_similar(org="my-org", text="code that computes compliance fees", k=10)
```

Use when the user describes the *what* but not the *which*. The query is embedded on the fly with the same MiniLM-L6 pipeline the ingest uses. Most useful when:

- The user couldn't recall an exact class/method name.
- The concept spans multiple classes — semantic match surfaces them all.
- The user explicitly says "find code that does X" / "where do we Y".

## Playbook

1. **Pick the mode** based on whether the user named a node or described a concept.
2. **`staleness_check`** for the org. If stale, warn — embeddings may not reflect production code.
3. **`find_similar`** with the chosen mode. Use `k=10` by default; raise to 20–30 only if the user asks "more results."
4. **Read the response** — it returns a ranked table of `(qname, label, similarity, distance)`. Similarity is 0–1, higher is closer.
5. **Filter the noise.** Similarity < ~0.4 is usually unrelated text overlap, not real semantic match. Drop those before surfacing to the user unless they explicitly asked for everything.
6. **Offer to drill in.** For each hit the user seems interested in, propose chaining to `sf-explain-code` (what does this one do?) or `trace_downstream` (where does it flow?).

## Visualization

When the result set has 5+ hits, render a horizontal bar chart (Mermaid `xychart-beta`) of similarity scores so the user can eyeball the cluster vs. tail. For ≤4 hits the table alone is fine.

```
xychart-beta
  title "Similarity to BillingSvc"
  x-axis [OrderInvoiceSvc, CreditMemoSvc, TaxCalcSvc, RebateSvc]
  y-axis "similarity" 0 --> 1
  bar [0.82, 0.79, 0.71, 0.55]
```

## Common failure modes & how to handle them

- **`reason: vector_index_unavailable`** — the org's graph was ingested before embeddings were wired up, or the optional `@ryanstark24/sfgraph-models` install was skipped. Tell the user verbatim what the tool's markdown suggests: re-install with `npm install -g @ryanstark24/sfgraph` and re-ingest with `--rebuild`.
- **`reason: no_focal_vector`** (qname mode) — the qname is wrong or its label isn't embedded. Confirm the qname spelling. If correct, suggest re-trying with `text` mode using the user's description of the node.
- **`reason: embedder_unavailable`** (text mode) — the MiniLM runtime isn't present. Fall back to qname mode if the user can name a similar node.
- **`reason: no_neighbours`** — genuinely no similar nodes. Suggest dropping the `label` filter, or running structural `trace_upstream` / `trace_downstream` instead.

## Response shape

- **TL;DR** — "Top N matches for `<focal>`."
- **Ranked table** — qname, label, similarity (3 decimal places), distance.
- **Drop-low note** — if you filtered out scores <0.4, say so: "Skipped 3 results below the 0.4 noise floor."
- **Follow-ups** — propose `explain_code` / `trace_downstream` for the top hit.

## Don't

- Don't claim semantic match implies a structural edge. If the user wants "who actually calls X", route to `trace_upstream`. Similarity ≠ dependency.
- Don't surface scores below ~0.4 unless the user explicitly asked for a wider net. They are usually statistical noise from the embedding space.
- Don't use this for "what changed" / "what broke" questions — those need diff-style tools, not semantic neighbours.
