# Architecture Research

**Domain:** Salesforce metadata graph + analysis toolkit (sfgraph fork hardening + capability expansion)
**Researched:** 2026-05-17
**Confidence:** HIGH (every claim below is grounded in a re-read of the actual source — file:line citations are verified, not inferred)

## Standard Architecture

### System Overview (as it exists today — additions called out by `[+Wx-yy]`)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            MCP SERVER (26 tools)                              │
│   {summary, markdown, data, follow_up_tools} response shape — public API     │
│   [+W3-02 export_sarif tool]   [+W3-04 find_nodes (glob)]                    │
│   [+W3-03 package.xml wired as follow_up_tool on impact-flavored tools]      │
├──────────────────────────────────────────────────────────────────────────────┤
│                          INGEST ORCHESTRATOR                                  │
│                  packages/core/src/ingest/live-ingest.ts                      │
│                                                                               │
│   Stage 1: Extract (live-org/) — async-iterator merge, 12 in-flight          │
│     ├── vlocity/runner.ts (silent catch @ 76/188/246  ← W1-01)               │
│     ├── [+W2-02] omnistudio-retrieve.ts (capability-gated)                   │
│     ├── [+W2-03] mcd-baseline.ts (Layouts/FieldSets/EmailTemplates/Tabs)     │
│     ├── [+W2-05] tryWithSmallerQueries auto-rebatcher (414/431/>300 IDs)     │
│     └── [+W2-06] composite-subrequest batching of 25 for metadata.read       │
│                                                                               │
│   Stage 2: Parse (parsers/) — emits NodeFact + EdgeFact                      │
│     ├── apex/        (visitor.ts, arity-resolver.ts  ← W1-04, W1-05)         │
│     ├── lwc/         (html-visitor.ts:no lwc:if/for  ← W1-03)                │
│     ├── flow/        (fast-xml-parser)                                       │
│     ├── vlocity/     (DR / IP / OS / VC JSON parsers)                        │
│     └── common.ts    makeEdge() — drops sourceUri today  ← W1-02 surface     │
│                                                                               │
│   Stage 3: Merge — graph.mergeNodes/mergeEdges into SQLite                   │
│     [+W2-03 merge rule: parsed wins over source:'mcd' on overlap]            │
│     [+W3-05 ElemID rename: rewrite edges instead of delete+add]              │
│                                                                               │
│   Stage 4: Post-merge resolver passes (live-ingest.ts:698–783)               │
│     Each pass: independent try/catch, NO global transaction (intentional)    │
│     ├── resolveCrossFlavor          (cross-flavor-resolver.ts)               │
│     ├── resolveFlowApexMethods                                                │
│     ├── resolveApexMethodArity                                                │
│     ├── auditDanglingEdges                                                    │
│     └── [+W2-01 detectOmniStudioOverlap  ← NEW 5th pass]                     │
├──────────────────────────────────────────────────────────────────────────────┤
│                              STORAGE LAYER                                    │
│   better-sqlite3 (per-org @ env-paths) + sqlite-vec (384-dim MiniLM)         │
│   GraphStore.transaction() wraps batched merges (per-pass, not global)       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | Implementation file |
|-----------|----------------|---------------------|
| `live-ingest.ts` | Orchestrate extract → parse → merge → resolve. Per-pass try/catch isolation. | `packages/core/src/ingest/live-ingest.ts` |
| `EdgeFact` / `NodeFact` | Canonical fact shape persisted to SQLite. Edge has no source location today. | `packages/core/src/domain/edge-fact.ts` |
| `makeEdge()` / `makeNode()` | Constructors fed by every parser. `makeNode` already injects `ctx.sourceUri`; `makeEdge` discards it. | `packages/core/src/parsers/common.ts:30` |
| `ParseContext` | Carries `sourceUri` (already typed at `contract.ts:7`) through parse traversal. | `packages/core/src/parsers/contract.ts` |
| `vlocity/runner.ts` | Async generator yielding `RawMember` per Vlocity DataPack. Three silent `catch` sites (76, 188, 246). | `packages/core/src/extractors/live-org/vlocity/runner.ts` |
| `cross-flavor-resolver.ts` | Reference shape for post-merge passes: `(store, opts) → count`, wraps work in `store.transaction()`, idempotent merges. | `packages/core/src/parsers/cross-flavor-resolver.ts` |
| `parsers/lwc/html-visitor.ts` | parse5-based HTML traversal. Currently does NOT branch on `lwc:if/elseif/else/for:each` (verified by grep — zero matches). | `packages/core/src/parsers/lwc/html-visitor.ts` |
| `parsers/apex/arity-resolver.ts` | Post-merge arity reconciliation for ambiguous Apex method edges. | `packages/core/src/parsers/apex/arity-resolver.ts` |

## Wave Integration Points (verified against the actual code)

Each Wave item below names the exact integration target. **All line numbers were re-read at research time, not guessed.**

### Wave 1 — In-place fixes

| Item | File | Line(s) | Integration |
|------|------|---------|-------------|
| **W1-01** silent catch fix | `extractors/live-org/vlocity/runner.ts` | 76, 188, 246 | Replace `catch { … }` with `catch (e) { warnings.push({source, vdpType, namespace, err: (e as Error).message}); logger.warn(…) }`. Plumb a `warnings: string[]` array down `runTask` / `fetchChildrenByParent`, return it via the async-iterator (or via a shared module-level sink wired to `LiveIngestResult.warnings`). Note line 76 is a *JSON parse* swallow inside `tryParseJsonField` — keep `_raw` semantics but log. |
| **W1-02** edge provenance | `parsers/common.ts:30` (`makeEdge`) → `domain/edge-fact.ts` | n/a | Extend `EdgeFact` with optional `sourceUri?: string; line?: number; column?: number`. Change `makeEdge` to accept `loc?: {line, column}` and write `{ …attributes, sourceUri: ctx.sourceUri, line: loc?.line, column: loc?.column }`. **This is a shared-interface change touched by every parser** — keep fields optional so existing call sites keep compiling; back-fill `loc` parser-by-parser. |
| **W1-03** LWC directives | `parsers/lwc/html-visitor.ts` | (whole file — 136 LOC, no `lwc:` directive handling) | Add an attribute-pass step inside the parse5 visitor: when an element carries `lwc:if|elseif|else|for:each`, parse the expression value, walk identifier references, emit USES edges with `{insideConditional: true, directive: 'lwc:if'}` attribute so callers can filter. |
| **W1-04** arity resolver | `parsers/apex/arity-resolver.ts` | (174 LOC) | Tighten the matcher: today it resolves on `(name, arity)`; extend to `(name, arity, argTypes[])` where call-site args are typed locals or literals. Where types are unknown, emit `attributes.ambiguous: true` (already a precedent in the existing return shape `{scanned, resolved, ambiguous, unresolved, edgesEmitted}` at `live-ingest.ts:755-761`). |
| **W1-05** IS_TEST attribute | `parsers/apex/class.ts` (annotation extraction site) | n/a | Detect `@isTest` on class/method during AST walk; set `attributes.isTest = true` on the `NodeFact`. Do NOT key on filename — filename is a heuristic that breaks for inline test methods. |
| **W1-06** README correction | `README.md` + marketing copy | n/a | Pure docs — no code path. |

### Wave 2 — Capability gaps

| Item | File / new file | Slot-in point | Integration |
|------|-----------------|---------------|-------------|
| **W2-01** overlap detector | NEW: `parsers/omnistudio/overlap-detector.ts` | `live-ingest.ts:713` (next to `resolveCrossFlavor` block 713–728) | Copy the `cross-flavor-resolver.ts` shape: `detectOmniStudioOverlap(store, {orgId, ctx}): { overlapEdges: number, signatures: …}`. Wrap work in `store.transaction()`. Add `disableOverlapDetect?: boolean` to the opts type alongside the existing `disableCrossFlavor / disableFlowInvocableResolve / disableArityResolve / disableAudit` flags. Surface `overlapEdges` on `LiveIngestResult` next to `crossFlavorEdges`. **Hard dependency on W1-02** — overlap detector's value is reporting *where* mismatched signatures live; without `sourceUri/line/column` on edges, reports cite qualifiedName only. |
| **W2-02** OmniStudio retrieve() | NEW: `extractors/live-org/extractors/omnistudio-retrieve.ts` | Wire into `live-ingest.ts` extractor merge alongside the existing Vlocity runner; capability-gate on the same `caps` shape used by `iterVlocityRecords` (caps argument, e.g. `caps.hasOmniStudioOnCore`). | Falls back to existing SOQL path when capability absent. Preserves XML envelope for design-time fields invisible to SOQL. **No public-API churn** — emits the same `RawMember` shape the merge stage already consumes. |
| **W2-03** MCD fast-path | NEW: `extractors/live-org/extractors/mcd-baseline.ts` | New extractor in the async-iterator merge. | Tag nodes/edges with `attributes.source: 'mcd' \| 'parsed'`. Merge rule lives in the GraphStore merge path: on overlap-by-`(orgId, qualifiedName)`, prefer `source === 'parsed'`. Implementation note: simplest is to filter in `mergeNodes()` itself OR have the MCD extractor write first and let parsed merges overwrite via the existing idempotent upsert. Pick the latter to keep merge semantics unchanged. |
| **W2-04** Happy Soup gap-fills | NEW: `parsers/mcd-gap-fills/{lookup,valueSet,picklist}.ts` | Either inside the MCD baseline extractor (W2-03) or as a post-merge pass like `resolveCrossFlavor`. | Post-merge pass is cleaner because the heuristics need the graph in place to query for source/target Field nodes. **Re-implement from documented behavior — do NOT copy AGPL-3.0 source.** |
| **W2-05** auto-rebatcher | `extractors/live-org/*` shared HTTP helper | Wraps existing Tooling SOQL call sites | New `tryWithSmallerQueries(fn, ids[])` helper that catches HTTP 414/431 and `>300` IN-clause IDs, bisects, recurses. Drop-in replacement for current direct call. |
| **W2-06** composite batching | `extractors/live-org/metadata-read.ts` (or wherever `metadata.read` is dispatched) | Before the existing adaptive bisection (`MAX_BISECT_DEPTH=6`) kicks in. | Composite-subrequest of 25 — bisection only fires on a composite failure, not on every call. |

### Wave 3 — Distribution + interop

| Item | File / new file | Integration |
|------|-----------------|-------------|
| **W3-01** PMD-aligned YAML schema | `rules/*.yaml` (21 files) + the rule loader | Field rename across all 21 YAMLs: `name / message / description / priority / externalInfoUrl / properties / example`. Bump rule-loader schema; keep backward-compat alias read for one cycle. **Must land before W3-02** — SARIF emitter expects the new field names. |
| **W3-02** SARIF emitter | NEW: `render/sarif.ts` + new MCP tool `export_sarif` in `packages/mcp-server` | Co-locate with other `render/` renderers; depends on PMD-shaped rules (W3-01). New MCP tool follows the standard `{summary, markdown, data, follow_up_tools}` envelope; `data` carries the SARIF 2.1.0 doc. **Depends on W1-02** to populate `result.locations[].physicalLocation` from edge `sourceUri/line/column`. |
| **W3-03** package.xml as follow_up | `packages/mcp-server` tool definitions | Verify the existing `package_xml` (or equivalent) generator works; wire it into the `follow_up_tools` array on every impact-flavored tool. Pure config plumbing — no architectural change. |
| **W3-04** glob selectors | NEW: MCP tool `find_nodes` in `packages/mcp-server` + selector parser in `packages/core/src/query/` | Translates `apex.Class.Foo.*` / `salesforce.Flow.instance.Lead_*` into a SQL `LIKE` against `qualifiedName`. Read-only; no ingest changes. |
| **W3-05** ElemID rename stability | Storage layer (`storage/sqlite`) + ingest merge step | Persist `(orgId, serviceId) → qualifiedName` map (new table `node_identity`). During merge, if a `serviceId` appears with a new `qualifiedName`, UPDATE edges' `srcQualifiedName/dstQualifiedName` instead of `DELETE` + insert. Touches every edge write path — coordinate with the existing source-member sync logic so the rename is single-source-of-truth. |

## Recommended Project Structure (deltas only — repo layout is fixed)

```
packages/core/src/
├── domain/
│   └── edge-fact.ts                              # W1-02: +sourceUri/line/column (optional fields)
├── parsers/
│   ├── common.ts                                 # W1-02: makeEdge accepts loc?: {line, column}
│   ├── lwc/
│   │   └── html-visitor.ts                       # W1-03: lwc:if/for handling
│   ├── apex/
│   │   ├── arity-resolver.ts                     # W1-04: argTypes matching
│   │   └── class.ts                              # W1-05: @isTest annotation → IS_TEST
│   ├── cross-flavor-resolver.ts                  # REFERENCE SHAPE for new passes
│   ├── omnistudio/
│   │   └── overlap-detector.ts                   # NEW — W2-01 (mirrors cross-flavor shape)
│   └── mcd-gap-fills/                            # NEW — W2-04 (post-merge pass dir)
│       ├── lookup.ts
│       ├── value-set.ts
│       └── picklist.ts
├── extractors/live-org/
│   ├── vlocity/runner.ts                         # W1-01: catch sites @ 76, 188, 246
│   └── extractors/
│       ├── omnistudio-retrieve.ts                # NEW — W2-02
│       └── mcd-baseline.ts                       # NEW — W2-03
├── query/
│   └── glob-selector.ts                          # NEW — W3-04
├── render/
│   └── sarif.ts                                  # NEW — W3-02
└── ingest/
    └── live-ingest.ts                            # W2-01 wire-in @ ~line 713;
                                                  # W1-01 warnings plumbed to LiveIngestResult
rules/                                            # W3-01: rename across 21 YAMLs
```

### Structure Rationale

- **`parsers/omnistudio/`:** new sub-tree mirrors `parsers/apex/` and `parsers/lwc/`. Keeps overlap detector close to OmniStudio fixtures and tests; matches the directory taxonomy reviewers already know.
- **`extractors/live-org/extractors/`:** following the established pattern — runner.ts orchestrates, individual extractors live as siblings. W2-02/W2-03 slot in without restructuring.
- **`render/`:** the SARIF emitter is a renderer (graph → external format), not an analyser. Lives next to whatever markdown/dot/json renderers already exist. **Do not** create a separate `packages/sarif/` — the publish coordination across 7 packages is the dominant cost (see Constraints in PROJECT.md), and the renderer has no external consumers besides the existing MCP server.

## Architectural Patterns

### Pattern 1: Post-merge resolver pass (the canonical shape — copy this for W2-01)

**What:** A function `resolveX(store, opts): Result` invoked from `live-ingest.ts` after `mergeNodes`/`mergeEdges` have populated the graph. Wraps its writes in `store.transaction()`. Caller wraps the whole call in its own `try/catch` so a bug in one pass cannot fail ingest.

**When to use:** Any analysis that needs the full graph in place — overlap detection, gap-fills, dangling-edge audits.

**Trade-offs:** Read-after-write on partially-merged graph is intentional and cheap. Per-pass isolation means one pass's failure won't roll back the others' writes; this is the **deliberate non-atomicity** decision documented in PROJECT.md's Key Decisions table.

**Example (live-ingest.ts:713–728, verbatim shape to follow):**

```typescript
if (!opts.disableCrossFlavor) {
  try {
    crossFlavorEdges = resolveCrossFlavor(graph, {
      orgId: resolved.orgId,
      namespace: null,
      ctx: postCtx,   // postCtx.sourceUri === "post-merge://resolver"
    });
    if (crossFlavorEdges > 0) {
      logger.info("live-ingest: cross-flavor resolver linked Vlocity↔OmniStudio", {
        edges: crossFlavorEdges,
      });
    }
  } catch (e) {
    logger.warn("live-ingest: cross-flavor resolver failed", { err: (e as Error).message });
  }
}
```

And inside the resolver itself (cross-flavor-resolver.ts:42):

```typescript
store.transaction(() => {
  // … all merges happen here; transaction is per-pass, NOT per-ingest …
});
```

### Pattern 2: Additive interface evolution

**What:** When adding fields to `EdgeFact` / `NodeFact` / `LiveIngestResult`, make them optional and back-fill incrementally. Public API surfaces (26 MCP tool envelopes, `{summary, markdown, data, follow_up_tools}` shape) must accept new fields without breaking existing consumers.

**When to use:** Every Wave 1 schema change (W1-02 sourceUri/line/column; W1-01 warnings array).

**Trade-offs:** Optional fields mean readers must handle the `undefined` case. Worth it — the alternative is a coordinated all-parsers PR which is the kind of fan-out PROJECT.md's Constraints flag as a hazard.

### Pattern 3: Capability-gated extractor

**What:** Extractor checks `caps.<flag>` and falls back when the org doesn't support the path. Existing precedent: `iterVlocityRecords` early-returns when `caps.vlocityNamespaces.length === 0`.

**When to use:** W2-02 (OmniStudio retrieve() — fall back to SOQL). Keeps the merge stage agnostic to which extractor produced a `RawMember`.

## Data Flow

### Existing ingest flow

```
sf-CLI auth ─▶ read-only proxy ─▶ extractor async-iterators ─▶ merge stream ─▶ GraphStore.mergeNodes/Edges
                                              │                       │                    │
                                       (12 in-flight,             RawMember           Per-pool Bottleneck
                                        sliding window)             yields              rate limit
                                                                                            │
                                                                                            ▼
                                                                                  Post-merge passes (4 today)
                                                                                  per-pass try/catch + store.transaction()
                                                                                            │
                                                                                            ▼
                                                                                  LiveIngestResult
                                                                                  {nodes, edges, crossFlavorEdges,
                                                                                   arityResolved, flowMethodsResolved,
                                                                                   danglingEdges, …}
```

### Flow with Wave additions

```
Extractors  ─┬─ vlocity/runner.ts        ─┐
             ├─ omnistudio-retrieve.ts ◀──┤  [+W2-02]
             ├─ mcd-baseline.ts        ◀──┤  [+W2-03] tags source:'mcd'
             └─ existing apex/flow/lwc ──┘
                                          │
                                          ▼
                              merge stream
                              [+W2-03 merge rule: source:'parsed' wins on conflict]
                              [+W3-05 rename: UPDATE edges instead of DELETE+INSERT]
                                          │
                                          ▼
                              Post-merge passes
                              ├─ resolveCrossFlavor               (existing)
                              ├─ [+W2-01] detectOmniStudioOverlap (NEW)
                              ├─ [+W2-04] mcd-gap-fills           (NEW)
                              ├─ resolveFlowApexMethods           (existing)
                              ├─ resolveApexMethodArity           (existing — tightened by W1-04)
                              └─ auditDanglingEdges               (existing)
                                          │
                                          ▼
                              LiveIngestResult
                              {…existing fields,
                               + warnings: string[]               [+W1-01]
                               + overlapEdges: number             [+W2-01]
                               + …}
                                          │
                                          ▼
                              MCP tools (existing 26 + export_sarif [+W3-02] + find_nodes [+W3-04])
```

### Edge provenance flow (W1-02 — the dependency spine)

```
Parser visitor                ParseContext             makeEdge                  EdgeFact
─────────────                 ────────────             ────────                  ────────
elem @ line=L col=C   ──▶  ctx.sourceUri='file.cls' ──▶ {sourceUri, line, col} ──▶ persisted
                           (W1-02 adds loc: {line, col})       ▲
                                                               │
                                       (today: makeEdge drops sourceUri — that's the bug)
```

Once W1-02 lands:
- Every EdgeFact carries `(sourceUri, line, column)` → W2-01 overlap detector can name source coordinates in its findings → W3-02 SARIF emitter has `physicalLocation` data to populate → ESLint-style CI consumption becomes real.

## Build-Order Dependencies (the spine the roadmap should follow)

```
W1-06 (README, parallel)
W1-05 (IS_TEST, parallel)
W1-04 (arity tightening, parallel)
W1-03 (LWC directives, parallel)
W1-01 (silent catch → warnings field) ─────────┐
W1-02 (edge provenance) ───────────────────────┤
                                               │
                            ┌──────────────────┴─────────────────────┐
                            ▼                                        ▼
              W2-01 (overlap detector — needs W1-02     W2-02 / W2-03 / W2-04 / W2-05 / W2-06
              to cite source locations; needs W1-01     (independent — can parallelize)
              to surface ingest-time warnings about
              skipped overlap candidates)
                            │                                        │
                            └──────────────────┬─────────────────────┘
                                               ▼
                            W3-01 (PMD rule schema rename)
                                               │
                                               ▼
                            W3-02 (SARIF emitter — needs W1-02
                            for physicalLocation AND W3-01 for
                            rule shape)
                                               │
                            ┌──────────────────┼─────────────────────┐
                            ▼                  ▼                     ▼
                       W3-03 (pkg.xml      W3-04 (glob          W3-05 (rename
                       follow_up)          selectors)            stability)
```

**Critical edges (do not violate):**

1. **W1-02 → W2-01.** Overlap detector findings without source coordinates are unactionable. Confirmed by re-reading `parsers/common.ts:30` — `makeEdge` currently throws away `ctx.sourceUri`, so today's `CANONICAL_OF` edges already have no provenance.
2. **W1-02 → W3-02.** SARIF `result.locations[].physicalLocation` requires `(uri, region.startLine, region.startColumn)`. No edge provenance → SARIF has no `physicalLocation` → CI consumers can't jump-to-source.
3. **W1-01 → W2-01.** Overlap detector needs to report when it skipped a candidate because Vlocity ingest swallowed an exception. Without the `warnings` field, this disappears.
4. **W3-01 → W3-02.** SARIF emitter maps rule fields 1:1; renaming after emitter exists is double-work.
5. **W2-03 (MCD baseline) → W2-04 (Happy Soup gap-fills).** Gap-fills heuristically join across the long-tail metadata MCD provides; without MCD, they have nothing to join against. *Optional pairing — gap-fills can also operate on parsed-only graphs, but coverage is reduced.*

**Independent (any order):** W1-03, W1-04, W1-05, W1-06, W2-05, W2-06, W3-03, W3-04, W3-05.

## Shared-Interface Risks (the fan-out hazards)

| Interface | Touched by | Risk |
|-----------|------------|------|
| `EdgeFact` (`domain/edge-fact.ts`) | W1-02 | **Every parser** emits these. Keep new fields optional; back-fill per-parser. |
| `makeEdge()` (`parsers/common.ts:30`) | W1-02 | Same — every parser call site. Signature change must be optional 4th-arg `loc?`. |
| `LiveIngestResult` | W1-01 (warnings), W2-01 (overlapEdges) | Public-ish surface (CLI prints it, MCP tool returns it). Additive only. |
| `ParseContext` (`parsers/contract.ts`) | (already has `sourceUri` @ line 7) | No change required — W1-02 only needs to USE it. |
| Post-merge opts (`disableX?: boolean` family) | W2-01 (`disableOverlapDetect`) | Pattern is already established; just add the flag. |
| Rule YAML schema | W3-01 | All 21 files — coordinate as a single PR. Loader keeps an alias read for one cycle to ease the transition. |
| GraphStore merge semantics | W2-03 (source tagging), W3-05 (rename rewrite) | Storage layer change. Document the merge precedence rule explicitly in a `MERGE_RULES.md` next to the storage interface. |

## Anti-Patterns to Avoid

### Anti-Pattern 1: Global atomic transaction around merge + post-passes

**What people do:** Wrap the entire ingest (extract → merge → all post-passes) in a single `store.transaction()` so a late failure rolls everything back.

**Why it's wrong:** Locks the DB for the full ~5-minute ingest, killing concurrent reads. Already documented as a Key Decision in PROJECT.md. The existing per-pass try/catch isolation at `live-ingest.ts:698–783` is the correct pattern.

**Do this instead:** Each post-merge pass wraps its own writes in `store.transaction()` (see `cross-flavor-resolver.ts:42`); the orchestrator wraps each pass in `try/catch` and logs failures.

### Anti-Pattern 2: Silent `catch {}` to "be tolerant"

**What people do:** The very pattern W1-01 is fixing — silently swallow errors in extractor loops to keep the iteration going.

**Why it's wrong:** Ingest looks healthy but is missing data. The user has no signal until they query and find nothing. PROJECT.md's "Core Value" statement explicitly calls this out: *"every ingest failure is loud, named, and recoverable."*

**Do this instead:** Catch + log + push to a `warnings: string[]` collected on `LiveIngestResult`. Iteration continues, but the failure is visible.

### Anti-Pattern 3: Drop provenance at the parser/edge boundary

**What people do:** `makeEdge(ctx, src, REL, dst, { … })` — discard `ctx.sourceUri`, even though `makeNode` (10 lines up in the same file) preserves it.

**Why it's wrong:** Edges carry the dependency information; they're what downstream consumers query. An edge without source coordinates is unauditable. This is the current state of the codebase, confirmed by reading `parsers/common.ts:30–47`.

**Do this instead:** W1-02. `makeEdge` should mirror `makeNode`'s treatment of `ctx.sourceUri`, and accept an optional `loc: {line, column}` from AST nodes that carry positions (antlr4ts and parse5 both emit them).

### Anti-Pattern 4: Renaming public surfaces in place

**What people do:** "Cleaner names" PR that renames an `EdgeFact` field or an MCP tool response key.

**Why it's wrong:** Backwards-compat constraint in PROJECT.md: 26 MCP tool surfaces and `{summary, markdown, data, follow_up_tools}` shape are public API. Renames break consumers.

**Do this instead:** Add new fields. Mark old ones deprecated in docs only. Bulk rename is for the next major version.

## Scaling Considerations

Sfgraph runs locally per developer/org; "scale" is a function of org size (number of components) and number of post-merge passes, not concurrent users.

| Scale dimension | Today | With Waves applied |
|-----------------|-------|---------------------|
| Small org (<5k components) | sub-second MCP responses, full ingest in <1 min | No change — overhead of new passes negligible |
| Mid org (5k–50k) | Full ingest 2–5 min, MCP sub-second on warm graph | W2-01/W2-04 add one full-graph scan each per ingest. Sub-second MCP constraint preserved by running these at ingest time, not query time. |
| Large org (50k+) | Adaptive bisection kicks in (`MAX_BISECT_DEPTH=6`) | W2-05/W2-06 mitigate (composite-25 batching before bisection; auto-rebatcher for 414/431). MCD baseline (W2-03) explicitly designed to keep cost flat across long-tail types. |

### Scaling Priorities

1. **First bottleneck (today):** Tooling SOQL 414/431 on large IN-clauses → **W2-05** is the direct fix.
2. **Second bottleneck (today):** `metadata.read` calls one-at-a-time before bisection → **W2-06** (composite-25) batches first, bisects only on composite failure.
3. **Wave-introduced bottleneck:** Two new post-merge passes (W2-01, W2-04). Each does a single full-graph scan; cost is O(nodes). Acceptable. Don't add a third without measurement.

## Integration Points (external)

### External services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Salesforce sf-CLI | `@salesforce/core` auth → read-only proxy (existing) | Zero DML; existing pattern. W2-02 reuses. |
| SARIF consumers (sfdx-scanner, CodeScan, Clayton, GitHub code scanning) | One-shot file export via `export_sarif` MCP tool | New. Versioned at SARIF 2.1.0. |

### Internal boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `extractors` ↔ `parsers` | `RawMember` async-iterator yield | Stable shape — W2-02/W2-03 must yield matching shape. |
| `parsers` ↔ `GraphStore` | `mergeNodes` / `mergeEdges` batched | W2-03 source tagging rides on `attributes` field — no merge-API change. |
| `ingest` ↔ post-merge passes | `(store, {orgId, ctx, …}) → Result` | Pattern locked by `cross-flavor-resolver.ts`. Copy verbatim. |
| `core` ↔ `mcp-server` | TypeScript imports across packages | W3-02 (export_sarif) and W3-04 (find_nodes) cross this boundary. Coordinate version bumps per PROJECT.md Constraints. |

## Sources

- `.planning/PROJECT.md` (Waves 1/2/3 scope, key decisions, constraints) — HIGH
- `packages/core/src/ingest/live-ingest.ts:680–809` (post-merge pass shape, atomicity decision in code) — HIGH
- `packages/core/src/parsers/cross-flavor-resolver.ts` (reference shape for new passes — `store.transaction()`, opts type, return shape) — HIGH
- `packages/core/src/parsers/common.ts:10–47` (verified `makeEdge` drops `ctx.sourceUri` while `makeNode` preserves it — W1-02's surgical site) — HIGH
- `packages/core/src/domain/edge-fact.ts` (current 12-line EdgeFact interface, no provenance fields) — HIGH
- `packages/core/src/parsers/contract.ts:7` (ParseContext already has `sourceUri`) — HIGH
- `packages/core/src/extractors/live-org/vlocity/runner.ts:76, 188, 246` (three silent catch sites; line 76 is `tryParseJsonField`, 188 is child-fetch SOQL, 246 is parent-fetch SOQL) — HIGH
- `packages/core/src/parsers/lwc/html-visitor.ts` (whole file — verified zero matches for `lwc:if|lwc:for|lwc:else`) — HIGH

---
*Architecture research for: Salesforce metadata graph hardening + capability expansion milestone*
*Researched: 2026-05-17*
