# Phase 3: Ingestion Pipeline Core — Research

**Researched:** 2026-04-04
**Domain:** Salesforce metadata parsing (Apex CST, SObject XML, Flow XML) + FalkorDB graph writes + asyncio ingestion orchestration
**Confidence:** HIGH (all core claims verified against live code execution or official docs)

---

## Summary

Phase 3 expands the stub `extractRawFacts()` in `worker.js` into a full CST traversal for Apex/triggers, adds Python parsers for SObject/Field XML and Flow XML, wires a two-phase `IngestionService` (nodes first, edges second) backed by `ManifestStore`, and ensures all 23 node types land in FalkorDB with correct source attribution and edge category taxonomy.

The tree-sitter-sfapex WASM grammar (already installed at `node_modules/web-tree-sitter-sfapex`) exposes clean, verifiable CST node types for every Apex fact the requirements demand: `class_declaration`, `method_declaration`, `dml_expression` (with `dml_type` child), `query_expression` / `soql_query_body`, `method_invocation` (with `object` and `name` fields), `binary_expression` (for picklist comparisons), `annotation`, `field_access` (for label refs). All node type names and field names were verified against live WASM execution in this session.

Salesforce metadata XML uses the namespace `http://soap.sforce.com/2006/04/metadata` throughout. Python's `xml.etree.ElementTree` with a namespace dict is the correct, dependency-free approach. Flow XML has a stable element structure verified against real flow-meta.xml files from open-source repos. FalkorDB Cypher MERGE patterns are compatible with the already-built `FalkorDBStore.merge_node()` and `merge_edge()` methods — no new graph write primitives are needed.

**Primary recommendation:** Build the ingestion pipeline in 4 independently testable units — (1) expanded worker.js CST traversal, (2) Python XML parsers for SObject/Flow, (3) IngestionService two-phase orchestrator, (4) schema index materialization — and integrate them bottom-up with the existing GraphStore ABC and ManifestStore.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INGEST-01 | Two-phase ingestion orchestration: all nodes before all edges | asyncio.gather() + ManifestStore phase tracking pattern documented below |
| INGEST-02 | Node write order: SFObject/SFField → CustomLabel → CustomSetting → CustomMetadata → Apex → LWC → Flow → Vlocity → ValidationRule → SFPicklistValue/GlobalValueSet → PlatformEvent | Enforced by explicit ordered list dispatch in IngestionService |
| INGEST-03 | All nodes via MERGE (idempotent) | FalkorDBStore.merge_node() already uses MERGE — confirmed in codebase |
| INGEST-04 | Source attribution on every node: sourceFile, lineNumber, parserType, lastIngestedAt | CST provides startPosition.row for lineNumber; all_props dict passed to merge_node() |
| INGEST-05 | Relationship Discovery pass runs after Phase 1 | Post-node pass iterates collected facts and issues merge_edge() calls |
| INGEST-06 | All edges carry confidence, resolutionMethod, edgeCategory, contextSnippet | Props dict passed to merge_edge() |
| INGEST-07 | Orphaned edges logged as warnings; unresolvable dynamic refs → stub nodes | Handled in edge-writing pass with fallback merge_node() for stubs |
| INGEST-08 | Ingestion summary on completion | Counters accumulated in IngestionService, returned as dataclass |
| INGEST-09 | Schema index JSON after full ingest | CALL db.labels() + CALL db.propertyKeys() + CALL db.relationshipTypes() → JSON file |
| APEX-01 | Class name, superclass, interfaces, annotations, isTest flag | class_declaration CST node, verified live |
| APEX-02 | Method signatures: name, visibility, isStatic, returnType, parameters, annotations | method_declaration CST node with modifiers subtree, verified live |
| APEX-03 | SOQL: target SObject, SELECT fields, WHERE fields, subquery SObjects | query_expression → soql_query_body → from_clause/select_clause/where_clause, verified live |
| APEX-04 | DML: type and target SObject | dml_expression with dml_type child, verified live |
| APEX-05 | Cross-class method calls and this.method() calls | method_invocation with object field; object.type == 'this' distinguishes same-class calls, verified live |
| APEX-06 | Custom Label refs, Custom Setting refs, Custom Metadata refs | field_access for labels; method_invocation obj endswith __c/__mdt for settings/metadata, verified live |
| APEX-07 | EventBus.publish() → PUBLISHES_EVENT edge | method_invocation where object=EventBus, name=publish; object_creation_expression inside args gives event type, verified live |
| APEX-08 | External namespace calls → CALLS_EXTERNAL edge | method_invocation where obj contains '__' or '.', verified live with vlocity_cmt, SBQQ__ patterns |
| APEX-09 | Picklist comparisons with field-context guard | binary_expression with field_access LHS and string_literal RHS; guard: field name must end __c and resolve to Picklist-type in SFField registry, verified live |
| APEX-10 | has_error guard on CST root | root.hasError property (not method) already in worker.js |
| APEX-11 | Dynamic Accessor Registry (YAML config) | YAML config maps utility method → READS_FIELD/WRITES_FIELD; method_invocation pattern matching |
| OBJ-01 | SFObject nodes from XML | object-meta.xml parsed with ET; fullName derived from filename |
| OBJ-02 | SFField nodes from field-meta.xml | field-meta.xml structure verified live with real dreamhouse files |
| OBJ-03 | SFPicklistValue nodes, GlobalValueSet nodes | valueSet/valueSetDefinition/value elements in field XML; globalValueSet-meta.xml |
| OBJ-04 | FIELD_HAS_VALUE, GLOBAL_VALUE_SET_HAS_VALUE, FIELD_USES_GLOBAL_SET edges | Emitted during object parsing phase |
| OBJ-05 | PlatformEvent nodes from __e object-meta.xml | Path glob: `objects/**/*__e/*.object-meta.xml` |
| OBJ-06 | FORMULA_DEPENDS_ON edges from formula text | Regex-based field reference extraction from formulaText; field refs match `[A-Za-z][A-Za-z0-9_]*__c` or `Object.Field` patterns |
| OBJ-07 | CustomLabel, CustomSetting, CustomMetadata nodes | labels-meta.xml, custom settings as __c objects, custom metadata as __mdt objects |
| FLOW-01 | Flow API name, label, type, triggerType, triggerObject, isActive | start element + status element in flow XML, verified live |
| FLOW-02 | Record operations: SObject type, field assignments | recordLookups/recordCreates/recordUpdates/recordDeletes elements, verified live |
| FLOW-03 | Decision conditions: field refs and picklist comparisons | decisions/rules/conditions with leftValueReference/rightValue, verified live |
| FLOW-04 | Apex action elements → FLOW_CALLS_APEX edge | actionCalls where actionType == 'apex', verified live |
| FLOW-05 | Subflow references → FLOW_CALLS_SUBFLOW edge | subflows element with flowName child |
| FLOW-06 | $Label.XXX references → FLOW_RESOLVES_LABEL edge | regex scan for `\$Label\.(\w+)` across all string values in flow XML |
| FLOW-07 | triggerType = PlatformEvent → SUBSCRIBES_TO_EVENT edge | start/triggerType == 'PlatformEvent', start/object gives event API name |
| FLOW-08 | Publish Message elements → PUBLISHES_EVENT edge | actionCalls where actionType == 'publishPlatformEvent' or actionName ends __e |
| GRAPH-01 | All 23 node types in FalkorDB | merge_node(label, ...) creates labels on-demand in FalkorDB; confirmed by live test suite |
| GRAPH-02 | All relationship tables | merge_edge() with rel_type parameter; FalkorDB creates rel types on-demand |
| GRAPH-03 | Edge category taxonomy: DATA_FLOW/CONTROL_FLOW/CONFIG/STRUCTURAL | edgeCategory prop in all merge_edge() calls; enforced by Pydantic validator |
| GRAPH-04 | DuckPGQStore stub validates Protocol boundary | Already implemented in duckpgq_store.py |
</phase_requirements>

---

## Standard Stack

### Core (all already in pyproject.toml)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| web-tree-sitter-sfapex | 2.4.1 (installed) | WASM Apex/SOQL/SOSL CST parser in Node.js worker | Only maintained WASM Salesforce parser; zero native build deps |
| xml.etree.ElementTree | stdlib | Parse SObject/Flow XML | Zero deps; sufficient for Salesforce XML; iterparse for large files |
| aiosqlite | 0.22.1 (installed) | Async ManifestStore for phase tracking | Already used in Phase 1 |
| falkordb | >=1.6.0 (installed) | Graph writes via FalkorDBStore | Already built with asyncio write queue |
| pydantic | >=2.0 (installed) | Dataclass validation for ingestion models | Type safety on node/edge payloads |
| PyYAML | need to add | Load Dynamic Accessor Registry YAML config | Standard for config files in Python |

### Supporting (need to add to pyproject.toml)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pyyaml | >=6.0 | Load `config/dynamic_accessors.yaml` at startup | APEX-11 Dynamic Accessor Registry |

### Installation
```bash
# Add to pyproject.toml dependencies:
# "pyyaml>=6.0"
uv add pyyaml
```

**Note:** No new Node.js packages needed. `xml.etree.ElementTree` is Python stdlib. `forcemula` (JS formula parser) is too heavyweight for Phase 3 — use regex extraction for FORMULA_DEPENDS_ON edges instead.

---

## Architecture Patterns

### Recommended Module Structure
```
src/sfgraph/
├── ingestion/
│   ├── __init__.py
│   ├── service.py          # IngestionService — two-phase orchestrator
│   ├── models.py           # NodeFact, EdgeFact Pydantic dataclasses
│   └── schema_index.py     # Schema index materializer
├── parser/
│   ├── worker/
│   │   └── worker.js       # EXPAND extractRawFacts() here
│   ├── apex_facts.js       # (optional: split large CST logic out)
│   ├── pool.py             # Already built
│   ├── dispatcher.py       # Already built
│   ├── object_parser.py    # SObject/SFField/GlobalValueSet XML parser (Python)
│   └── flow_parser.py      # Flow XML parser (Python)
├── storage/
│   └── ...                 # Already built
└── server.py               # Add ingest_org MCP tool
config/
└── dynamic_accessors.yaml  # APEX-11 YAML registry
```

### Pattern 1: Two-Phase IngestionService
**What:** An asyncio-native orchestrator that collects all parsed facts in memory, writes all nodes (Phase 1), then writes all edges (Phase 2), with ManifestStore tracking per-file progress.
**When to use:** Always — enforces INGEST-01 guarantee that every target node exists before any edge attempts to reference it.

```python
# Source: derived from ManifestStore + FalkorDBStore ABCs in codebase
class IngestionService:
    def __init__(self, graph: GraphStore, manifest: ManifestStore, pool: NodeParserPool):
        ...

    async def ingest(self, export_dir: str) -> IngestionSummary:
        run_id = await self.manifest.create_run()

        # Discover and hash all files
        files = self._discover_files(export_dir)
        for path, sha in files.items():
            await self.manifest.upsert_file(path, sha, run_id)

        # Phase 1: Parse all files → collect NodeFact lists
        all_node_facts: list[NodeFact] = []
        for path in ordered_by_node_type(files):
            facts = await self._parse_file(path)
            all_node_facts.extend(facts.nodes)

        # Phase 1: Write all nodes
        for fact in all_node_facts:
            await self.graph.merge_node(fact.label, fact.key_props, fact.all_props)
            await self.manifest.set_status(fact.source_file, "NODES_WRITTEN")

        # Phase 2: Derive edges from node registry, write all edges
        edge_facts = self._discover_edges(all_node_facts)
        for ef in edge_facts:
            try:
                await self.graph.merge_edge(...)
            except Exception:
                self._log_orphan(ef)  # INGEST-07

        for path in files:
            await self.manifest.set_status(path, "EDGES_WRITTEN")

        await self.manifest.mark_run_complete(run_id, phase_1_complete=True, phase_2_complete=True)
        return self._build_summary(...)
```

### Pattern 2: Apex CST Traversal in worker.js
**What:** Replace the stub `extractRawFacts()` with full traversal using `descendantsOfType()` and `childForFieldName()` — both available in the web-tree-sitter WASM API.
**When to use:** For every `.cls` and `.trigger` file routed to the Node.js pool.

```javascript
// Source: verified live against web-tree-sitter-sfapex 2.4.1 WASM
function extractRawFacts(root, filePath) {
  if (root.hasError) {  // APEX-10: property NOT method
    return { filePath, hasError: true, nodes: [], potential_refs: [] };
  }

  const facts = { filePath, hasError: false, nodes: [], potential_refs: [] };

  // APEX-01: class_declaration
  for (const cls of root.descendantsOfType('class_declaration')) {
    const mods = cls.childForFieldName('modifiers');
    const modsText = mods?.text ?? '';
    const annotations = (mods?.descendantsOfType('annotation') ?? []).map(a => ({
      name: a.descendantsOfType('identifier')[0]?.text ?? '',
    }));
    const isTest = annotations.some(a => a.name.toLowerCase() === 'istest')
                   || modsText.toLowerCase().includes('testmethod');

    // interfaces: type_list child contains type_identifier and scoped_type_identifier
    const ifaceList = cls.childForFieldName('interfaces');
    const interfaces = (ifaceList?.descendantsOfType('type_identifier') ?? []).map(t => t.text)
      .concat((ifaceList?.descendantsOfType('scoped_type_identifier') ?? []).map(t => t.text));

    facts.nodes.push({
      nodeType: 'ApexClass',
      name: cls.childForFieldName('name')?.text ?? '',
      superclass: cls.childForFieldName('superclass')
                    ?.descendantsOfType('type_identifier')[0]?.text ?? null,
      interfaces,
      annotations: annotations.map(a => a.name),
      isTest,
      startLine: cls.startPosition.row + 1,
    });

    // APEX-02: method_declaration inside class body
    const body = cls.childForFieldName('body');
    for (const method of (body?.descendantsOfType('method_declaration') ?? [])) {
      const mMods = method.childForFieldName('modifiers');
      const mModsText = mMods?.text ?? '';
      const mAnnotations = (mMods?.descendantsOfType('annotation') ?? []).map(a =>
        a.descendantsOfType('identifier')[0]?.text ?? '');
      const modChildren = (mMods?.descendantsOfType('modifier') ?? []).map(m => m.text.toLowerCase());
      const visibility = modChildren.find(m => ['public','private','protected','global'].includes(m)) ?? 'package';
      const isStatic = modChildren.includes('static');

      const params = [];
      for (const p of (method.childForFieldName('parameters')?.descendantsOfType('formal_parameter') ?? [])) {
        params.push({
          type: p.childForFieldName('type')?.text ?? '',
          name: p.childForFieldName('name')?.text ?? '',
        });
      }

      facts.nodes.push({
        nodeType: 'ApexMethod',
        name: method.childForFieldName('name')?.text ?? '',
        visibility,
        isStatic,
        returnType: method.childForFieldName('type')?.text ?? method.childForFieldName('void_type')?.text ?? 'void',
        parameters: params,
        annotations: mAnnotations,
        startLine: method.startPosition.row + 1,
      });
    }
  }

  // APEX-03: SOQL inside query_expression
  for (const q of root.descendantsOfType('query_expression')) {
    const bodies = q.descendantsOfType('soql_query_body');
    const outerBody = bodies[0];
    if (!outerBody) continue;
    const fromObjects = outerBody.descendantsOfType('from_clause')
      .flatMap(f => f.descendantsOfType('storage_identifier').map(s => s.text));
    const selectFields = (outerBody.descendantsOfType('select_clause')[0]
      ?.descendantsOfType('field_identifier') ?? []).map(f => f.text);
    const whereFields = (outerBody.descendantsOfType('where_clause')[0]
      ?.descendantsOfType('field_identifier') ?? []).map(f => f.text);
    facts.potential_refs.push({
      refType: 'SOQL',
      fromObjects,
      selectFields,
      whereFields,
      startLine: q.startPosition.row + 1,
      contextSnippet: q.text.substring(0, 120),
    });
  }

  // APEX-04: DML operations
  for (const dml of root.descendantsOfType('dml_expression')) {
    const dmlType = dml.childForFieldName('dml_type')?.text
                    ?? dml.namedChildren[0]?.text ?? 'unknown';
    // Target SObject: check second named child for object_creation_expression type
    const secondChild = dml.namedChildren[1];
    let targetType = null;
    if (secondChild?.type === 'object_creation_expression') {
      targetType = secondChild.childForFieldName('type')?.text;
    }
    facts.potential_refs.push({
      refType: 'DML',
      dmlType,
      targetType,
      startLine: dml.startPosition.row + 1,
      contextSnippet: dml.text.substring(0, 80),
    });
  }

  // APEX-05: Method invocations (cross-class and this.method calls)
  for (const call of root.descendantsOfType('method_invocation')) {
    const obj = call.childForFieldName('object');
    const name = call.childForFieldName('name')?.text;
    if (!name) continue;

    const objText = obj?.text;
    const objType = obj?.type;

    // APEX-07: EventBus.publish
    if (objText === 'EventBus' && name === 'publish') {
      const args = call.childForFieldName('arguments');
      const eventCreation = args?.descendantsOfType('object_creation_expression')[0];
      const eventType = eventCreation?.childForFieldName('type')?.text;
      if (eventType?.endsWith('__e')) {
        facts.potential_refs.push({
          refType: 'PUBLISHES_EVENT',
          eventType,
          startLine: call.startPosition.row + 1,
          contextSnippet: call.text.substring(0, 80),
        });
        continue;
      }
    }

    // APEX-08: External namespace calls (obj contains __ or is dotted)
    if (objText && (objText.includes('__') || objText.includes('.'))) {
      facts.potential_refs.push({
        refType: 'CALLS_EXTERNAL',
        namespace: objText,
        method: name,
        startLine: call.startPosition.row + 1,
        contextSnippet: call.text.substring(0, 80),
      });
      continue;
    }

    // APEX-06: Custom Label refs via method_invocation is NOT the right node
    // Labels appear as field_access: System.Label.XXX or Label.XXX
    // Custom Settings: obj ends __c
    if (objText?.endsWith('__c')) {
      if (name === 'getInstance' || name === 'getOrgDefaults' || name === 'getAll') {
        facts.potential_refs.push({
          refType: 'READS_CUSTOM_SETTING',
          settingType: objText,
          startLine: call.startPosition.row + 1,
        });
        continue;
      }
    }

    // APEX-06: Custom Metadata: obj ends __mdt
    if (objText?.endsWith('__mdt')) {
      facts.potential_refs.push({
        refType: 'READS_CUSTOM_METADATA',
        metadataType: objText,
        startLine: call.startPosition.row + 1,
      });
      continue;
    }

    // APEX-05: Cross-class call (obj is identifier, not this/super/Database/Schema)
    const systemClasses = new Set(['Database','Schema','System','Math','String','Date','DateTime','Limits','Test']);
    if (obj && objType === 'identifier' && !systemClasses.has(objText)) {
      facts.potential_refs.push({
        refType: 'CALLS_CLASS_METHOD',
        targetClass: objText,
        method: name,
        startLine: call.startPosition.row + 1,
        contextSnippet: call.text.substring(0, 80),
      });
    }
    // Same-class call: obj.type === 'this'
    if (objType === 'this') {
      facts.potential_refs.push({
        refType: 'CALLS_THIS_METHOD',
        method: name,
        startLine: call.startPosition.row + 1,
      });
    }
  }

  // APEX-06: Custom Label field_access (System.Label.XXX or Label.XXX)
  for (const fa of root.descendantsOfType('field_access')) {
    const faObj = fa.childForFieldName('object');
    const faField = fa.childForFieldName('field')?.text;
    if (!faField) continue;

    // System.Label.XXX: object is also a field_access where field == 'Label'
    if (faObj?.type === 'field_access' && faObj.childForFieldName('field')?.text === 'Label') {
      facts.potential_refs.push({
        refType: 'READS_LABEL',
        labelName: faField,
        startLine: fa.startPosition.row + 1,
      });
    }
    // Label.XXX: object is identifier 'Label'
    if (faObj?.type === 'identifier' && faObj?.text === 'Label') {
      facts.potential_refs.push({
        refType: 'READS_LABEL',
        labelName: faField,
        startLine: fa.startPosition.row + 1,
      });
    }
  }

  // APEX-09: Picklist comparisons (binary_expression with field_access LHS and string_literal RHS)
  for (const be of root.descendantsOfType('binary_expression')) {
    const left = be.childForFieldName('left');
    const right = be.childForFieldName('right');
    if (!left || !right) continue;
    if (left.type !== 'field_access' || right.type !== 'string_literal') continue;

    const fieldName = left.childForFieldName('field')?.text;
    const varName = left.childForFieldName('object')?.text;
    const comparand = right.text.replace(/^'|'$/g, '');
    // Emit as candidate; field-context guard (is this a Picklist field?) applied in Python during edge resolution
    if (fieldName) {
      facts.potential_refs.push({
        refType: 'PICKLIST_COMPARISON',
        varName,
        fieldName,
        comparand,
        startLine: be.startPosition.row + 1,
        contextSnippet: be.text.substring(0, 80),
      });
    }
  }

  return facts;
}
```

### Pattern 3: SObject/Field XML Parsing (Python ElementTree)
**What:** Parse `.object-meta.xml` and `.field-meta.xml` files using `xml.etree.ElementTree` with the Salesforce metadata namespace.
**When to use:** For every `.xml` file routed to `python_parser` that lives in an `objects/` directory.

```python
# Source: verified against live dreamhouse-lwc field XML files
import xml.etree.ElementTree as ET

NS = "http://soap.sforce.com/2006/04/metadata"
NS_MAP = {"md": NS}

def _tag(name: str) -> str:
    return f"{{{NS}}}{name}"

def parse_field_xml(path: str) -> dict:
    """Parse a .field-meta.xml file into a NodeFact dict."""
    tree = ET.parse(path)
    root = tree.getroot()

    full_name = root.findtext(_tag("fullName")) or ""
    label = root.findtext(_tag("label")) or ""
    data_type = root.findtext(_tag("type")) or ""
    formula = root.findtext(_tag("formula")) or None
    is_required = (root.findtext(_tag("required")) or "false").lower() == "true"

    # Picklist values: valueSet > valueSetDefinition > value[]
    picklist_values = []
    vs = root.find(_tag("valueSet"))
    if vs is not None:
        vsd = vs.find(_tag("valueSetDefinition"))
        if vsd is not None:
            for val in vsd.findall(_tag("value")):
                v_name = val.findtext(_tag("fullName")) or ""
                v_label = val.findtext(_tag("label")) or ""
                v_default = (val.findtext(_tag("default")) or "false").lower() == "true"
                picklist_values.append({"name": v_name, "label": v_label, "isDefault": v_default})
        # Global value set reference
        global_vs_ref = vs.findtext(_tag("valueSetName"))
    else:
        global_vs_ref = None

    return {
        "fullName": full_name,
        "label": label,
        "dataType": data_type,
        "formulaText": formula,
        "isFormula": formula is not None,
        "isRequired": is_required,
        "picklistValues": picklist_values,
        "globalValueSetRef": global_vs_ref,
    }

def parse_object_xml(path: str) -> dict:
    """Parse a .object-meta.xml file for SFObject metadata."""
    tree = ET.parse(path)
    root = tree.getroot()
    # In source format, object name is derived from filename: MyObject__c.object-meta.xml
    label = root.findtext(_tag("label")) or ""
    sharing = root.findtext(_tag("sharingModel")) or ""
    return {"label": label, "sharingModel": sharing}
```

### Pattern 4: Flow XML Parsing (Python ElementTree)
**What:** Parse `.flow-meta.xml` files extracting all elements needed for FLOW-01 through FLOW-08.
**When to use:** For every `.xml` file with `.flow-meta.xml` suffix.

```python
# Source: verified against flowratech/flowsnippet-free-templates real flow XML
import xml.etree.ElementTree as ET

NS = "http://soap.sforce.com/2006/04/metadata"

def _t(name):
    return f"{{{NS}}}{name}"

def parse_flow_xml(path: str) -> dict:
    """Parse a .flow-meta.xml file and return structured flow facts."""
    tree = ET.parse(path)
    root = tree.getroot()

    # FLOW-01: Top-level metadata
    label = root.findtext(_t("label")) or ""
    process_type = root.findtext(_t("processType")) or ""
    status = root.findtext(_t("status")) or ""
    api_version = root.findtext(_t("apiVersion")) or ""

    # FLOW-01: Start element for trigger info
    start = root.find(_t("start"))
    trigger_type = start.findtext(_t("triggerType")) if start is not None else None
    trigger_object = start.findtext(_t("object")) if start is not None else None
    record_trigger_type = start.findtext(_t("recordTriggerType")) if start is not None else None

    # FLOW-02: Record operations
    record_ops = []
    for op_tag in ["recordLookups", "recordCreates", "recordUpdates", "recordDeletes"]:
        for elem in root.findall(_t(op_tag)):
            op_name = elem.findtext(_t("name")) or ""
            op_object = elem.findtext(_t("object")) or ""
            fields = []
            for ia in elem.findall(_t("inputAssignments")):
                fields.append(ia.findtext(_t("field")) or "")
            for oa in elem.findall(_t("outputAssignments")):
                fields.append(oa.findtext(_t("field")) or "")
            record_ops.append({"opType": op_tag, "name": op_name, "object": op_object, "fields": fields})

    # FLOW-03: Decision conditions
    decisions = []
    for dec in root.findall(_t("decisions")):
        dec_name = dec.findtext(_t("name")) or ""
        for rule in dec.findall(_t("rules")):
            rule_name = rule.findtext(_t("name")) or ""
            for cond in rule.findall(_t("conditions")):
                left_ref = cond.findtext(_t("leftValueReference")) or ""
                right_val_elem = cond.find(_t("rightValue"))
                right_string = right_val_elem.findtext(_t("stringValue")) if right_val_elem is not None else None
                decisions.append({
                    "decisionName": dec_name,
                    "ruleName": rule_name,
                    "leftValueReference": left_ref,
                    "rightStringValue": right_string,
                })

    # FLOW-04: Apex action calls (actionType == 'apex')
    apex_actions = []
    for ac in root.findall(_t("actionCalls")):
        action_name = ac.findtext(_t("actionName")) or ""
        action_type = ac.findtext(_t("actionType")) or ""
        if action_type == "apex":
            apex_actions.append({"actionName": action_name})
        # FLOW-08: Platform event publish
        if action_type in ("publishPlatformEvent", "publish") or action_name.endswith("__e"):
            apex_actions.append({"actionType": "publishPlatformEvent", "actionName": action_name})

    # FLOW-05: Subflows
    subflows = []
    for sf in root.findall(_t("subflows")):
        flow_name = sf.findtext(_t("flowName")) or ""
        subflows.append({"flowName": flow_name})

    # FLOW-06: $Label references — scan all text content
    all_text = ET.tostring(root, encoding="unicode")
    import re
    label_refs = list(set(re.findall(r'\$Label\.(\w+)', all_text)))

    return {
        "label": label,
        "processType": process_type,
        "status": status,
        "triggerType": trigger_type,
        "triggerObject": trigger_object,
        "recordTriggerType": record_trigger_type,
        "isActive": status.lower() == "active",
        "recordOps": record_ops,
        "decisions": decisions,
        "apexActions": apex_actions,
        "subflows": subflows,
        "labelRefs": label_refs,
    }
```

### Pattern 5: Formula Field Reference Extraction
**What:** Extract field dependencies from Salesforce formula text using regex patterns. Full AST parsing (forcemula) is JavaScript-only and a heavyweight dependency — regex is sufficient for FORMULA_DEPENDS_ON edges.
**When to use:** When `isFormula == True` in SFField node facts (OBJ-06).

```python
# Source: derived from Salesforce formula syntax documentation
import re

# Match field references in formulas:
# Object.Field, Field__c, ISPICKVAL(Field__c, 'value'), IF(Field__c > 0, ...)
FIELD_REF_PATTERNS = [
    # Object.Field cross-object reference
    r'([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*__c|[A-Z][A-Za-z_]+)',
    # Custom field reference
    r'\b([A-Za-z][A-Za-z0-9]*__c)\b',
    # ISPICKVAL / INCLUDES function argument (first arg is field)
    r'ISPICKVAL\s*\(\s*([A-Za-z][A-Za-z0-9_]*__c)',
    r'INCLUDES\s*\(\s*([A-Za-z][A-Za-z0-9_]*__c)',
]

def extract_formula_field_refs(formula_text: str) -> list[str]:
    """Return list of field API names referenced in a formula expression."""
    refs = set()
    for pattern in FIELD_REF_PATTERNS:
        for match in re.finditer(pattern, formula_text, re.IGNORECASE):
            # Last group is the field name
            refs.add(match.group(match.lastindex))
    # Exclude known formula functions that look like fields
    FORMULA_FUNCTIONS = {'TODAY', 'NOW', 'NULL', 'TRUE', 'FALSE', 'IF', 'AND', 'OR', 'NOT',
                         'TEXT', 'VALUE', 'DATE', 'YEAR', 'MONTH', 'DAY', 'FLOOR', 'CEILING'}
    return [r for r in refs if r.upper() not in FORMULA_FUNCTIONS]
```

### Pattern 6: FalkorDB Schema Index Materialization (INGEST-09)
**What:** After full ingest, query FalkorDB for all labels, relationship types, and property keys, then materialize to a JSON file for the Schema Filter Agent.
**When to use:** Called at the end of each successful full ingest.

```python
# Source: FalkorDB procedures docs — CALL db.labels(), CALL db.propertyKeys(), CALL db.relationshipTypes()
async def materialize_schema_index(graph: GraphStore, output_path: str) -> dict:
    """Build schema_index.json for Schema Filter Agent consumption."""
    labels = await graph.get_labels()
    rel_types = await graph.get_relationship_types()
    # Per-label property sampling: query one representative node per label
    label_props = {}
    for label in labels:
        rows = await graph.query(f"MATCH (n:{label}) RETURN n LIMIT 1")
        if rows:
            # Extract property keys from first returned node
            node = rows[0].get('n', {})
            label_props[label] = list(node.keys()) if isinstance(node, dict) else []

    schema = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "node_types": {
            label: {
                "properties": label_props.get(label, []),
                "description": NODE_TYPE_DESCRIPTIONS.get(label, ""),
            }
            for label in sorted(labels)
        },
        "relationship_types": sorted(rel_types),
        "edge_categories": ["DATA_FLOW", "CONTROL_FLOW", "CONFIG", "STRUCTURAL"],
    }
    with open(output_path, "w") as f:
        json.dump(schema, f, indent=2)
    return schema
```

### Anti-Patterns to Avoid
- **Using `CREATE` instead of `MERGE` for nodes:** breaks resume after crash; FalkorDB creates duplicates
- **Writing edges before all nodes:** forward-reference ordering problem; entire Phase 1 must complete first
- **Calling `root.hasError()` with parens in WASM:** it is a property (`root.hasError`), not a method — crashes with TypeError
- **Using `soql_query` as the CST node type:** the correct node type is `query_expression` (wraps the `[...]` bracket), with `soql_query_body` inside it
- **Using `dml_type` as `childForFieldName('dml_type')`:** the DML keyword is the FIRST NAMED CHILD (`dml.namedChildren[0]?.text`), confirmed live — `childForFieldName('dml_type')` returns undefined
- **Using `childForFieldName('modifiers')` to check static/visibility:** `modifiers` child contains `annotation` and `modifier` nodes; inspect `mods.descendantsOfType('modifier').map(m => m.text.toLowerCase())` for visibility/static keywords
- **Scanning `type_identifier` only for interfaces:** interface list contains both `type_identifier` (simple) and `scoped_type_identifier` (dotted, e.g. `MyNS.ISomeInterface`) — scan both
- **Parsing CustomLabel XML without checking decomposed format:** in SFDX source format, labels may be decomposed into individual `.label-meta.xml` files OR stored as a single `CustomLabels.labels-meta.xml`; handle both
- **Using ET.findall() without namespace prefix:** all Salesforce XML elements are in the `http://soap.sforce.com/2006/04/metadata` namespace; always use `_tag()` helper

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Apex CST parsing | Custom regex/text parser for Apex | tree-sitter-sfapex WASM | Grammar handles 5-20% edge cases in enterprise Apex that regex cannot |
| Flow/Object XML parsing | Custom XML string parser | xml.etree.ElementTree (stdlib) | ET handles namespaces, encoding, nesting; regex on XML breaks on comments/CDATA |
| Graph idempotency | Custom de-dup logic | MERGE in FalkorDB Cypher | FalkorDB guarantees atomic match-or-create; custom logic is a race condition |
| Async write serialization | Custom lock mechanism | asyncio.Queue in FalkorDBStore (already built) | Queue already serializes all writes; don't add more locking |
| Formula field parsing (complex) | Full formula AST parser | Regex patterns for field ref extraction | forcemula is JS-only; full parser is overkill for FORMULA_DEPENDS_ON edges which only need field names |
| ManifestStore crash recovery | Custom file-based state tracking | ManifestStore SQLite (already built) | Already handles PENDING/NODES_WRITTEN/EDGES_WRITTEN/FAILED per file |

---

## Common Pitfalls

### Pitfall 1: WASM `hasError` is a property, not method
**What goes wrong:** Calling `root.hasError()` throws `TypeError: root.hasError is not a function`
**Why it happens:** The web-tree-sitter WASM API exposes `hasError` as a boolean property, unlike some native bindings that made it a method
**How to avoid:** Always write `if (root.hasError) {` — no parentheses
**Warning signs:** Worker crashes on files with parse errors rather than returning `{ok: false, error: "parse_error"}`

### Pitfall 2: DML type detection — `childForFieldName('dml_type')` returns undefined
**What goes wrong:** DML operation type cannot be extracted
**Why it happens:** In web-tree-sitter, `dml_type` is a named node but NOT a named field on `dml_expression`; the DML keyword is `dml.namedChildren[0]`
**How to avoid:** Use `dml.namedChildren[0]?.text` to get the operation keyword (`insert`, `update`, etc.)
**Warning signs:** All DML operations appear as `'unknown'` type in extracted facts

### Pitfall 3: SOQL node type is `query_expression`, not `soql_query`
**What goes wrong:** `root.descendantsOfType('soql_query')` returns empty array
**Why it happens:** The Apex grammar wraps `[SELECT...]` in a `query_expression` node; `soql_query_body` is the child with field details
**How to avoid:** Always traverse `query_expression` → `soql_query_body` → `from_clause` / `select_clause` / `where_clause`

### Pitfall 4: Salesforce XML namespace must be included on every findtext/find call
**What goes wrong:** `root.find('label')` returns `None`; `root.findtext('fullName')` returns `None`
**Why it happens:** All elements in Salesforce XML are in the `http://soap.sforce.com/2006/04/metadata` namespace
**How to avoid:** Always wrap element names: `root.findtext(f'{{{NS}}}label')` or use a `_tag()` helper function
**Warning signs:** All XML field values appear as `None`/empty; nodes created with empty properties

### Pitfall 5: flow-meta.xml element order matters for ElementTree
**What goes wrong:** `root.find(_t('start'))` returns `None` for some flow files
**Why it happens:** Flow XML elements must be in alphabetical order per Salesforce spec; some community-generated flows omit certain elements entirely
**How to avoid:** Always use `if elem is not None:` guards before accessing child elements; never assume start/decisions elements exist

### Pitfall 6: FalkorDB `merge_edge()` fails silently when src or dst node doesn't exist
**What goes wrong:** Edge is attempted but silently not created; no error raised
**Why it happens:** The MATCH in `merge_edge()` finds no nodes if Phase 1 didn't complete or qualifiedName mismatch
**How to avoid:** Two-phase guarantee (all nodes written before any edges) eliminates this; also log zero-result queries as orphaned edge warnings (INGEST-07)

### Pitfall 7: CustomLabel XML format varies by SFDX version
**What goes wrong:** Label nodes not created; parser finds no labels
**Why it happens:** Pre-decomposition: all labels in one `CustomLabels.labels-meta.xml` file. Post-decomposition: individual `LabelName.label-meta.xml` files in `customlabels/` folder
**How to avoid:** Handle both: if path ends `.labels-meta.xml`, iterate `<labels>` children; if `.label-meta.xml`, parse as single label
**Warning signs:** Zero CustomLabel nodes in graph despite labels in org export

### Pitfall 8: interfaces `type_list` contains `scoped_type_identifier` for dotted names
**What goes wrong:** Interface `MyNS.ISomeInterface` parsed as two separate identifiers (`MyNS`, `ISomeInterface`) instead of one qualified name
**Why it happens:** CST correctly represents `MyNS.ISomeInterface` as `scoped_type_identifier` not `type_identifier`
**How to avoid:** Collect both `type_identifier` and `scoped_type_identifier` nodes from `type_list`

### Pitfall 9: APEX-09 picklist guard requires cross-reference with SFField registry
**What goes wrong:** Every string comparison emits a READS_VALUE edge regardless of whether the field is actually a picklist
**Why it happens:** CST only knows the field accessor name; picklist type knowledge lives in SFField nodes
**How to avoid:** The `PICKLIST_COMPARISON` potential_ref emitted by the worker is a candidate; in Python's edge-resolution pass, look up the field in the SFField node registry and only emit the edge if `dataType == 'Picklist'`

---

## Code Examples

### Verified: FalkorDB MERGE with ON CREATE / ON MATCH
```cypher
-- Source: docs.falkordb.com/cypher/merge.html (HIGH confidence)
-- Idempotent node upsert: creates if absent, updates properties if present
MERGE (n:ApexClass {qualifiedName: $qualifiedName})
SET n.name = $name, n.sourceFile = $sourceFile, n.lastIngestedAt = $lastIngestedAt
RETURN n.qualifiedName AS qn
```

### Verified: FalkorDB schema introspection
```cypher
-- Source: docs.falkordb.com/cypher/procedures.html (HIGH confidence)
CALL db.labels() YIELD label
CALL db.relationshipTypes() YIELD relationshipType
CALL db.propertyKeys() YIELD propertyKey
CALL db.indexes()
```

### Verified: FalkorDB range index creation
```cypher
-- Source: docs.falkordb.com/cypher/indexing/range-index.html (HIGH confidence)
CREATE INDEX FOR (n:ApexClass) ON (n.qualifiedName)
CREATE INDEX FOR (n:SFField) ON (n.qualifiedName)
CREATE INDEX FOR (n:CustomLabel) ON (n.apiName)
```

### Verified: Python ElementTree namespace pattern
```python
# Source: verified live against real Salesforce XML files (HIGH confidence)
NS = "http://soap.sforce.com/2006/04/metadata"
import xml.etree.ElementTree as ET

def _tag(name: str) -> str:
    return f"{{{NS}}}{name}"

tree = ET.parse("MyObject__c.object-meta.xml")
root = tree.getroot()
label = root.findtext(_tag("label"))  # Correct
# WRONG: root.findtext("label")  → returns None
```

### Verified: Flow XML key element paths
```python
# Source: verified against flowratech/flowsnippet-free-templates real flow XML (HIGH confidence)
# Top-level flow elements (direct children of <Flow>):
#   <label>        → flow label
#   <processType>  → AutoLaunchedFlow / ScreenFlow / etc.
#   <status>       → Active / Draft / Obsolete
#   <apiVersion>   → 60.0 etc.
#   <start>        → contains triggerType, object, recordTriggerType, filterLogic, filters
#   <decisions>    → contains name, label, rules > conditions > leftValueReference/rightValue
#   <recordLookups> → contains name, object, inputAssignments/outputAssignments
#   <recordCreates> → contains name, object, inputAssignments
#   <recordUpdates> → contains name, inputAssignments, inputReference
#   <recordDeletes> → contains name, inputReference/filters
#   <actionCalls>  → contains name, actionName, actionType, inputParameters
#   <subflows>     → contains name, flowName, inputAssignments

# Decision condition structure:
# decisions > rules > conditions:
#   leftValueReference: "$Record.Status__c" or variable name
#   operator: EqualTo / NotEqualTo / etc.
#   rightValue > stringValue: "Active" (for picklist/text comparisons)
```

---

## Verified CST Node Types (web-tree-sitter-sfapex 2.4.1, verified live 2026-04-04)

### Apex Grammar Node Types
| Node Type | Usage | Field Names |
|-----------|-------|-------------|
| `class_declaration` | Class definition | `name`, `superclass`, `interfaces`, `body`, `modifiers` |
| `method_declaration` | Method definition | `name`, `type`, `void_type`, `modifiers`, `parameters` (= `formal_parameters`) |
| `formal_parameter` | Method parameter | `type`, `name` |
| `modifiers` | Visibility/annotations container | namedChildren: `annotation`, `modifier` |
| `annotation` | `@IsTest`, `@AuraEnabled` etc | namedChild `identifier` = annotation name; `annotation_argument_list` optional |
| `modifier` | `public`, `static`, `private` etc | `.text` = keyword |
| `query_expression` | `[SELECT ... FROM ...]` | namedChild `soql_query_body` |
| `soql_query_body` | SOQL body | `from_clause`, `select_clause`, `where_clause` children |
| `from_clause` | FROM clause | descendantsOfType `storage_identifier` = SObject names |
| `select_clause` | SELECT clause | descendantsOfType `field_identifier` = field names |
| `where_clause` | WHERE clause | descendantsOfType `field_identifier` = filtered fields |
| `field_identifier` | Field reference in SOQL | `.text` = "Account.Status__c" or "Id" |
| `storage_identifier` | SObject name in SOQL | `.text` = "Account" |
| `dml_expression` | DML statement | `namedChildren[0]` = dml_type node |
| `dml_type` | DML keyword | `.text` = "insert" / "update" / "delete" / "upsert" / "merge" / "undelete" |
| `method_invocation` | Method call | `object` (field), `name` (field), `arguments` (field) |
| `binary_expression` | Comparisons and logic | `left` (field), `right` (field), `operator` (field) |
| `field_access` | `obj.field` access | `object` (field), `field` (field) |
| `object_creation_expression` | `new Type(...)` | `type` (field) = type name |
| `type_list` | Interface list after `implements` | namedChildren: `type_identifier`, `scoped_type_identifier` |
| `type_identifier` | Simple type name | `.text` = class/interface name |
| `scoped_type_identifier` | Dotted type name `NS.Type` | `.text` = full dotted name |
| `trigger_declaration` | Trigger definition | `name` (field), `object` (field), `trigger_event` children, `trigger_body` |
| `trigger_event` | before insert / after update etc | `.text` = full event string |

---

## Validated Salesforce XML Structures

### field-meta.xml (CustomField) — verified live against dreamhouse-lwc
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <label>Status</label>
    <type>Picklist</type>
    <required>false</required>
    <trackFeedHistory>true</trackFeedHistory>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value>
                <fullName>Active</fullName>
                <default>false</default>
                <label>Active</label>
            </value>
        </valueSetDefinition>
    </valueSet>
</CustomField>

<!-- Formula field: -->
<CustomField xmlns="...">
    <fullName>Days_On_Market__c</fullName>
    <type>Number</type>
    <formula>TODAY() - Date_Listed__c</formula>
    <scale>0</scale>
</CustomField>

<!-- Global value set reference: -->
<CustomField xmlns="...">
    <fullName>Priority__c</fullName>
    <type>Picklist</type>
    <valueSet>
        <valueSetName>Priority</valueSetName>  <!-- references GlobalValueSet -->
    </valueSet>
</CustomField>
```

### flow-meta.xml key element structure — verified against real production flows
```xml
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My Flow</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Case</object>
        <recordTriggerType>Update</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
        <!-- For Platform Event flows: -->
        <!-- <triggerType>PlatformEvent</triggerType> -->
        <!-- <object>My_Event__e</object> -->
    </start>
    <decisions>
        <name>Check_Status</name>
        <rules>
            <name>Is_Active</name>
            <conditions>
                <leftValueReference>$Record.Status__c</leftValueReference>
                <operator>EqualTo</operator>
                <rightValue>
                    <stringValue>Active</stringValue>
                </rightValue>
            </conditions>
        </rules>
    </decisions>
    <actionCalls>
        <name>Call_Apex</name>
        <actionName>MyApexClass</actionName>
        <actionType>apex</actionType>
    </actionCalls>
    <subflows>
        <name>Call_Subflow</name>
        <flowName>ChildFlowApiName</flowName>
    </subflows>
    <recordLookups>
        <name>Get_Account</name>
        <object>Account</object>
        <outputAssignments>
            <assignToReference>accountVar</assignToReference>
            <field>Status__c</field>
        </outputAssignments>
    </recordLookups>
    <recordCreates>
        <name>Create_Task</name>
        <object>Task</object>
        <inputAssignments>
            <field>Subject</field>
        </inputAssignments>
    </recordCreates>
</Flow>
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| tree-sitter-sfapex native Node bindings | web-tree-sitter-sfapex WASM | Phase 2 decision | No Xcode/node-gyp required; same grammar, same node types |
| falkordblite (embedded) | falkordb (Redis-protocol) | Phase 1 | Requires running server; asyncio queue already built |
| qdrant search() API | qdrant query_points() API | qdrant-client 1.17.x | search() removed; use query_points() |
| Kùzu graph DB | FalkorDB | Oct 2025 | Kùzu abandoned; FalkorDB is production-ready GraphRAG replacement |

**Deprecated/outdated:**
- `soql_query` CST node type: does not exist in sfapex grammar; use `query_expression` → `soql_query_body`
- `childForFieldName('dml_type')` on dml_expression: returns undefined; use `namedChildren[0]`
- `root.hasError()` method call style: use property `root.hasError` (no parens)

---

## Schema Index JSON Format for Schema Filter Agent

The schema index should be designed to minimize tokens while maximizing agent utility:

```json
{
  "generated_at": "2026-04-04T10:00:00Z",
  "node_types": {
    "ApexClass": {
      "properties": ["qualifiedName", "name", "superclass", "interfaces", "isTest", "sourceFile", "lastIngestedAt"],
      "description": "Apex class or abstract class. qualifiedName = fully qualified class name."
    },
    "ApexMethod": {
      "properties": ["qualifiedName", "name", "visibility", "isStatic", "returnType", "sourceFile"],
      "description": "Method within an ApexClass or ApexTrigger."
    },
    "SFObject": {
      "properties": ["qualifiedName", "name", "label", "isCustom", "namespace"],
      "description": "Salesforce SObject (standard or custom). Custom objects end in __c."
    },
    "SFField": {
      "properties": ["qualifiedName", "name", "dataType", "isFormula", "formulaText", "isRequired"],
      "description": "Field on an SFObject. Picklist fields have dataType=Picklist."
    },
    "Flow": {
      "properties": ["qualifiedName", "label", "processType", "triggerType", "triggerObject", "isActive"],
      "description": "Salesforce Flow. triggerType: RecordAfterSave, PlatformEvent, Scheduled."
    }
  },
  "relationship_types": [
    "EXTENDS", "IMPLEMENTS", "CALLS_CLASS_METHOD", "READS_SOQL", "PERFORMS_DML",
    "READS_LABEL", "PUBLISHES_EVENT", "SUBSCRIBES_TO_EVENT", "CALLS_EXTERNAL",
    "HAS_FIELD", "FIELD_HAS_VALUE", "FORMULA_DEPENDS_ON", "FLOW_CALLS_APEX",
    "FLOW_CALLS_SUBFLOW", "FLOW_READS_SOBJECT", "FLOW_RESOLVES_LABEL"
  ],
  "edge_categories": {
    "DATA_FLOW": "Node reads/writes data from/to another node",
    "CONTROL_FLOW": "Node triggers or calls another node",
    "CONFIG": "Node references configuration (labels, settings, metadata)",
    "STRUCTURAL": "Node is part of another node (field of object, method of class)"
  }
}
```

---

## Node Type → qualifiedName Convention

Consistent `qualifiedName` keys prevent merge collisions:

| Node Type | qualifiedName Format | Example |
|-----------|---------------------|---------|
| ApexClass | `ClassName` | `OrderService` |
| ApexMethod | `ClassName.methodName` | `OrderService.process` |
| ApexTrigger | `TriggerName` | `AccountTrigger` |
| SFObject | `ObjectApiName` | `Account`, `Order__c` |
| SFField | `ObjectApiName.FieldApiName` | `Account.Status__c` |
| SFPicklistValue | `ObjectApiName.FieldApiName.ValueName` | `Account.Status__c.Active` |
| GlobalValueSet | `GlobalValueSetName` | `Priority` |
| CustomLabel | `LabelApiName` | `OrderStatus` |
| CustomSetting | `SettingApiName` | `OrgSettings__c` |
| CustomMetadataType | `TypeApiName` | `Config__mdt` |
| CustomMetadataRecord | `TypeApiName.RecordDeveloperName` | `Config__mdt.Default` |
| Flow | `FlowApiName` | `Case_Escalation_Flow` |
| FlowElement | `FlowApiName.ElementName` | `Case_Escalation_Flow.Check_Status` |
| PlatformEvent | `EventApiName` | `Order_Completed__e` |
| ExternalNamespace | `NamespacePrefix` | `vlocity_cmt`, `SBQQ__` |
| LWCComponent | `ComponentApiName` | `c/orderCard` |

---

## Two-Phase Write Order (INGEST-02)

Process files in this explicit order to ensure nodes exist before edges reference them:

1. **SFObject** (`.object-meta.xml`) — foundation of all field/picklist/event nodes
2. **SFField** (`.field-meta.xml`) — depends on SFObject node existence
3. **SFPicklistValue** / **GlobalValueSet** — depends on SFField
4. **CustomLabel** (`.labels-meta.xml` or `.label-meta.xml`) — referenced by Apex/Flow
5. **CustomSetting** (custom objects ending `__c` in `customSettings/` path)
6. **CustomMetadataType** + **CustomMetadataRecord** (`.object-meta.xml` with `__mdt`)
7. **PlatformEvent** (`__e` objects)
8. **ApexClass** / **ApexMethod** — SOQL/DML edge targets SFObject
9. **ApexTrigger** — same as ApexClass ordering
10. **LWCComponent** — references Apex classes and SFFields
11. **Flow** + **FlowElement** — references SFObject, Apex, other Flows, CustomLabels
12. **IntegrationProcedure** / **DataRaptor** / **OmniScript** — references SFObjects (Phase 4)
13. **ValidationRule** / **Workflow** — references SFObject/SFField

---

## Open Questions

1. **CustomLabel XML format (decomposed vs. monolithic)**
   - What we know: SFDX projects can use either single `CustomLabels.labels-meta.xml` or decomposed individual `*.label-meta.xml` files
   - What's unclear: Which format a given org export uses depends on the `sf` CLI version and org settings
   - Recommendation: Handle both; detect by checking if file ends in `.labels-meta.xml` (monolithic, iterate `<labels>` children) or `.label-meta.xml` (single label file)

2. **GlobalValueSet file format and path**
   - What we know: Global value sets are stored in `globalValueSets/` directory as `ValueSetName.globalValueSet-meta.xml`
   - What's unclear: Exact XML structure not verified against live files in this session
   - Recommendation: XPath pattern: `<GlobalValueSet>/values/customValue/fullName` — test with a real export before coding

3. **Flow Publish Platform Event action detection**
   - What we know: `actionType` in actionCalls can be `publishPlatformEvent`; but some flows use standard email/legacy patterns
   - What's unclear: All valid actionType values for platform event publishing
   - Recommendation: Match on `actionType == 'publishPlatformEvent'` AND `actionName.endsWith('__e')`

4. **YAML config file format for Dynamic Accessor Registry (APEX-11)**
   - What we know: Maps utility methods (e.g., `SObjectUtils.getFieldValue`) to READS_FIELD/WRITES_FIELD with field-argument position
   - What's unclear: Exact YAML schema not defined yet
   - Recommendation: Define minimal schema: `{className: {methodName: {argIndex: 0, edgeType: "READS_FIELD"}}}` and load at IngestionService init

---

## Sources

### Primary (HIGH confidence)
- `web-tree-sitter-sfapex` 2.4.1 WASM grammar — all CST node types verified by executing live probe scripts against the installed package in this session (2026-04-04)
- `worker.js` + `pool.py` + `falkordb_store.py` + `manifest_store.py` — read directly from codebase; all API details confirmed
- [docs.falkordb.com/cypher/procedures.html](https://docs.falkordb.com/cypher/procedures.html) — CALL db.labels(), db.propertyKeys(), db.relationshipTypes()
- [docs.falkordb.com/cypher/merge.html](https://docs.falkordb.com/cypher/merge.html) — MERGE syntax and ON CREATE/ON MATCH
- [docs.falkordb.com/cypher/indexing/range-index.html](https://docs.falkordb.com/cypher/indexing/range-index.html) — CREATE INDEX FOR syntax
- dreamhouse-lwc field XML (`Status__c.field-meta.xml`, `Days_On_Market__c.field-meta.xml`) — verified live via GitHub raw URLs
- flowratech/flowsnippet-free-templates real flow XML — complete XML structure verified including decisions/conditions/actionCalls/subflows

### Secondary (MEDIUM confidence)
- MissingEntryCriteriaFinder.py (SalesforceFlowAnalysis repo) — confirms ElementTree namespace pattern `{http://soap.sforce.com/2006/04/metadata}` for Flow XML parsing
- [github.com/pgonzaleznetwork/forcemula](https://github.com/pgonzaleznetwork/forcemula) — confirms forcemula is JS-only; regex approach appropriate for Python

### Tertiary (LOW confidence — flag for validation)
- GlobalValueSet XML structure: not verified against live file; schema inferred from Salesforce docs search results

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages already installed; verified against live worker.js execution
- Architecture patterns: HIGH — CST node types verified live; XML structures verified from real files
- Pitfalls: HIGH — all verified by probing WASM API in this session
- FalkorDB Cypher patterns: HIGH — existing `merge_node()` and `merge_edge()` already work; verified by Phase 1/2 test suite

**Research date:** 2026-04-04
**Valid until:** 2026-07-04 (3 months — tree-sitter-sfapex is stable; Salesforce XML format is decades-stable; FalkorDB API stable since 1.6.0)
