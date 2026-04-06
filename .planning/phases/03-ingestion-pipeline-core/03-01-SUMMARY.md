---
phase: "03"
plan: "01"
subsystem: ingestion
tags: [constants, models, pydantic, fixtures, schema]
dependency_graph:
  requires: []
  provides: [sfgraph.ingestion.constants, sfgraph.ingestion.models, tests/fixtures/metadata]
  affects: [all Phase 3 parsers, IngestionService]
tech_stack:
  added: [pydantic field_validator, pydantic model_validator]
  patterns: [schema constants module, Pydantic interchange models, synthetic fixture tree]
key_files:
  created:
    - src/sfgraph/ingestion/__init__.py
    - src/sfgraph/ingestion/constants.py
    - src/sfgraph/ingestion/models.py
    - tests/ingestion/__init__.py
    - tests/ingestion/test_constants.py
    - tests/fixtures/metadata/objects/Account/Account.object-meta.xml
    - tests/fixtures/metadata/objects/Account/fields/Status__c.field-meta.xml
    - tests/fixtures/metadata/objects/Account/fields/DaysOnMarket__c.field-meta.xml
    - tests/fixtures/metadata/flows/Simple_Account_Update.flow-meta.xml
    - tests/fixtures/metadata/classes/AccountService.cls
    - tests/fixtures/metadata/classes/AccountService.cls-meta.xml
  modified: []
decisions:
  - "Added @field_validator('sourceFile') to NodeFact to reject empty strings — Pydantic does not reject empty str by default but test_node_fact_requires_source_file requires ValidationError on sourceFile=''"
  - "NODE_WRITE_ORDER puts SFObject first so SFField nodes can reference their parent object during ingestion"
  - "EDGE_CATEGORIES is frozenset (not list) to enforce uniqueness and immutability at the constant level"
metrics:
  duration: "2 min"
  completed_date: "2026-04-06"
  tasks_completed: 2
  files_created: 11
---

# Phase 3 Plan 01: Schema Constants, Models, and Fixture Files Summary

**One-liner:** Pydantic NodeFact/EdgeFact models with mandatory source attribution plus 23-node-type schema constants and a synthetic Salesforce metadata fixture tree covering objects, fields, flows, and Apex.

## What Was Built

### Task 1: Ingestion package skeleton + schema constants + Pydantic models

**`src/sfgraph/ingestion/constants.py`**
- `NODE_TYPES`: 23 canonical node type names (GRAPH-01)
- `NODE_WRITE_ORDER`: same 23 types in dependency-safe write order, SFObject first (INGEST-02)
- `EDGE_CATEGORIES`: frozenset of exactly 4 categories — DATA_FLOW, CONTROL_FLOW, CONFIG, STRUCTURAL (GRAPH-03)
- `EDGE_TYPES`: 34 edge relationship type names (GRAPH-02)
- `NODE_TYPE_DESCRIPTIONS`: human-readable descriptions for schema_index.json (INGEST-09)

**`src/sfgraph/ingestion/models.py`**
- `NodeFact`: Pydantic BaseModel for parsed nodes. Enforces non-empty sourceFile, auto-injects lastIngestedAt (ISO 8601 UTC), copies source attribution into all_props via model_validator.
- `EdgeFact`: Pydantic BaseModel for parsed edges. Validates edgeCategory against EDGE_CATEGORIES, validates confidence in [0.0, 1.0]. Provides to_merge_props() helper.
- `IngestionSummary`: Returned by IngestionService.ingest() (INGEST-08). total_nodes computed property sums node_counts_by_type.

### Task 2: Synthetic metadata fixture tree

Six files covering all Phase 3 parser scenarios:
- **Account.object-meta.xml**: minimal SObject for object parser tests
- **Status__c.field-meta.xml**: Picklist field with inline valueSet (2 values: Active, Inactive)
- **DaysOnMarket__c.field-meta.xml**: formula Number field — exercises formula dependency extraction
- **Simple_Account_Update.flow-meta.xml**: AutoLaunchedFlow covering recordUpdate (FLOW_WRITES_FIELD), actionCall to Apex (FLOW_CALLS_APEX), subflow call (FLOW_CALLS_SUBFLOW), label reference (FLOW_RESOLVES_LABEL), decision element
- **AccountService.cls**: Apex class with SOQL (QUERIES_OBJECT, READS_FIELD), DML update+insert (DML_ON, WRITES_FIELD), cross-class call (CALLS), label access (READS_LABEL), EventBus.publish (PUBLISHES_EVENT), picklist comparison
- **AccountService.cls-meta.xml**: companion metadata file

## Test Results

```
tests/ingestion/test_constants.py — 13/13 passed

test_node_types_count                           PASSED
test_node_types_contains_all_required           PASSED
test_node_write_order_contains_all_node_types   PASSED
test_node_write_order_sfobject_first            PASSED
test_edge_categories_exactly_four               PASSED
test_node_type_descriptions_covers_all          PASSED
test_node_fact_requires_source_file             PASSED
test_node_fact_injects_attribution_into_all_props PASSED
test_node_fact_auto_sets_last_ingested_at       PASSED
test_edge_fact_rejects_invalid_category         PASSED
test_edge_fact_accepts_all_valid_categories     PASSED
test_edge_fact_rejects_out_of_range_confidence  PASSED
test_ingestion_summary_total_nodes              PASSED

Full non-integration suite: 85 passed, 6 deselected — no regressions
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing validation] Added @field_validator for empty sourceFile on NodeFact**
- **Found during:** Task 1 execution (plan note warned about this)
- **Issue:** Pydantic does not reject empty string `""` for `str` fields by default. The test `test_node_fact_requires_source_file` passes `sourceFile=""` and expects a `ValidationError`. Without the validator, Pydantic accepts the empty string silently and the test fails.
- **Fix:** Added `@field_validator("sourceFile")` that raises `ValueError("sourceFile must not be empty")` when value is falsy.
- **Files modified:** `src/sfgraph/ingestion/models.py`
- **Commit:** 0f3ff51

## Self-Check: PASSED

Files exist:
- FOUND: src/sfgraph/ingestion/__init__.py
- FOUND: src/sfgraph/ingestion/constants.py
- FOUND: src/sfgraph/ingestion/models.py
- FOUND: tests/ingestion/__init__.py
- FOUND: tests/ingestion/test_constants.py
- FOUND: tests/fixtures/metadata/objects/Account/Account.object-meta.xml
- FOUND: tests/fixtures/metadata/flows/Simple_Account_Update.flow-meta.xml
- FOUND: tests/fixtures/metadata/classes/AccountService.cls

Commits exist:
- 0f3ff51: feat(03-01): add ingestion package skeleton, schema constants, and Pydantic models
- 2a542f7: chore(03-01): add synthetic metadata fixture tree for Phase 3 ingestion tests
