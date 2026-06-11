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

## Evidence rule — say it only if something backs it

State a fact about this org or the Salesforce platform **only when evidence backs it**: a tool/graph result, source you actually read (local sfdx file or an org fetch), a live org query, or official Salesforce documentation. If you don't have that, say so plainly — "the graph doesn't show this", "unverified", "I'd need to check the org" — and either go get the evidence or stop. **Never fill the gap with a plausible-sounding guess**: an invented field/method/object name, an assumed dependency, or a governor number recalled from memory. Label each claim as **graph-confirmed** (a tool returned it), **inferred** (you reasoned it from graph facts — say which facts), or **general Salesforce knowledge**. For platform behaviour — governor limits, order of execution, sharing/FLS semantics, API rules — cite the official doc (developer.salesforce.com; fetch it if unsure) instead of asserting from memory. If the graph is stale or the org was never ingested, lead with that caveat — your grounding may be wrong.

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

## When the graph doesn't hold what the analysis needs — pull it from the org

The graph is **metadata structure**, not source code or record data. When an analysis
genuinely needs something the graph doesn't store, fetch it — don't guess and don't analyse
a stub. Two cases, with very different guardrails:

- **Source code & metadata definitions (fetch freely).** The graph stores source for Apex
  methods (`ApexMethod:…`), trigger bodies (`ApexTrigger:…`), and Flow definitions
  (`Flow:…`) — but NOT whole classes, LWC JS, or managed/`(hidden)` code, and some metadata
  isn't ingested. Get the real definition when you need more: read the
  **local sfdx file** (`force-app/main/default/{classes,triggers,flows,objects}/…`) first, else
  retrieve from the org (`sf project retrieve start -m "ApexTrigger:<Name>"` / `Flow:<Name>` /
  `CustomObject:<Name>`, or Tooling `SELECT Body FROM ApexClass WHERE Name='…'`).
- **CONFIG / metadata RECORDS (fetch when needed).** Custom Metadata records, Custom Setting
  rows, picklist/record-type values, Named Credential config — these are deploy-time config,
  not customer data. Pull them with `sf data query -q "SELECT … FROM <Type>__mdt"` (or the
  setting `__c`, or Tooling for record types/picklists) when a trace/debug needs the value the
  config resolves to. (1.4.0+ ingests CMDT/label/setting values into the graph, but older
  graphs or un-ingested types may lack them — fetch then.)
- **BUSINESS SObject records (the bounded EXCEPTION — pull minimally, with care).** sfgraph is
  deliberately **local-first and metadata-only**; actual records (Account/Contact/Opportunity
  rows, etc.) are out of the graph by design, and they are **real, possibly-PII customer data**.
  Only when analysis truly requires it — e.g. to see a misbehaving field's real value shape or
  confirm a data-skew assumption — pull a **small bounded sample**: always `LIMIT` (≤ a handful
  of rows), prefer `COUNT()`/aggregates over raw rows, never bulk-dump, and **tell the user
  you're stepping outside the local-first boundary to read live records**. If aggregates answer
  the question, don't pull rows at all.

State which source you used (graph / local file / org metadata / live records) so the reader
knows the provenance and whether it left the local-only guarantee.

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
| "Read/interpret this debug log / stack trace / 'Too many SOQL' / CPU-time log" | `sf-debug-log-analysis` |
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
