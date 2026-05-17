# Feature Research

**Domain:** Salesforce metadata graph / dependency analysis tooling (MCP-first, local-only)
**Researched:** 2026-05-17
**Confidence:** MEDIUM-HIGH (competitive landscape grounded in PROJECT.md analyses + public docs of Happy Soup, Salto, sfdx-scanner/SFGE, PMD-Apex, Elements.cloud, Strongpoint, CodeScan, Clayton, Gearset, Copado; Wave-item classification grounded in PROJECT.md Validated + Active + Out-of-Scope)

## Feature Landscape

### Table Stakes (Users Expect These)

Features that any Salesforce dependency-analysis tool must have in 2026. Missing any of these = users will reach for Happy Soup, Salto, or sfdx-scanner instead.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Apex class/trigger/method dependency extraction | Baseline of every competitor (Happy Soup, Salto, SFGE, CodeScan) | — | Already shipped: antlr4ts-based parser, 88 typed edges |
| LWC / Aura / VF component dependency extraction | LWC is the default UI; Happy Soup and Salto both cover this | — | Already shipped: Babel JS + parse5 HTML; **W1-03** closes the conditional/loop directive gap |
| Flow dependency extraction (subflows, actions, refs) | Flow is now the dominant automation; missing = irrelevant | — | Already shipped: fast-xml-parser + 21 rule files |
| Custom Object / field / picklist dependency extraction | Long-tail metadata; Happy Soup's MCD covers this for free | — | Partially shipped; **W2-03 + W2-04** close MCD gap |
| Layout / FieldSet / EmailTemplate / Tab / Group / Queue coverage | Happy Soup MCD covers these; absence = "incomplete graph" complaint | MEDIUM | **W2-03** — table stakes via MCD fast-path |
| Lookup-field, value-set, controlling-picklist edges | Happy Soup-specific gap-fills; users migrating from HS expect parity | MEDIUM | **W2-04** — must re-implement (AGPL constraint), don't copy-paste |
| `package.xml` generation for impact set | Every commercial tool ships this; required for deploy workflows | LOW-MEDIUM | **W3-03** — generator exists; needs wiring as `follow_up_tool` |
| Edge source-location provenance (file/line/column) | sfdx-scanner / PMD / SARIF consumers require it; Salto NaCl carries it | MEDIUM | **W1-02** — currently a documented gap in `EdgeFact` |
| Silent-failure detection / warnings surface | CI tools (sfdx-scanner, CodeScan) all expose error/warning channels; silent swallowing = production unfit | LOW | **W1-01** — three known `catch {}` blocks in vlocity/runner.ts |
| SARIF 2.1.0 output | GitHub code-scanning, sfdx-scanner v3+, CodeScan all emit SARIF; CI-adoption gate | MEDIUM | **W3-02** — required for IDE/CI parity |
| Glob/pattern selectors for queries | Salto NaCl supports selectors; sf CLI accepts metadata selectors; LLMs need them to compose queries | MEDIUM | **W3-04** — current 26 tools cover ID-based lookup but not patterns |
| Rule engine with PMD-compatible schema | PMD-Apex is the de-facto OSS rules tool; alignment makes rules portable | LOW-MEDIUM | **W3-01** — schema rename only, no behavior change |
| Test class identification (`IS_TEST`) | sfdx-scanner / CodeScan / coverage tools all distinguish; deploy/impact accuracy depends on it | LOW | **W1-05** — annotation-based, not filename heuristic |
| Apex method-arity / overload resolution | Distinguishes sfgraph from regex tools; required for accurate call graphs | MEDIUM | **W1-04** — tighten existing resolver |
| OmniStudio (IP, OS, DR, FlexCard) extraction | OmniStudio-on-Core is the migration story for 2025-2027; any SF tool ignoring it is dated | — | Already shipped: four Vlocity JSON parsers; **W2-02** adds `retrieve()` fidelity |
| Read-only org access | Regulated customers (finserv, healthcare, defense) require it; Salto / Gearset offer it as posture | — | Already shipped: read-only proxy enforcing no DML |
| sf-CLI / @salesforce/core auth | Don't reinvent OAuth; users have authenticated orgs already | — | Already shipped |
| Local SQLite per-org storage | Privacy-conscious customers refuse cloud upload of metadata | — | Already shipped: env-paths per-org |
| Rate-limited live-org ingestion | Hitting API limits = user account suspension; Salto, Gearset all rate-limit | — | Already shipped: Bottleneck per-pool |
| Tooling SOQL auto-rebatch on 414/431 | Common failure when impact sets get large; Happy Soup hits this | LOW-MEDIUM | **W2-05** — known operational gap |
| Composite-subrequest batching for metadata.read | Native API affordance; ignoring it = 10x slower ingest | LOW | **W2-06** — performance table stakes |
| Rename-stability across ingests | Salto's ElemID model solves this; sfgraph currently delete+adds | MEDIUM | **W3-05** — required for stable diffs across runs |
| Honest self-description in docs | Trust gate; misrepresented capabilities = abandonment after first use | LOW | **W1-06** — README correctness |

### Differentiators (Competitive Advantage)

Features sfgraph has (or this milestone adds) that competitors don't — these are the wedges.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| MCP-first response shape (`{summary, markdown, data, follow_up_tools}`) | **No competitor ships an MCP server.** Gearset has distribution to copy this fast — first-mover window is now. | — | Already shipped: 26 tools |
| 88 typed edge relationships | Salto carries ~30, Happy Soup ~15, SFGE ~20. Highest-fidelity OSS dependency model. | — | Already shipped |
| Local-only privacy posture | Elements.cloud / Sherlock / Strongpoint / Copado all SaaS. Only OSS competitor at parity is Happy Soup (but no live-org grounding) and sfdx-scanner (no graph). | — | Already shipped — **PROTECT** (Out-of-Scope correctly excludes hosted/SaaS) |
| OmniStudio overlap detection | No competitor does cross-flavor (CMT↔core) signature-mismatch detection. Vlocity migration story sells this. | MEDIUM-HIGH | **W2-01** — top of Wave 2 |
| `retrieve()`-based OmniStudio extraction | SOQL misses design-time fields; retrieve() gets full envelope. Salto does retrieve() but for general metadata, not OmniStudio specifically. | HIGH | **W2-02** — biggest piece in Wave 2 |
| CMT↔core canonical resolver (`CANONICAL_OF` edges) | Unique to sfgraph; competitive moat for hybrid Vlocity-CMT + OmniStudio-on-Core orgs (the migration cohort) | — | Already shipped |
| Vector search over metadata (sqlite-vec, MiniLM-L6) | "Find similar Apex classes" / semantic search — no competitor has this in OSS | — | Already shipped |
| Async ingest jobs + pollable status | Salto's CLI is synchronous; Happy Soup is one-shot. MCP-loop UX requires async. | — | Already shipped |
| Multi-org orchestrator | Salto supports multi-env; sfdx-scanner is single-target. Diff across sandboxes is a real need. | — | Already shipped |
| Snapshot / point-in-time graph | Compliance + change-audit use case. Strongpoint charges for this. | — | Already shipped |
| WIP/git-diff toolset | "What does this PR touch?" — only Clayton offers something similar (commercial) | — | Already shipped |
| GenAI / Agentforce extractor | New surface area (2025); no OSS competitor covers it yet | — | Already shipped |
| Local 3D web visualizer | Elements.cloud is the visualization leader (SaaS); local-only at this fidelity is unique | — | Already shipped (`localhost:7777`) |
| MCD fast-path with `attributes.source` tagging | Happy Soup uses MCD blindly; sfgraph would mark `parsed` vs `mcd` so users know fidelity | MEDIUM | **W2-03** — combines MCD speed with parser fidelity (best of both) |
| Rename-stable graph diffs (ElemID-style) | Salto's killer feature for diff workflows. Adding this neutralizes a primary Salto sales point. | MEDIUM-HIGH | **W3-05** — strategic |
| 21 declarative YAML rules + PMD alignment | PMD-Apex requires Java; sfgraph rules are YAML and node-native. After W3-01, rules are portable bidirectionally with PMD. | LOW | **W3-01** + existing rules |
| `find_nodes` glob selector + SARIF emitter (combined) | Makes sfgraph drop-in for CI workflows where sfdx-scanner is incumbent | MEDIUM | **W3-02 + W3-04** together unlock IDE/CI adoption |

### Anti-Features (Commonly Requested, Often Problematic)

Features that look attractive but should NOT be built. All of these are already listed in PROJECT.md Out of Scope — the rationale below validates and (where applicable) extends.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Hosted / SaaS deployment | "Easier onboarding" / "share with team" | Destroys the single strongest commercial wedge vs Elements.cloud / Sherlock / Copado / Strongpoint. Regulated customers refuse cloud upload of org metadata. | Keep local-only; offer team-shareable SQLite snapshot export instead |
| Two-way deploy (Salto-style `salto deploy`) | "Round-trip would close the loop" | Multi-month rabbit hole; read-only is a feature (security review pass, no destructive risk). sf-CLI already does deploy. | Emit `package.xml` (W3-03) and let sf-CLI / Gearset / Copado handle deploy |
| Custom CQL / SQL DSL | "Power users want queries" | Adds a language surface to maintain; 26 MCP tools + glob selectors (W3-04) already cover known queries; LLM composes the rest | Use MCP tool composition + `find_nodes` glob selector |
| Per-path symbolic execution (SFGE direction) | "Find every code path that touches X" | Causes SFGE's 15-minute traversals; incompatible with sub-second MCP UX | Pre-computed reachability + indexed lookups (already shipped) |
| Regex-based Apex parsing | "Faster than ANTLR" | Wrong answers; even Happy Soup's maintainer commented out their regex SymbolTable | antlr4ts (already shipped) |
| Global atomic transaction wrapping ingest | "Consistency guarantee" | Locks SQLite for 5+ min; kills concurrent reads; per-resolver isolation already correct | Keep per-resolver try/catch isolation |
| JVM / Java rule API (SFGE/PMD-style) | "Power rules need real code" | Drags in JVM dependency; YAML+PMD alignment (W3-01) is the right granularity | Expand YAML schema (W3-01); custom rules via codeowner-maintained YAML files |
| VS Code / JetBrains IDE extensions | "Devs live in their IDE" | Wave 1+2+3 is already 4-6 weeks; SARIF (W3-02) is the right interop layer first | Land SARIF, then IDE extensions consume it in next milestone |
| Real-time org-watching / push notifications | "Detect changes as they happen" | Salesforce Streaming API is unreliable for metadata; snapshots + on-demand ingest is the right model | Snapshots + git-diff toolset (already shipped) |
| Full text search across Apex source | "grep for the graph" | Vector search + glob selectors cover the use case; full-text is a separate index to maintain | Vector search (shipped) + `find_nodes` (W3-04) |
| Graph mutation API ("add edge X→Y") | "Let me annotate the graph" | Breaks reproducibility; every ingest re-derives. Annotations belong in a separate layer. | Emit warnings/rules; let user maintain overrides in YAML, not in-graph mutation |
| Custom edge types via user config | "I have org-specific dependencies" | 88 typed edges already covers; new types reduce shared vocabulary; rule engine (YAML) is the right extension surface | Add rule files (W3-01 schema); request edge types via issue |

## Feature Dependencies

```
W1-01 (warnings surface) ──┐
                           ├──> W2-01 (overlap detector reports WHICH mismatches)
W1-02 (edge provenance) ───┘     └──> W3-02 (SARIF needs file/line/column)

W1-02 (edge provenance) ──> W3-02 (SARIF emitter)
                       └──> W3-04 (find_nodes results carry location)

W3-01 (PMD rule schema) ──> W3-02 (SARIF rule descriptor mapping)

W1-04 (arity resolver) ──enhances──> existing call-graph fidelity (no new feature, but improves W2-01 accuracy)

W2-02 (retrieve() OmniStudio) ──> W2-01 (overlap detector consumes richer source)
                              └──> W2-03 (MCD fast-path knows what NOT to overwrite — parsed wins)

W2-03 (MCD fast-path) ──> W2-04 (Happy Soup gap-fills layer on MCD output)

W2-05 (auto-rebatch) ──enhances──> W2-02 (retrieve() at scale)
W2-06 (composite batching) ──enhances──> all metadata.read paths (orthogonal perf win)

W3-05 (ElemID rename stability) ──> any cross-snapshot diff workflow (independent, but unlocks future "graph diff" tools)

W3-03 (package.xml as follow_up_tool) ──requires──> existing generator + impact-tool catalog (no new feature; wiring only)
```

### Dependency Notes

- **W1-02 is the keystone:** SARIF (W3-02), `find_nodes` location output (W3-04), and overlap detector "which mismatch and where" reporting (W2-01) all require source location on `EdgeFact`. Slipping W1-02 cascades across both later waves.
- **W1-01 is a prerequisite for W2-01:** The overlap detector needs a place to surface "signature mismatch in IP X step Y" without throwing — that's the `warnings` field from W1-01.
- **W3-01 must precede W3-02:** SARIF's `reportingDescriptor` maps 1:1 to PMD's rule fields. Building SARIF first then renaming rules requires double-work.
- **W2-03 must precede W2-04:** MCD fast-path emits the baseline graph; Happy Soup gap-fills (lookup, value-set, controlling-picklist) layer on top with `parsed` source tagging.
- **W2-02 (retrieve()) is sequenced LAST in Wave 2** per PROJECT.md decision: it benefits from earlier provenance/warnings plumbing, and is the largest single piece.
- **W2-06 (composite batching) is orthogonal to the bisection logic** but should land before W2-02 so retrieve() at scale benefits from it.
- **W3-05 (ElemID rename stability) is independent** but has the largest persistence-layer surface area — should land last in Wave 3 to avoid blocking SARIF/glob/package.xml.
- **W1-05 (`IS_TEST` annotation)** is independent of everything else; can land any time in Wave 1.
- **W1-06 (README correctness)** depends on W1-01..W1-05 being done (so the descriptions are accurate). Land last in Wave 1.

## MVP Definition

This is a **brownfield hardening milestone**, not a v1. "MVP" here = the minimum that makes the milestone honest about its Core Value ("every edge carries provenance, every failure is loud").

### Launch With (Wave 1 — Week 1)

The non-negotiable provenance + silent-failure fixes. Without these, the rest of the milestone is built on sand.

- [ ] **W1-01** — Replace silent `catch {}` in vlocity/runner.ts; surface `warnings: string[]`
- [ ] **W1-02** — Add `sourceUri/line/column` to `EdgeFact`; thread through all parsers
- [ ] **W1-03** — LWC `lwc:if/elseif/else/for:each` directive handling
- [ ] **W1-04** — Tighten Apex arity resolver
- [ ] **W1-05** — `IS_TEST` from `@isTest` annotation
- [ ] **W1-06** — README correctness pass

### Add After Validation (Wave 2 — Weeks 2-3)

Capability gaps that materially expand the addressable use case (Vlocity migrations, long-tail metadata, Tooling-SOQL robustness).

- [ ] **W2-01** — OmniStudio overlap detector (highest leverage; 1.5d in plan)
- [ ] **W2-03** — MCD fast-path baseline with `source` tagging
- [ ] **W2-05** — `tryWithSmallerQueries` auto-rebatcher
- [ ] **W2-06** — Composite-subrequest batching of 25
- [ ] **W2-04** — Happy Soup MCD gap-fills (lookup/value-set/controlling-picklist) — re-implement, do NOT copy AGPL
- [ ] **W2-02** — `retrieve()`-based OmniStudio extractor (largest piece, benefits from W1-01/W1-02)

### Future Consideration (Wave 3 — Week 4 — Distribution/Interop)

Adoption-unlock features. Strategically critical (Gearset threat mitigation) but technically post-MVP.

- [ ] **W3-01** — PMD-aligned YAML rule schema rename
- [ ] **W3-02** — SARIF 2.1.0 emitter + `export_sarif` MCP tool
- [ ] **W3-03** — `package.xml` generator wired as `follow_up_tool` on impact tools
- [ ] **W3-04** — `find_nodes` glob selector tool
- [ ] **W3-05** — ElemID rename stability (independent, can slip to next milestone if Wave 1+2 overruns)

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| W1-01 silent-catch fix | HIGH | LOW | **P1** |
| W1-02 edge provenance | HIGH | MEDIUM | **P1** |
| W1-03 LWC directives | HIGH | LOW-MEDIUM | **P1** |
| W1-04 arity resolver | MEDIUM | MEDIUM | **P1** |
| W1-05 IS_TEST attribute | MEDIUM | LOW | **P1** |
| W1-06 README correctness | MEDIUM | LOW | **P1** |
| W2-01 OmniStudio overlap detector | HIGH | MEDIUM-HIGH | **P1** |
| W2-02 retrieve() extractor | HIGH | HIGH | **P1** |
| W2-03 MCD fast-path | HIGH | MEDIUM | **P1** |
| W2-04 Happy Soup gap-fills | MEDIUM-HIGH | MEDIUM | **P2** |
| W2-05 auto-rebatcher | MEDIUM | LOW-MEDIUM | **P2** |
| W2-06 composite batching | MEDIUM | LOW | **P2** |
| W3-01 PMD rule schema | LOW (direct) / HIGH (enables W3-02) | LOW | **P1** (sequencing) |
| W3-02 SARIF emitter | HIGH (CI adoption) | MEDIUM | **P1** |
| W3-03 package.xml wiring | HIGH | LOW | **P1** |
| W3-04 find_nodes glob | MEDIUM-HIGH | MEDIUM | **P2** |
| W3-05 ElemID rename stability | MEDIUM (slow burn value) | MEDIUM-HIGH | **P2** (can slip) |

**Priority key:**
- **P1**: Must land this milestone; defines whether the milestone succeeded
- **P2**: Should land; slip-candidate if Wave 1/2 overruns
- **P3**: Not in this milestone — see Anti-Features and Out of Scope

## Competitor Feature Analysis

Existing sfgraph strengths and weaknesses against the competitive set (per the two analyses referenced in PROJECT.md Context):

| Feature | Happy Soup | Salto | sfdx-scanner / SFGE | PMD-Apex | Elements.cloud | Strongpoint / Sherlock | Gearset / Copado | sfgraph today | sfgraph after this milestone |
|---------|-----------|-------|---------------------|----------|----------------|------------------------|------------------|---------------|------------------------------|
| MCP-first surface | — | — | — | — | — | — | — | **YES (26 tools)** | YES (28+ tools after W3-02, W3-04) |
| Local-only privacy | YES | YES (CLI) | YES | YES | NO (SaaS) | NO (SaaS) | Hybrid | **YES** | YES |
| Live-org grounding | YES (MCD) | YES (retrieve) | NO (source-tree) | NO (source) | YES | YES | YES | **YES** | YES + retrieve() (W2-02) |
| Typed edge count | ~15 | ~30 | ~20 (rules) | N/A | unknown | unknown | unknown | **88** | 88+ (overlap edges from W2-01) |
| Apex parse fidelity | Regex (deprecated) | antlr | antlr (SFGE) | antlr | unknown | unknown | unknown | **antlr4ts** | antlr4ts + tightened arity (W1-04) |
| LWC HTML directives | Partial | YES | Partial | NO | YES | unknown | YES | **Partial (no `lwc:if`)** | YES (W1-03) |
| Flow extraction | YES | YES | Limited | NO | YES | YES | YES | **YES** | YES |
| OmniStudio / Vlocity | Limited | Limited | NO | NO | YES | YES | Limited | **YES (4 parsers)** | YES + overlap (W2-01) + retrieve() (W2-02) |
| MCD long-tail coverage | **YES (strength)** | YES | NO | NO | YES | YES | YES | Partial | YES (W2-03) + HS gap-fills (W2-04) |
| Edge source-location provenance | NO | YES (NaCl line refs) | YES (SARIF) | YES (SARIF) | unknown | unknown | unknown | **NO (gap)** | YES (W1-02) |
| SARIF output | NO | NO | **YES (strength)** | YES | NO | NO | NO | NO | YES (W3-02) |
| PMD-compatible rules | NO | NO | NO | **YES (strength)** | NO | NO | NO | YAML (custom shape) | YAML (PMD-aligned, W3-01) |
| Glob/pattern selectors | NO | YES (NaCl selectors) | Limited | Limited | unknown | unknown | YES | NO | YES (W3-04) |
| `package.xml` emission | NO | YES | NO | NO | YES | YES | YES | Generator exists, not wired | YES (W3-03) |
| Test-class detection (`IS_TEST`) | Filename | Annotation | Annotation | Annotation | unknown | unknown | unknown | Inconsistent | Annotation (W1-05) |
| Rename-stable diffs | NO | **YES (ElemID strength)** | NO | NO | unknown | YES (commercial) | YES | NO | YES (W3-05) |
| Silent failure handling | Mixed | Logged | Logged (SARIF errors) | Logged | unknown | unknown | unknown | **Silent (gap)** | Warnings surface (W1-01) |
| Async ingest | NO | NO | NO | NO | YES | YES | YES | **YES** | YES |
| Vector / semantic search | NO | NO | NO | NO | NO | NO | NO | **YES** | YES |
| Snapshots / point-in-time | NO | YES | NO | NO | YES | YES | YES | **YES** | YES |
| Read-only org enforcement | N/A | Opt-in | N/A | N/A | YES | YES | Configurable | **YES (proxy)** | YES |
| Tooling SOQL auto-rebatch | NO | YES | N/A | N/A | unknown | unknown | YES | **NO (gap)** | YES (W2-05) |
| Composite-subrequest batching | NO | YES | N/A | N/A | unknown | unknown | YES | **NO (gap)** | YES (W2-06) |
| 3D / interactive visualization | NO | Web UI | NO | NO | **YES (strength)** | YES | Limited | **YES (local)** | YES |

### Where sfgraph today is strong vs the competitive set

1. **MCP-first** — no one else has this; the largest first-mover wedge.
2. **88 typed edges** — highest-fidelity OSS dependency model.
3. **OmniStudio + Vlocity CMT cross-flavor canonical resolver** — unique architecturally; the migration story.
4. **Vector search** — no OSS competitor; SaaS competitors don't expose it.
5. **Local-only privacy + live-org grounding combined** — Happy Soup has local-only but no live-org; Salto has live-org but trends toward SaaS workflows; Elements.cloud / Sherlock are SaaS.
6. **Production-hardened ingest** (rate limiting, async jobs, adaptive bisection) — most OSS tools are one-shot scripts.

### Where sfgraph today is weak vs the competitive set

1. **No source-location provenance on edges** (W1-02) — Salto and SARIF tools all carry this; today's gap blocks SARIF adoption and IDE integration.
2. **Silent `catch {}` in vlocity/runner.ts** (W1-01) — production-unfit for CI; no competitor does this.
3. **No SARIF output** (W3-02) — blocks GitHub code-scanning / sfdx-scanner replacement.
4. **No glob/pattern selectors** (W3-04) — Salto NaCl selectors are a known UX win.
5. **`package.xml` generator not wired into impact tools** (W3-03) — every commercial deploy tool ships this.
6. **No rename-stable graph diffs** (W3-05) — Salto's ElemID is their headline feature.
7. **MCD long-tail coverage gap** (W2-03, W2-04) — Happy Soup's main selling point; sfgraph currently relies on parsed metadata only.
8. **No Tooling SOQL auto-rebatch** (W2-05) — operational gap; users hit HTTP 414/431 at scale.
9. **No `retrieve()`-based OmniStudio extraction** (W2-02) — SOQL misses design-time fields; competitive parity with Salto.
10. **LWC conditional/loop directives missed** (W1-03) — accuracy gap; Salto and Elements.cloud cover them.
11. **`IS_TEST` heuristic from filename, not annotation** (W1-05) — accuracy gap that breaks deploy impact sets.
12. **Apex arity resolution loose** (W1-04) — over-reports `ambiguous`; cleanable.
13. **README misrepresents capabilities** (W1-06) — trust gap.

This milestone (W1+W2+W3) closes every weakness above. **The competitive analysis in PROJECT.md is internally consistent with the Wave scope.**

## Sources

- **PROJECT.md** Validated section — locked existing capabilities (26 MCP tools, 88 edges, antlr4ts, sqlite-vec, env-paths, read-only proxy, four Vlocity parsers, multi-org orchestrator) — HIGH
- **PROJECT.md** Active section — Wave 1/2/3 requirements W1-01..W3-05 — HIGH
- **PROJECT.md** Out of Scope — anti-feature list with rationale — HIGH
- **PROJECT.md** Context — references "Vlocity/OmniStudio head-to-head" and "five-tool competitive analysis (Happy Soup / Salto / SFGE+PMD / MCD / commercial)" — MEDIUM (analyses cited but not in repo; classifications above grounded in publicly known competitor capabilities)
- **Happy Soup** — github.com/forcedotcom/dependencies-cli successor + happysoup.io — public docs: MCD-based, regex Apex (deprecated), lookup/value-set/controlling-picklist gap-fills — MEDIUM
- **Salto** — salto.io / docs.salto.io — NaCl format, ElemID rename stability, retrieve()-based, multi-env diff, selectors — MEDIUM
- **sfdx-scanner / SFGE** — github.com/forcedotcom/sfdx-scanner — SARIF output, PMD integration, symbolic execution path expansion (15-min timeouts) — MEDIUM
- **PMD-Apex** — pmd.github.io — YAML/XML rule schema with `name/message/description/priority/externalInfoUrl/properties/example` fields, SARIF emission — MEDIUM
- **Elements.cloud / Strongpoint / Sherlock / CodeScan / Clayton / Gearset / Copado** — vendor sites — feature parity claims per public marketing — LOW (marketing-grade evidence; classification is directional)
- **MCP spec** — modelcontextprotocol.io — response shape conventions; no SF-specific MCP server in public landscape as of milestone init — MEDIUM

---
*Feature research for: Salesforce metadata graph / dependency analysis tooling (sfgraph hardening + capability expansion milestone)*
*Researched: 2026-05-17*
