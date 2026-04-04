# Domain Pitfalls

**Project:** Salesforce Org Graph Analyzer MCP Tool
**Domain:** Local embedded graph analyzer + MCP server + tree-sitter parser + multi-agent LLM query pipeline
**Researched:** 2026-04-03
**Overall confidence:** HIGH (verified against official docs, GitHub issues, and primary sources)

---

## Critical Pitfalls

Mistakes that cause rewrites, data corruption, or complete rearchitecting.

---

### Pitfall 1: FalkorDBLite Is Not Python 3.11-Compatible

**What goes wrong:** The project constraint is Python 3.11+, but FalkorDBLite's PyPI package hard-requires Python **3.12 or higher**. Attempting to install on 3.11 fails at install time, not at runtime. This is a hidden conflict between the project's stated minimum and the library's actual minimum.

**Why it happens:** FalkorDBLite uses Python 3.12 internals (likely `tomllib` standard module and newer C extension ABI features). The PyPI metadata enforces this.

**Consequences:** Anyone running `uv` with `requires-python = ">=3.11"` in pyproject.toml will see a dependency resolver error or, worse, an ambiguous runtime crash if the constraint is not enforced in lockfile generation.

**Prevention:**
- Immediately update `requires-python = ">=3.12"` in pyproject.toml.
- Pin the exact Python version in `.python-version` (used by `uv` for environment creation).
- Document this constraint explicitly in CONTRIBUTING.md and the PyPI README.

**Detection:** `uv sync` will fail with a dependency conflict. Catch this in Phase 1 setup before any other code is written.

**Phase:** Phase 1 (environment bootstrap / dependency lock).

---

### Pitfall 2: Stdout Pollution Corrupts the MCP stdio Transport

**What goes wrong:** The MCP Python SDK uses stdio as the transport layer. **Any byte written to stdout** — a stray `print()`, a logging statement that defaults to stdout, a progress bar writing to stdout, a library that emits startup text — corrupts the JSON-RPC framing. Claude Desktop or Cursor silently drops the session or produces garbled responses with no obvious error message.

**Why it happens:** MCP stdio is a length-prefixed or newline-delimited JSON stream. Any non-JSON byte (e.g., `"Ingesting 2342 files..."`) inserted into stdout breaks framing for subsequent messages. The MCP client has no way to resynchronize.

**Consequences:** The server appears to hang or silently fails. Debugging is extremely hard because the symptom (client timeout) is far removed from the cause (a single `print()` added during development).

**Prevention:**
- Enforce at the top of the server entry point: redirect all logging to `sys.stderr` unconditionally before any imports that might configure logging.
- Add a `no_stdout` CI check: a custom pytest fixture that captures stdout and asserts it is empty after every tool call.
- Use `logging.basicConfig(stream=sys.stderr)` and never call `print()` in the server process.
- Libraries like `tqdm` default to stderr — verify before use.
- The FalkorDB Redis subprocess (embedded in FalkorDBLite) may itself emit startup text to stdout on first launch. Redirect subprocess stdout to a log file or `/dev/null` during initialization.

**Detection:** The MCP inspector (`@modelcontextprotocol/inspector`) will immediately show malformed JSON frames. Always test with it before testing with an actual LLM client.

**Phase:** Phase 2 (MCP server skeleton) — establish the constraint before any tool handlers are written.

---

### Pitfall 3: FalkorDBLite Is a Redis Subprocess, Not a True Embedded Library

**What goes wrong:** FalkorDBLite is marketed as "SQLite-style embedded" but it actually spawns a **child Redis process** with the FalkorDB module loaded. This has several hidden implications:
- It adds a Redis process to the system process table while the MCP server is running.
- It requires `libomp` on macOS (the OpenMP runtime). Without it, the child process crashes with a dylib not found error. This will happen on every new developer machine and every CI runner without explicit setup.
- Thread safety is **undocumented**. Concurrent writes from multiple asyncio tasks could corrupt the graph if not serialized.
- If the parent Python process is killed (SIGKILL), the Redis child may be orphaned and continue running, holding the data file locked.

**Why it happens:** FalkorDB is a Redis module. Embedding it means embedding Redis. The "zero-config" abstraction hides this.

**Consequences:**
- Cold starts on macOS CI fail without `brew install libomp` in the CI setup step.
- Developer onboarding silently breaks on Apple Silicon without Homebrew libomp.
- Concurrent writes (e.g., parallel ingestion workers all calling `graph.query()`) will corrupt data or deadlock without a serialization layer.
- Zombied Redis processes accumulate in long-running test suites that create/destroy FalkorDB instances without proper teardown.

**Prevention:**
- Add a startup healthcheck that verifies the Redis subprocess launched cleanly (ping the connection before accepting any work).
- In the GraphStore abstraction, serialize all writes through a single asyncio-safe queue with a dedicated writer coroutine. Never call `graph.query()` concurrently with writes.
- In CI, add `brew install libomp` as an explicit step and document it in CONTRIBUTING.md.
- In teardown, explicitly call `db.close()` (or equivalent) and verify the child process terminates with `psutil`.
- Register a Python `atexit` handler to kill the Redis subprocess on interpreter exit.

**Detection:** macOS CI will fail with `Library not loaded: /opt/homebrew/opt/libomp/lib/libomp.dylib`. Monitor for zombie Redis processes with `ps aux | grep redis` after test suite runs.

**Phase:** Phase 1 (GraphStore implementation). Write the serialization layer before writing any ingestion code.

---

### Pitfall 4: tree-sitter-sfapex Has Known Parse Failures on Legitimate Apex Patterns

**What goes wrong:** tree-sitter-sfapex (the only production-grade Apex parser available) has documented parse failures on:
- **Inherited class constructors** (Issue #60, Dec 2024): Classes that call `super()` constructors in certain patterns produce incorrect CST node structures.
- **Standalone semicolons** (Issue #45, Nov 2024): `;;` or semicolon-only statements in certain contexts are not parsed correctly.
- **For-loop init nodes** (Issue #44, Nov 2024): The `for_statement` `init` node structure does not match expected shape in some iterator patterns.
- **SOSL syntax** (Issue #55, Dec 2024): Certain SOSL queries inside Apex methods fail to parse.
- **Web/Node.js `__dirname` resolution** (Issue #66, Oct 2025): The Node.js package has a module resolution bug when run from certain working directories.

**Why it happens:** tree-sitter-sfapex is a community-maintained grammar, not an Apex-team product. Salesforce's Apex has unusual constructs (database operations as expressions, trigger context variables, `Database.SaveResult[]` patterns) that don't map cleanly to tree-sitter's generic grammar framework.

**Consequences:**
- Parse failures produce `ERROR` nodes in the CST. If the traversal code blindly assumes clean CSTs, it will silently produce incomplete edges (no exception, just missing relationships).
- Inherited class constructors are extremely common in fflib/enterprise Apex (every Service extends `fflib_SObjectDomain`). This pattern failing means relationship discovery for a large fraction of enterprise orgs is incomplete without fallback handling.
- For-loop patterns are used in bulkification code (the most critical Apex pattern for governor limit compliance). Missing these edges makes the "what breaks" answer wrong.

**Prevention:**
- Wrap all tree-sitter query operations with explicit `ERROR` node detection. If `root_node.has_error` is true, log the file and continue — never hard-fail ingestion on a single file.
- Build a parse-failure corpus from real Apex files and run it against the grammar before shipping. Capture the `ERROR` node locations in the manifest for later re-ingestion when the grammar is updated.
- For the `__dirname` issue in Node.js: always launch the worker pool with an explicit `cwd` and use `path.resolve(__dirname, ...)` with the WASM path explicitly specified at startup.
- Subscribe to tree-sitter-sfapex releases and run the test corpus on every grammar update to detect regressions.

**Detection:** Log `has_error: true` for each parsed file during ingestion. Any enterprise Apex codebase will have 5-20% error rate on the current grammar. A rate above 30% indicates a grammar version regression.

**Phase:** Phase 2 (parser implementation). Build error detection and corpus validation before writing relationship extraction logic.

---

### Pitfall 5: Qdrant Local Mode Caps at ~20,000 Vectors and Uses Brute-Force Search

**What goes wrong:** Qdrant's local (in-process) mode is **not HNSW-indexed**. It uses O(n) brute-force search. The library itself warns when a collection exceeds 20,000 points. A large Salesforce org (2k+ classes, 800 LWC, 300 Flows, 200 Vlocity) with source chunks of ~50 chunks per file easily produces 150,000-300,000 vectors. At that scale, local mode makes every vector search a multi-second sequential scan.

**Why it happens:** Local mode is explicitly designed for testing and small datasets. HNSW and quantization are server-only features.

**Consequences:**
- The sub-5s query latency target is impossible to meet at full scale with local mode.
- If the team ships local mode and only discovers the performance cliff during integration testing with a real large org, switching to Qdrant server mode requires infrastructure changes (Docker or a persistent service) that break the "no external services" constraint.

**Prevention:**
- Scope Qdrant local mode explicitly to small orgs (< 500 files). Document the scale limit in the README.
- Design the `VectorStore` abstraction to support both local mode (for testing) and a lightweight Qdrant on-disk server mode (for production). The Qdrant Python client API is identical for both — only the connection URL changes.
- For production embedded use, run Qdrant as a subprocess (like FalkorDBLite runs Redis), not via the local Python client. This gives HNSW indexing within the "no external services" constraint.
- Alternatively, chunk size reduction (smaller, more targeted snippets) keeps vector count under the 20k limit for medium orgs — but this is a false economy for large orgs.

**Detection:** Collection.count() > 20,000 triggers a Qdrant client warning in logs. Watch for this in ingestion output.

**Phase:** Phase 3 (vector index integration). Design the abstraction boundary before writing the first embedding call.

---

## Moderate Pitfalls

Mistakes that cause significant rework but not full rewrites.

---

### Pitfall 6: Cypher Generation Hallucinates Node Labels and Relationship Types Not in the Schema

**What goes wrong:** LLMs generating Cypher (Agent 2 — Query Generator) will invent plausible-sounding but non-existent node labels (e.g., `ApexMethod` instead of `ApexClass`, or `CALLS_FLOW` instead of `INVOKES_FLOW`) if the schema context is incomplete, stale, or too large to fit in context. FalkorDB silently returns 0 results for queries referencing non-existent labels rather than raising an error, making hallucinations invisible to the correction loop.

**Why it happens:** The schema for this project is large (15+ node types, 25+ relationship types). Schema Filter Agent (Agent 1) reduces context but may exclude relevant labels when the user's question spans multiple domains. The LLM then pattern-matches on its training data rather than the actual schema.

**Consequences:**
- Agent 3 (Result Formatter) receives empty result sets, which it interprets as "no relationships found" — producing confident but wrong answers ("nothing breaks if you change this field").
- The correction loop cannot fix this because FalkorDB returns `[]` (no error, no signal that the label was invalid).

**Prevention:**
- After generating a Cypher query, **validate node labels and relationship types** against the actual schema before execution. FalkorDB provides `CALL db.labels()` and `CALL db.relationshipTypes()` — run these once at startup and cache them. Reject any query referencing unknown labels and feed the valid label list back to the generator.
- Include the full relationship taxonomy (just types and directions, not properties) in the Schema Filter output even when the filtered schema is narrow — the type list is small (< 500 tokens) and prevents most hallucinations.
- In the iterative correction loop (max 4 iterations), the error message fed back to the LLM must include the list of valid labels when a label mismatch is detected.

**Detection:** Add a query validator that checks generated Cypher against `CALL db.labels()` before execution. Log label mismatches as `HALLUCINATION` events in the trace. A rate above 20% per session indicates schema context is insufficient.

**Phase:** Phase 4 (query pipeline). Implement label validation in the first correction loop iteration.

---

### Pitfall 7: FalkorDB Missing Cypher Features That the LLM Will Try to Use

**What goes wrong:** FalkorDB does not support several Cypher features that are in Neo4j and that LLMs frequently generate:
- **Regex operator** (`=~`): String pattern matching via regex is unsupported. LLMs trained on Neo4j examples will emit `WHERE n.name =~ '.*Apex.*'` and it will fail.
- **Label expressions** in MATCH: Complex label predicates like `MATCH (n:ApexClass|LWCComponent)` are unsupported.
- **User-defined functions**: No `apoc.*` or custom function calls.
- **Temporal arithmetic**: `duration()`, `date()` arithmetic unsupported. This matters for `lastIngestedAt` comparisons.
- **DELETE vs DETACH DELETE difference**: FalkorDB implements all DELETE as DETACH DELETE — accidentally deleting a node in a correction step will cascade-delete all its edges silently.

**Why it happens:** FalkorDB implements its own Cypher dialect (openCypher 9 + extensions) rather than full Neo4j Cypher compatibility.

**Consequences:**
- LLMs generate regex or label-expression Cypher constantly (these are standard Neo4j patterns). Without a filter, the correction loop will exhaust all 4 iterations on syntax errors that cannot be corrected within the LLM's context because the feature simply doesn't exist.
- Accidental cascade-delete during correction could corrupt the graph.

**Prevention:**
- Add a **Cypher syntax pre-validator** that strips or rewrites known-unsupported patterns before execution: replace `=~` with `CONTAINS`/`STARTS WITH`, reject OR-label MATCH, replace `DETACH DELETE` with safe node marking.
- Include FalkorDB-specific dialect notes in the Schema Filter Agent system prompt: "Do NOT use regex operator (`=~`). Do NOT use label expressions. Use CONTAINS for string matching."
- Never expose DELETE or MERGE operations to the query pipeline — query tools are read-only. Only the ingestion layer writes to the graph.

**Detection:** Parse generated Cypher for `=~` operator before execution. Log all queries that contain unsupported patterns as `DIALECT_ERROR`.

**Phase:** Phase 4 (query pipeline). Build the dialect filter as a pre-execution validation step.

---

### Pitfall 8: Vlocity DataPack JSON Has No Stable Schema — Structure Varies by Salesforce Org Version and DataPack Type

**What goes wrong:** Vlocity DataPacks are stored as JSON blobs, but the JSON structure for IntegrationProcedure, OmniScript, and DataRaptor **differs between Salesforce orgs** depending on when the component was last edited, which version of OmniStudio is installed, and whether the component was migrated from Vlocity Classic. The `%vlocity_namespace%` placeholder appears throughout keys and values. Fields like `Order`, `Level`, and `Version` are present or absent depending on export tooling version.

**Why it happens:** DataPacks are Salesforce object records exported as JSON, not true metadata. The structure reflects the underlying SObject schema, which evolves across OmniStudio versions. The vlocity_build tool has modified the format over time (e.g., removing `Order` and `Level` fields).

**Consequences:**
- A parser written against one org's DataPack format will silently fail on another org's format, producing 0 DataRaptor or OmniScript nodes without any error — just missing graph coverage.
- The `%vlocity_namespace%` namespace placeholder must be resolved before any key comparison, or every namespace-qualified reference will fail to match.

**Prevention:**
- Treat DataPack parsing as schema-optional: always check for key existence before accessing, never assume field presence.
- Write a DataPack normalizer that resolves `%vlocity_namespace%` to the actual namespace (typically `vlocity_cmt`, `vlocity_ps`, or `vlocity_ins`) or strips the placeholder for matching purposes.
- Build the parser against multiple sample DataPack formats from the vlocity_build GitHub repo test fixtures, not just one export.
- Implement a `PARSE_WARNING` event when expected keys are absent, rather than silently skipping.

**Detection:** After ingestion, check that the count of `IntegrationProcedure`, `OmniScript`, and `DataRaptor` nodes matches the file count in the DataPack export directory. A zero count when files are present means the parser is not matching the format.

**Phase:** Phase 2 (Vlocity parser). The normalizer must be built before relationship extraction.

---

### Pitfall 9: Node.js Worker Pool Memory Growth Is Unbounded Without Active Ceiling Enforcement

**What goes wrong:** The project spec calls for a 200-file memory ceiling on the Node.js subprocess pool. This is necessary because tree-sitter compiled code (grammar artifacts, CST allocations) is not garbage collected across parses in a long-lived worker. Worker threads accumulate compiled code memory that the V8 GC does not collect. After ~200 files, a single worker may hold 400-600 MB of heap.

**Why it happens:** Multiple long-standing Node.js issues document this: compiled code leaked from workers is not freed even after the task completes (nodejs/node #40878, #27998). The V8 JIT compiles hot parse paths and retains the compiled code indefinitely.

**Consequences:**
- Without the ceiling, a 2,000-file Apex corpus will exhaust available RAM mid-ingestion (~halfway through), causing the pool to crash or the OS to invoke OOM killer.
- Worker crashes from OOM appear as broken pipe errors on the Python side, producing partial ingestion with no obvious error message about memory.

**Prevention:**
- Implement task counting per worker. After `N=200` parse tasks, gracefully terminate the worker and spawn a fresh one. The grammar reload cost (~50ms) is negligible compared to OOM recovery.
- Set a hard `max-old-space-size` on each worker: `new Worker(script, { workerData: {...}, resourceLimits: { maxOldGenerationSizeMb: 512 } })`.
- Monitor worker heap usage with `process.memoryUsage()` inside the worker after each parse and send it back to the pool manager as a health metric.
- Log `WORKER_RECYCLED` events so the Python orchestrator can track recycling frequency during profiling.

**Detection:** Pool manager logs `WORKER_RECYCLED` events. If recycling happens more frequently than every 200 files, the ceiling is too high or grammar memory usage is larger than expected.

**Phase:** Phase 2 (Node.js pool). Implement ceiling from the start — do not add it later as an optimization.

---

### Pitfall 10: Two-Phase Ingestion Must Commit Nodes Before Any Edge Pass Begins — Atomicity Boundary Is Critical

**What goes wrong:** The two-phase design (nodes-only first, then edges) eliminates forward-reference ordering. But if the node phase is interrupted (crash, SIGINT) mid-way and the edge phase starts from a partial node set, edges will reference non-existent nodes. FalkorDB will either create dangling relationships or silently drop the edge depending on query structure.

**Why it happens:** The ingestion pipeline is stateful. Without an explicit commit boundary, a restart or partial failure can leave the graph in a half-seeded state where some nodes exist and others don't, making edge resolution non-deterministic.

**Consequences:**
- Dangling edges produce incorrect traversal results: `MATCH (a)-[:CALLS]->(b)` returns `b=null` patterns or silently excludes the edge depending on the Cypher variant.
- Re-ingesting after a crash without clearing the graph first produces duplicate nodes (if MERGE is not used consistently) or duplicate edges.

**Prevention:**
- Use a SQLite manifest transaction to track phase completion: `phase_1_complete: bool`, `phase_2_complete: bool`. Only start the edge pass after phase 1 is committed to the manifest.
- Use `MERGE` (not `CREATE`) for all node creation to make the node phase idempotent.
- On startup, check the manifest for a broken ingestion state and offer a `--reset` mode before continuing.
- The incremental refresh must also honor this boundary: dirty-file re-ingestion updates nodes first, then re-runs the edge discovery for affected nodes only.

**Detection:** On startup, check `phase_1_complete AND NOT phase_2_complete` in the manifest — this indicates a crashed ingestion. Log `INGESTION_INCOMPLETE` and prompt for `--reset`.

**Phase:** Phase 2 (ingestion pipeline). The phase boundary check must be in the manifest schema from day one.

---

### Pitfall 11: MCP Tool Responses With Large Datasets Cause Client-Side Context Overflow and Timeouts

**What goes wrong:** MCP tool results are returned as text content to the LLM client. If a query result contains 500 nodes and 2,000 edges (e.g., "what does the Order module depend on?"), the JSON response bloats to 50-200 KB. This exceeds Claude Desktop's context budget for tool results, causing the client to truncate or timeout.

**Why it happens:** MCP has no built-in pagination. A tool that returns an unbounded result set will return the full set in a single response. The LLM client cannot stream or paginate MCP tool results.

**Consequences:**
- Large orgs with deep dependency trees produce tool responses that are silently truncated by the client, creating the appearance that the tool returned a partial answer.
- Claude Desktop may timeout waiting for very large JSON payloads, appearing to the user as a hung tool call.

**Prevention:**
- The `query` tool must enforce a hard result limit (e.g., 50 nodes max, 100 edges max) and return a `RESULT_TRUNCATED: true` flag with a count of total matches.
- The `TRAVERSE` path in Agent 3's structured output contract already has `hop_budget=3` — enforce it as a hard query limit, not just a recommendation.
- For large result sets, provide a `get_node(id)` drill-down tool rather than including all node details in the initial response.
- Test all tools with the MCP inspector under adversarial inputs (broad queries) before release.

**Detection:** Monitor response payload size in tool handlers. Log a `RESPONSE_TRUNCATED` warning when result count is capped.

**Phase:** Phase 4 (query pipeline) and Phase 5 (MCP tool schema). Add size limits to every tool handler before any LLM testing.

---

## Minor Pitfalls

---

### Pitfall 12: Salesforce Flow XML Has Multiple Structural Variants That Break a Single-Schema Parser

**What goes wrong:** Flow XML contains `<processMetadataValues>` sections, `<FlowRecordFilter>` blocks, and `<FlowApexPluginCallInputParameter>` elements that appear in some Flow types but not others. Screen Flows have `<screens>` elements absent in autolaunched Flows. Scheduled Flows have `<startSchedule>` elements. A parser written against one Flow type will silently produce zero Apex-call edges when processing a different Flow type.

**Why it happens:** Salesforce Flow is not a single metadata type — it is a family of related types (Screen Flow, Autolaunched Flow, Scheduled Flow, Before/After-Save Flow) that share an XML container but differ significantly in internal structure.

**Prevention:**
- Inspect the `<processType>` element first to determine Flow type and apply type-specific extraction rules.
- Use xpath queries with `//FlowApexActionCall` (double-slash for position-independent matching) rather than absolute path expressions.
- Build Flow parser tests from at least one sample of each Flow type: Screen, Autolaunched, Scheduled, Record-Triggered (Before/After-Save), and Platform Event-Triggered.

**Detection:** After ingestion, spot-check that `FlowNode` count in the graph matches `.flow-meta.xml` file count. Zero `CALLS_APEX` edges from Flows when Flows obviously call Apex is a clear signal.

**Phase:** Phase 2 (Flow parser).

---

### Pitfall 13: Dynamic Cypher Resolution Fails Silently When Accessor Registry YAML Is Wrong

**What goes wrong:** The Dynamic Accessor Registry (YAML config for org-specific utility method mapping) must correctly resolve method call chains to their target SObjects and fields. If the YAML maps `fflib_QueryFactory.selectSObjectType()` to the wrong return type, every edge derived from that accessor is wrong — but silently wrong, producing plausible-looking but incorrect graph traversal.

**Why it happens:** Dynamic method resolution in Apex (method chaining, selector layer patterns) cannot be resolved purely from syntax — it requires domain knowledge of the method's return type. The YAML config bridges this gap. If the YAML is not validated against the actual codebase, the mapping silently diverges.

**Prevention:**
- Provide a `validate-registry` CLI command that checks every YAML entry against the parsed CST: verify that the named class and method exist in the graph before registering the accessor.
- Ship a well-tested default YAML covering `fflib_SObjectSelector`, `fflib_QueryFactory`, standard `Database.*` methods, and `Schema.SObjectType.*` methods.
- Make the registry validation a phase in the ingestion pipeline, not a post-hoc check.

**Detection:** Add a `REGISTRY_MISMATCH` warning when a YAML-registered accessor is not found in the parsed class graph. This catches stale YAML configs after Apex refactors.

**Phase:** Phase 3 (Variable Origin Tracer and accessor registry).

---

### Pitfall 14: File Watcher Debounce in Real-Time Mode Can Miss Rapid Saves Followed by File Deletes

**What goes wrong:** The 2-second debounce on the watchdog file watcher means: if a developer saves a file, then deletes it within 2 seconds (common in editor auto-format/rewrite cycles), the debounce timer fires after the file is already gone. The ingestion handler reads a non-existent file and throws a `FileNotFoundError`, leaving the graph in a state where the old version of the nodes is not purged.

**Why it happens:** Debouncing collapses multiple rapid events into one, but it does not handle the case where the final state after the debounce window is "file deleted."

**Prevention:**
- In the debounce handler, check whether the file still exists before attempting ingestion. If the file is gone, treat it as a deletion event and remove its nodes from the graph.
- Handle the event sequence `MODIFIED → DELETED` within the debounce window explicitly as a net-delete operation.

**Detection:** Log `FILE_VANISHED_BEFORE_REINGESTION` events. This is expected occasionally — not a bug if handled correctly.

**Phase:** Phase 3 (file watcher and real-time mode).

---

### Pitfall 15: Salesforce Org Export May Be Incomplete Without Explicit Wildcard Handling

**What goes wrong:** Large Salesforce orgs (2,000+ Apex classes) hit the Metadata API's 10,000-file-per-retrieve limit. A package.xml using `<members>*</members>` wildcards silently truncates the export. The parser receives a partial metadata set and builds a partial graph — with no indication that metadata was missing.

**Why it happens:** Salesforce's Metadata API enforce a 10,000-file hard limit per retrieve call. Orgs with large managed packages, many historical custom objects, or extensive Static Resources can exceed this silently.

**Consequences:**
- The "what breaks" query answers are wrong because the graph is missing components.
- Relationships to managed package stub nodes are absent, making impact analysis incomplete.

**Prevention:**
- Document in the README that users must export in chunks if the org exceeds 10,000 files, and provide a sample chunked package.xml approach.
- On ingestion, compare the file count in the export directory to Salesforce-reported component counts (if available) and warn if they diverge.
- Do not assume that a successful metadata export is a complete metadata export.

**Detection:** Log the file count of each metadata type at ingestion start. Missing types (zero `.cls` files in an org known to have Apex) is a clear signal.

**Phase:** Phase 1 (ingestion design and README). Document the constraint before the first user tries it.

---

### Pitfall 16: Picklist False-Positive Guard Must Be Applied Consistently or Graph Is Polluted With Noise

**What goes wrong:** The project spec includes a picklist false-positive guard: a `READS_VALUE` edge requires field context before being created. If any parser (especially the formula field parser or the LWC HTML parser) bypasses this check and creates `READS_VALUE` edges based on string literal matching alone, the graph will contain high-confidence noise edges that make impact analysis unreliable.

**Why it happens:** Different parsers are developed by different people at different times. The guard is easy to forget when adding a new edge type that happens to match picklist values.

**Prevention:**
- Centralize the picklist guard in the GraphStore abstraction, not in individual parsers. The `create_reads_value_edge(source, target, context)` method requires a `context` parameter and raises an error if context is absent.
- Add a regression test: a fixture file with a picklist value that appears as a string literal in Apex but is NOT a picklist reference — verify that no `READS_VALUE` edge is created for it.

**Detection:** After ingestion, sample `READS_VALUE` edges and manually verify 10 random ones against the source file. A false-positive rate above 10% indicates the guard is being bypassed.

**Phase:** Phase 2 (GraphStore abstraction). Enforce at the abstraction level, not the parser level.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Phase 1: Environment setup | FalkorDBLite requires Python 3.12, project says 3.11+ | Fix `requires-python` to `>=3.12` immediately |
| Phase 1: macOS CI/CD | `libomp` not installed → FalkorDB spawn fails | Add `brew install libomp` to CI setup; document for developers |
| Phase 2: MCP server skeleton | Any `print()` call corrupts stdio transport | Enforce stderr-only logging before any tool handlers |
| Phase 2: Node.js worker pool | Memory growth unbounded → OOM mid-ingestion | Implement 200-file worker recycle ceiling from day 1 |
| Phase 2: tree-sitter-sfapex | Parse failures on inherited constructors and for-loops | Wrap all CST queries with `has_error` guard; build failure corpus |
| Phase 2: Vlocity DataPack parser | Format differs between orgs; `%vlocity_namespace%` unresolved | Build normalizer + schema-optional parser |
| Phase 2: Flow XML parser | Multiple Flow types have different XML structure | Check `<processType>` first; use `//` xpath; test all Flow types |
| Phase 2: Two-phase ingestion | Crash mid-node-phase leaves graph half-seeded | Manifest phase-completion flag; MERGE for idempotency |
| Phase 2: Picklist guard | Parsers bypass guard → high-confidence false edges | Enforce at GraphStore abstraction level, not parser level |
| Phase 3: Qdrant integration | Local mode caps at ~20k vectors; no HNSW | Design VectorStore abstraction for mode switching; document limit |
| Phase 3: File watcher | Modified-then-deleted within debounce window → FileNotFoundError | Check file existence in debounce handler; treat as net-delete |
| Phase 3: Accessor registry YAML | Wrong YAML → silently wrong edges | Add `validate-registry` CLI command; validate against graph |
| Phase 4: Query pipeline | LLM generates Neo4j Cypher dialect → FalkorDB errors | Pre-validate labels; add dialect filter for `=~`, label expressions |
| Phase 4: Text-to-Cypher | Hallucinated node labels return 0 results silently | Validate against `CALL db.labels()` before execution |
| Phase 4: Large result sets | Unbounded results → context overflow in MCP client | Hard limit 50 nodes / 100 edges per tool response |
| Phase 5: PyPI packaging | Org export is incomplete for large orgs | Document chunked export; warn on low file counts |

---

## Sources

- [FalkorDBLite Python docs](https://docs.falkordb.com/operations/falkordblite/falkordblite-py.html) — Python 3.12 requirement, libomp dependency, embedded Redis model
- [FalkorDB Cypher support coverage](https://docs.falkordb.com/cypher/cypher-support.html) — Unsupported features: regex, label expressions, user-defined functions, temporal arithmetic
- [FalkorDB GitHub](https://github.com/FalkorDB/falkordblite) — Persistence model, security config, known constraints
- [tree-sitter-sfapex GitHub issues](https://github.com/aheber/tree-sitter-sfapex/issues) — Issue #60 (constructors), #45 (semicolons), #44 (for-loop init), #55 (SOSL), #66 (__dirname)
- [Qdrant local mode — DeepWiki](https://deepwiki.com/qdrant/qdrant-client/2.2-local-mode) — 20k vector limit, brute-force search, portalocker single-process enforcement
- [NearForm MCP pitfalls](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/) — stdout corruption, async patterns, tool schema design, infinite loops
- [MCP SDK GitHub Issue #396](https://github.com/modelcontextprotocol/python-sdk/issues/396) — Exception handling in stdio transport, client-undetected server termination
- [Multi-Agent GraphRAG Text-to-Cypher paper](https://arxiv.org/html/2511.08274v1) — Hallucination patterns, entity verification, iterative correction strategies
- [Text2Cypher Guide — Neo4j/Medium](https://medium.com/neo4j/text2cypher-guide-cc161518a509) — Schema overload, relationship direction confusion, correction loop limitations
- [Node.js worker_threads memory leak issues](https://github.com/nodejs/node/issues/40878) — Compiled code not GC'd across worker lifetime
- [vlocity_build README](https://github.com/vlocityinc/vlocity_build/blob/master/README.md) — DataPack structure, namespace placeholders, dependency export behavior
- [Salesforce Metadata API best practices](https://www.orgflow.io/blog/salesforce-metadata-api-best-practices-7-rules-and-3-common-mistakes) — 10,000-file retrieve limit, wildcard truncation
- [Python asyncio development docs](https://docs.python.org/3/library/asyncio-dev.html) — Event loop starvation from CPU-bound blocking calls
