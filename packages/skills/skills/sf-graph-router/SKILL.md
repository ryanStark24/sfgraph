---
name: sf-graph-router
description: Start here for ANY Salesforce development, design, or debugging task on an org sfgraph has ingested. Routes intent to the right sfgraph skill + MCP tool, and enforces the grounding-first rule — query the org graph for real schema / dependencies / security / governor facts BEFORE generating or changing Apex, LWC, Flow, or config. Use when the user asks to build, design, refactor, review, or debug Salesforce metadata and you are unsure which skill or tool applies, or when about to write Salesforce code from memory.
triggers:
  - "help me build"
  - "design a"
  - "write a trigger"
  - "write apex"
  - "create an LWC"
  - "refactor this"
  - "review my"
  - "is this safe to deploy"
  - "which sfgraph tool"
  - "where do I start"
  - "debug this"
  - "why is this failing"
tools_used:
  - find_nodes
  - analyze_field
  - find_similar
  - staleness_check
---

# sf-graph-router — start here

sfgraph has a **local, queryable graph of the real org** (every Apex class, LWC, Flow,
field, profile, Vlocity/OmniStudio component, and the edges between them). That graph is
the antidote to the #1 failure of LLM-assisted Salesforce work: **hallucinating field
names, classes, and call chains that don't exist in this org.** This skill decides which
specialised skill/tool to use, and enforces one rule above all.

## The grounding-first rule (non-negotiable)

**Before you generate or modify any Salesforce metadata — Apex, LWC, Flow, validation
rule, permission set — query the graph to ground yourself in what the org actually
contains.** Designing from training data alone is how you invent `Account.Tier__c` when
the org has `Account.Customer_Tier__c`, call a method arity that doesn't exist, or write a
trigger that ignores the three triggers already on the object.

Minimum grounding before writing code that touches object/field `X` or class `Y`:

1. `find_nodes` — confirm the qnames exist (`CustomField:Account.*`, `ApexClass:*Order*`).
2. `analyze_field` — for any field you'll read/write: who already reads/writes it, its type.
3. `find_similar` — is there existing code that already does this? Reuse beats regenerate.
4. For changes to existing Apex: `trace_upstream` (callers / blast radius) + `explain_code`.

If `staleness_check` says the ingest is old, say so — your grounding may be out of date —
and recommend `sfgraph ingest --org <alias>`. If the org isn't ingested at all, say the
grounding step is unavailable and proceed with explicit low-confidence caveats.

Only after grounding do you hand off to a design/knowledge skill (`sf-architect-*`) to
write the code. Ground → design → verify. Never design → hope.

## Route by intent

### DEVELOPMENT — writing or changing code
| Intent | Ground with | Then design with |
|---|---|---|
| "Write/extend Apex on `<Object>`" | `sf-schema-overview` (`<Object>`) + `find_nodes ApexClass:*<Object>*` + `find_similar` | `sf-architect-apex` |
| "Build an LWC for `<feature>`" | `find_similar` (existing LWCs) + `analyze_field` (bound fields) | `sf-architect-ui` |
| "Add an integration / callout" | `find_nodes NamedCredential:*` + `find_similar` | `sf-architect-integrations` |
| "Reuse — is this already built?" | `sf-find-similar` (free-text concept mode) | — |
| "Explain this method/class" | `sf-explain-code` (needs `ApexMethod:Class.m(n)`) | — |

### DESIGN — architecture & data model
| Intent | Skill |
|---|---|
| "Show the data model / ERD for `<Object>`" | `sf-schema-overview` |
| "Trace `<field/LWC/method>` UI → DB" | `sf-cross-layer-trace` |
| "Where is `<field>` used / what writes it" | `sf-flow-impact` (Flow/automation) or `analyze_field` (all layers) |
| "Find duplicate / similar logic to consolidate" | `sf-find-similar` |

### DEBUGGING — something is wrong
| Intent | Skill |
|---|---|
| "This Apex/test fails / this error — why" | `sf-debug-root-cause` |
| "What broke after the last deploy" | `sf-what-broke` |
| "Will my uncommitted change break anything" | `sf-wip-impact` |
| "Blast radius + test gaps of this PR/branch" | `sf-impact-from-diff` |
| "Compare two points in time / snapshots" | `sf-snapshot-compare` |

### QUALITY / GOVERNANCE — review before ship
| Intent | Skill |
|---|---|
| "Governor-limit risks (SOQL/DML in loops)" | `sf-governor-risk-fix` |
| "FLS / sharing / who-has-access audit" | `sf-security-audit` |
| "What's unused / safe to delete" | `sf-dead-code-audit` |
| "Generate a deployment manifest" | `sf-deployment-manifest` |
| "Diff two orgs (sandbox vs prod)" | `sf-cross-org-diff` |
| "Vlocity ↔ OmniStudio migration inventory" | `sf-omnistudio-migration-audit` |
| "Is the graph fresh / how do I refresh" | `sf-metadata-refresh` |
| "Show me the graph visually" | `sf-web-explorer` |

## Disambiguation (commonly confused)
- **Committed vs uncommitted vs post-deploy change analysis:** PR/branch/commit → `sf-impact-from-diff`; uncommitted working tree → `sf-wip-impact`; already deployed, something regressed → `sf-what-broke`.
- **Two orgs vs two snapshots vs one org over time:** different orgs → `sf-cross-org-diff`; named snapshots of one org → `sf-snapshot-compare`; "since last deploy" → `sf-what-broke`.
- **Explain one unit vs trace across layers:** plain-English of one method → `sf-explain-code`; full UI→DB chain → `sf-cross-layer-trace`.

## Don't
- Don't generate Salesforce code before grounding when the org is ingested — that's the whole point of the graph.
- Don't re-implement the routing logic in prose every turn; pick the skill and go.
- Don't block on grounding if the org isn't ingested — degrade gracefully with a stated caveat.
- Don't treat this skill as a destination; it hands off. Its job is selection + the grounding rule.
