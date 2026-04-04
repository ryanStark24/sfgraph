# Feature Landscape

**Domain:** Salesforce static analysis / metadata dependency graph tool (MCP-native, local/embedded)
**Researched:** 2026-04-03
**Overall confidence:** HIGH (verified against official Salesforce docs, multiple independent SaaS tools, community sources)

---

## Competitive Landscape (What Exists Today)

Understanding what the existing tools do — and where they stop — is essential for categorizing features correctly.

| Tool | Type | Key Capabilities | Critical Gaps |
|------|------|-----------------|---------------|
| **Salesforce "Where is this Used?" button** | Native, free | Custom field references in core metadata types | Custom fields only; no standard fields; no Apex dynamic refs; no Flows deep analysis; no Vlocity |
| **Tooling API MetadataComponentDependency** | Native API, free | Programmatic dependency queries across org | Hard 2,000-record result cap; beta for production; incomplete metadata type support; no Apex parse |
| **forcedotcom/dependencies-cli** | OSS CLI, free | D3.js dependency graph from Tooling API | All Tooling API limitations; no offline/local; limited to 2,000 records; no natural language |
| **Salesforce Code Analyzer (SFDX Scanner v5)** | Official CLI, free | PMD, ESLint, RetireJS, Graph Engine; code quality + security rules | Code quality/security only; not a dependency graph; no cross-type impact ("what breaks?"); no Vlocity |
| **HappySoup.io** | SaaS + OSS, free | Impact analysis UI on top of Dependency API; readable output | Dependency API limitations (2k records, beta, retiring); no offline mode; no Vlocity; no NL query |
| **Elements.cloud** | Commercial SaaS | Rich dependency grid, metadata dictionary, process mining, Agentforce docs | Cloud-based, requires org connection; no local embedding; no MCP integration; expensive |
| **Sweep.io** | Commercial SaaS | NL questions, deterministic dependency graphs, AI docs, impact simulation | Cloud-based, requires org connection; no Vlocity; no offline; no MCP tool surface |
| **Gearset** | Commercial SaaS | Deployment-oriented; dependency detection for safe deploys; tech debt reports | Deployment-focused, not analysis-focused; cloud; expensive; partial Vlocity support only |
| **Salto** | Commercial SaaS / free tier | Full-text search, where-used across all types, metadata comparison | Cloud-required for full features; no NL query; no graph traversal; no Vlocity |
| **DependencyGraphForSF (VS Code ext.)** | OSS, free | Dependency graph for LWC, Aura, VF, Apex, Flows in VS Code | Requires org connection; limited to 3 levels deep; no Vlocity; no NL query; no MCP |
| **Panaya Change Intelligence** | Commercial SaaS | Change impact analysis, risk scoring, automation dependency maps | Cloud-only; expensive; no Vlocity; limited Apex static parse depth |
| **Metazoa Snapshot** | Commercial SaaS | 100+ forgotten asset algorithms, tech debt detection | Cloud-only; deployment-centric; no NL query; no Vlocity |

**Key takeaway:** No existing tool is (a) fully local/embedded, (b) spans Apex + LWC + Flows + Vlocity together, (c) exposes an MCP tool surface for AI clients, and (d) provides confidence-scored answers with source attribution.

---

## Table Stakes

Features users expect from any metadata dependency tool. Missing any of these and developers will not adopt the tool.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Field-level impact query** ("what uses Account.Status__c?") | Every Salesforce developer's #1 pain point; native button is insufficient; every competitor provides this | Medium | Must span Apex, Flows, LWC, Formulas, Validation Rules, Reports — not just one layer |
| **Apex class dependency graph** (class A calls class B) | Foundation of any Salesforce static analysis; Code Analyzer, Gearset, and DependencyGraphForSF all do this | Medium | Must include trigger → handler, utility class chains, abstract/interface implementations |
| **Flow dependency tracing** (which objects/fields does a Flow touch?) | Flows are the dominant automation mechanism in modern orgs; 300+ flows typical in enterprise orgs | Medium | Record Create/Update/Delete ops, GetRecords, Decision elements, Apex calls from flows |
| **LWC dependency mapping** (which Apex methods / child components does a component use?) | LWC is the mandatory UI layer; wire adapters and imperative calls both matter | Medium | Wire decorators, imperative @AuraEnabled calls, child component composition |
| **Reverse traversal** ("who calls this Apex method?") | Developers need to know callers before refactoring; uni-directional lookup is table stakes but bi-directional is the actual need | Medium | Requires graph store; pure Dependency API cannot do this |
| **SObject / Field metadata node representation** | All dependency relationships anchor to SObjects and fields; missing these makes the graph unusable | Low | Standard + custom objects; relationship fields; formula fields |
| **Cross-type dependency query** ("show everything that touches Opportunity.StageName") | This is the "what breaks?" query; the single most-requested capability in the Salesforce community | High | Must unify Apex parse + Flow XML parse + LWC parse in a single result |
| **Source attribution** (file path + line number for each reference) | Developers need to navigate to the exact line; without this, results are unusable for actual fixes | Medium | contextSnippet (1-3 lines) makes answers actionable, not just directional |
| **Incremental refresh** (re-ingest only changed files) | Cold ingest of 2k+ classes takes minutes; developers will not tolerate full re-ingest on every save | High | SHA-256 file hashing; dirty-file detection; affected-node re-traversal |
| **CLI entrypoint / MCP server** | Modern developer tooling; any tool that only runs as a web app loses developer trust | Low | Must work headless; MCP enables AI client integration |
| **Custom Label / Custom Setting / Custom Metadata usage** | Ubiquitous in enterprise orgs; developers constantly ask "who reads this label?" | Medium | All three types; Apex reads, Flow references, formula field references |

---

## Differentiators

Features that set this tool apart from everything in the competitive landscape. Not expected by users today, but immediately recognized as high-value once experienced.

| Feature | Value Proposition | Complexity | Competitive Gap |
|---------|------------------|------------|-----------------|
| **Unified Vlocity/OmniStudio dependency graph** (IP, OmniScript, DataRaptor, FlexCard) | No existing tool provides static analysis of Vlocity DataPack internals and their relationships to Apex/Objects; Gearset handles deployment but not analysis | High | Gearset does deployment only; no other tool parses DataRaptor mappings or IP element chains |
| **Natural language query via MCP** ("what breaks if I delete this field?") | Developers ask questions in English; today they must manually cross-reference 5 different tool outputs | High | Sweep does NL but is cloud-only and not MCP-native; no OSS/local equivalent exists |
| **Confidence-tiered answers** (Definite / Probable / Review manually) | Static analysis has inherent ambiguity (dynamic Apex, runtime polymorphism); transparent confidence prevents false security | Medium | No existing tool surfaces per-edge confidence; all tools present results as binary found/not-found |
| **Fully local / air-gapped operation** | Enterprise orgs cannot push metadata to a SaaS vendor; security/compliance requirements block all cloud tools | High | Every commercial tool requires cloud connectivity and org credential storage |
| **Variable Origin Tracer with cycle detection** | Tracks how a field value flows through method chains (getter → utility → caller); not just direct references | High | No existing tool performs data-flow tracing through Apex method chains for field references |
| **Formula field and validation rule parser** | Formula fields create hidden dependencies (field A computed from field B); validation rules are automation that most tools miss | Medium | Elements.cloud partially covers this; no OSS tool does it |
| **Platform Event + PlatformEventSubscriberConfig nodes** | Platform Events are first-class integration points; developers need to know what triggers and what subscribes | Medium | Most tools miss the pub/sub topology entirely |
| **Edge-level context snippets** | Each dependency edge carries a 1-3 line source excerpt from the actual code/XML; answers are actionable, not just directional | Low | HappySoup shows component names only; no tool shows the actual line of code causing the dependency |
| **Dynamic Accessor Registry (YAML-configurable utility mapping)** | Org-specific utility methods (e.g., `FieldUtils.get()`) bypass standard reference detection; configurable registry solves this | Medium | No existing tool is configurable for org-specific accessor patterns |
| **Iterative query self-correction** (Cypher error feedback loop, max 4 iterations) | Graph queries against complex schema fail silently or produce wrong results; self-correction delivers reliable answers | High | Unique to LLM-powered query pipelines; no competing tool does this |
| **Three-tier query pipeline with Schema Filter** (Haiku → Sonnet → Sonnet) | Schema Filter reduces token cost 20-40x by pre-selecting relevant schema before query generation; makes NL queries economically viable at scale | High | Novel architecture; most LLM-over-DB tools inject full schema into every query |
| **Embedded graph store (FalkorDB)** with GraphStore abstraction | No external graph DB service required; graph + vector index + manifest all run in-process | High | Commercial tools use hosted graph infra; OSS tools use flat Tooling API responses |
| **File watcher real-time mode** (2s debounce, watchdog) | Graph stays current during active development without manual re-ingest commands | Medium | No existing tool offers sub-5s graph updates during local development |
| **`explain_field` MCP tool** (full field biography: definition + all consumers + all writers) | Single-tool answer to "tell me everything about this field" across all metadata types | Low | Simple MCP wrapper around a pre-built traversal; high perceived value for minimal implementation cost |
| **`get_ingestion_status` MCP tool** | Developer can check ingestion progress and errors without leaving their AI client | Low | Operational visibility missing from all OSS tools |
| **PyPI-publishable OSS package** | Zero-friction install (`pip install sf-org-graph`) for the Salesforce developer community | Low | No comparable OSS tool with a proper PyPI package for local graph-based analysis |
| **Picklist false-positive guard** | Picklist value references generate massive false positives without field context; under-reporting is safer than over-reporting | Medium | No existing tool addresses this; Dependencies API has known false-positive issues with picklists |

---

## Anti-Features

Things to deliberately NOT build in v1. These are either out-of-scope traps, premature complexity, or features that require runtime data the tool cannot have.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Deployment tooling** (push/pull metadata, create packages) | Gearset, Copado, Blue Canvas already do this well; adding it turns a focused analysis tool into a bloated DevOps platform | Document that this tool is read-only; recommend pairing with Gearset/SF CLI for deployment |
| **Visualforce page parsing** | Legacy; enterprise architects are migrating away from VF; parsing cost high, user value low in 2026 | Stub nodes for VF pages found in metadata; do not parse internals |
| **Aura component parsing** | LWC-first policy; Aura is legacy; tree-sitter grammar is immature for Aura | Stub nodes for Aura components; note in docs |
| **Live org runtime analysis** (execution traces, SOQL query plans, debug logs) | Requires org connectivity; defeats the local/embedded value prop; massive scope expansion | Recommend Salesforce Inspector or Developer Console for runtime concerns |
| **Permission Set / Profile FLS graph** | Valid v2 feature, but FLS graph adds 10x edge volume; query complexity explodes; performance degrades | Mark as v2 in roadmap; design graph schema to accommodate it later |
| **Risk scoring layer** | Needs a precomputed traversal cache (v1.5 feature) to be performant; building it in v1 produces slow unreliable scores | Confidence tiers (Definite/Probable/Review) are the v1 risk signal; full scoring is v2 |
| **Graph versioning / org snapshots** | Interesting feature; needs significant additional storage and diffing logic; not needed to answer "what breaks today?" | Incremental refresh with file hashes gives change awareness; true versioning is v1.5 |
| **Multi-org federation** | Dramatically increases complexity; most users have one primary org | Single-org first; multi-org is v2+ |
| **Web UI / dashboard** | MCP + CLI are the correct interface for this audience (developers and architects); web UI is scope bloat | MCP is the UI; let Claude/Cursor/Copilot be the frontend |
| **Managed package internals** | Source is not in the metadata export; attempting to parse managed packages produces incorrect stubs | Represent managed packages as ExternalNamespace stub nodes; document the limitation clearly |
| **AppExchange distribution** | AppExchange requires org connectivity and Salesforce review; incompatible with local/embedded architecture | PyPI is the distribution channel; OSS GitHub is the discovery channel |
| **Test coverage overlay** (which tests cover which Apex) | Valid feature; requires either runtime data (test execution results) or complex control-flow analysis; v2 | Note in docs: pair with native Salesforce code coverage reporting for this concern |
| **Automatic org metadata export** (connect directly to a live org) | Org connectivity = cloud dependency = security/compliance bloat; the tool ingests a static export | Document: "run `sf project retrieve start` first, then ingest the local export" |

---

## Feature Dependencies

The implementation order is constrained by the following dependency chain:

```
Graph Schema DDL (nodes + edges)
  → Two-phase ingestion (nodes-only pass first)
    → Parser pool: Apex (tree-sitter-sfapex)
    → Parser pool: LWC JS (tree-sitter-javascript)
    → Parser pool: LWC HTML (lxml)
    → Parser pool: Flow XML (ElementTree)
    → Parser pool: Object/Field XML (ElementTree)
    → Parser pool: Custom Label/Setting/CMT XML
    → Parser pool: Platform Event XML
    → Parser pool: Vlocity DataPack JSON
    → Edge discovery pass (requires all nodes to exist)
      → Variable Origin Tracer (requires Apex edges)
      → Formula field parser (requires SFField nodes)
      → Picklist false-positive guard (requires SFField + SFPicklistValue nodes)
        → SQLite manifest (tracks ingestion state)
          → Incremental refresh (requires manifest)
            → File watcher (real-time mode; requires incremental refresh)

MCP server (ingest_org, refresh)
  → query, get_node, explain_field, get_ingestion_status
    → Three-agent query pipeline
      → Schema Filter (Haiku)
        → Cypher Query Generator (Sonnet)
          → Iterative correction loop (max 4 iterations)
            → Result Formatter (Sonnet) with TRAVERSE/ANSWER contract
              → Confidence tier output (Definite/Probable/Review manually)
```

**Critical path insight:** The query pipeline is completely blocked until at least one metadata type is fully ingested with a working graph schema. Apex is the highest-value first parser because it unlocks cross-class dependency analysis, which is the #1 use case.

---

## MVP Recommendation

An MVP that delivers real developer value and validates the core concept requires:

**Priority 1 — Must ship in v1 core:**
1. Graph schema DDL with all node/edge types (foundation for everything)
2. Two-phase ingestion pipeline with Apex parser (the highest-value single parser)
3. Flow XML parser (the second-most-referenced automation type)
4. SObject/Field metadata parser (dependency anchors)
5. MCP server: `ingest_org`, `query`, `get_node` tools
6. Three-agent query pipeline with confidence tiers
7. `explain_field` tool (high perceived value, low cost once graph exists)
8. Incremental refresh (mandatory for developer workflow adoption)
9. SQLite manifest for file-hash tracking

**Priority 2 — Complete v1 by adding these before release:**
10. LWC JS + HTML parsers (enables UI-layer dependencies)
11. Custom Label/Setting/CMT parsers
12. Platform Event parser
13. Vlocity DataPack parsers (IntegrationProcedure, OmniScript, DataRaptor)
14. `refresh` and `get_ingestion_status` MCP tools
15. File watcher real-time mode
16. PyPI packaging + README + contributor docs

**Defer to v1.5:**
- Graph versioning / snapshots
- Precomputed traversal cache (prerequisite for risk scoring)

**Defer to v2:**
- Permission Set / FLS graph layer
- Risk scoring layer
- Test coverage overlay
- Multi-org support

---

## Feature Comparison vs. Existing Tools

| Feature | This Tool | Tooling API / dependencies-cli | HappySoup | Elements.cloud | Sweep | Gearset | SFDX Scanner |
|---------|-----------|-------------------------------|-----------|---------------|-------|---------|--------------|
| Local/offline/air-gapped | YES | No | No | No | No | No | Yes (CLI only) |
| MCP tool surface | YES | No | No | No | No | No | No |
| Natural language query | YES (via MCP + LLM) | No | No | Limited (docs gen) | Yes (cloud) | No | No |
| Apex parsing (static) | YES (tree-sitter) | API-based only | API-based | API-based | Cloud AI | API-based | Yes (PMD) |
| LWC parsing | YES (tree-sitter + lxml) | API-based | Partial | API-based | Cloud AI | API-based | Yes (ESLint) |
| Flow XML parsing | YES (full element parse) | API-based | API-based | API-based | Cloud AI | API-based | Yes (FlowScanner) |
| Vlocity/OmniStudio | YES (all 4 types) | No | No | No | No | Deployment only | No |
| Confidence tiers | YES (Definite/Probable/Review) | No | No | No | No | No | No |
| Edge context snippets | YES (source line + excerpt) | No | No | No | No | No | No |
| Variable Origin Tracer | YES (depth=5, cost=50) | No | No | No | Unknown | No | Partial (Graph Engine) |
| Formula field dependencies | YES | Partial | Partial | Yes | Partial | No | No |
| Platform Events | YES | API-based | Partial | Partial | Unknown | No | No |
| Incremental refresh | YES (SHA-256 manifest) | No | No | Unknown | Cloud-managed | Cloud-managed | No |
| Open source | YES (PyPI) | Yes (archived) | Yes (partial) | No | No | No | Yes |
| 2,000 record limit | None (local graph) | YES (hard limit) | YES (inherited) | None (cloud) | None (cloud) | None (cloud) | N/A |
| Price | Free / OSS | Free | Free | $$$$ | $$$$ | $$$$ | Free |

---

## Sources

- [Salesforce Ben: 4 Free Impact Analysis Tools](https://www.salesforceben.com/salesforce-impact-analysis-tools/) — MEDIUM confidence (community editorial)
- [Salesforce Tooling API: MetadataComponentDependency](https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_metadatacomponentdependency.htm) — HIGH confidence (official)
- [forcedotcom/dependencies-cli GitHub](https://github.com/forcedotcom/dependencies-cli) — HIGH confidence (official Salesforce OSS)
- [Elements.cloud: Mastering Org Dependencies](https://elements.cloud/blog/how-to-master-org-dependencies-in-salesforce/) — MEDIUM confidence (vendor blog, verified against tool capabilities)
- [Sweep: Downstream Impact Analysis](https://www.sweep.io/blog/understanding-downstream-impact-before-you-ship-in-salesforce/) — MEDIUM confidence (vendor blog)
- [Salesforce Code Analyzer Overview](https://developer.salesforce.com/docs/platform/salesforce-code-analyzer/overview) — HIGH confidence (official)
- [Salesforce Ben: DevOps State 2026](https://www.salesforceben.com/most-common-devops-struggles-across-the-salesforce-ecosystem/) — MEDIUM confidence (community survey)
- [Gearset: Apex Dependency Support](https://gearset.com/blog/apex-dependency-support/) — MEDIUM confidence (vendor blog, verified against product)
- [Vlocity Build Tool GitHub](https://github.com/vlocityinc/vlocity_build) — HIGH confidence (official Vlocity/Salesforce OSS)
- [Gearset: Deploying Vlocity DataPacks](https://docs.gearset.com/en/articles/5821967-deploying-salesforce-metadata-and-vlocity-data-packs-together) — MEDIUM confidence (vendor docs)
- [Salesforce DX MCP Server introduction](https://developer.salesforce.com/blogs/2025/06/introducing-mcp-support-across-salesforce) — HIGH confidence (official Salesforce blog)
- [DependencyGraphForSF VS Code Extension](https://marketplace.visualstudio.com/items?itemName=FernandoFernandez.dependencygraphforsf) — MEDIUM confidence (marketplace listing)
- [Salto: Where Is This Used for SF](https://help.salto.io/en/articles/6926958-salesforce-where-is-this-used-functionality-for-standard-and-custom-fields) — MEDIUM confidence (vendor help docs)
- [Salesforce Ben: 1 Billion Metadata Items Analysis](https://www.salesforceben.com/10-things-we-learnt-from-analyzing-1-billion-salesforce-metadata-items/) — MEDIUM confidence (community research)
