---
phase: "03"
plan: "02"
subsystem: parser
tags: [xml-parser, object-metadata, salesforce, ingestion]
dependency_graph:
  requires: [src/sfgraph/ingestion/models.py, src/sfgraph/ingestion/constants.py]
  provides: [src/sfgraph/parser/object_parser.py]
  affects: [IngestionService (03-05), ParseDispatcher (02-03)]
tech_stack:
  added: []
  patterns: [xml.etree.ElementTree, stdlib-only XML parsing, NodeFact/EdgeFact interchange]
key_files:
  created:
    - src/sfgraph/parser/object_parser.py
    - tests/parser/test_object_parser.py
  modified: []
decisions:
  - "Use _tag() helper for all ElementTree find/findtext calls — bare tag names silently return None with namespaced XML"
  - "Detect object node type from directory name (__e, __mdt) before checking XML content (customSettingsType)"
  - "Formula field regex skips known Salesforce formula functions (TODAY, NOW, IF, etc.) to avoid spurious edges"
  - "parse_field_xml() is exposed as a public function (not just ObjectParser method) to allow per-file parsing by IngestionService"
metrics:
  duration_seconds: 112
  completed_date: "2026-04-06"
  tasks_completed: 1
  files_created: 2
---

# Phase 3 Plan 02: Object XML Parser Summary

**One-liner:** stdlib XML parser for Salesforce object metadata producing typed NodeFact/EdgeFact with full source attribution.

## What Was Built

`src/sfgraph/parser/object_parser.py` — a Python XML parser for Salesforce object metadata that returns `NodeFact` and `EdgeFact` lists consumed by IngestionService. Uses only `xml.etree.ElementTree` (stdlib, no extra dependencies).

### Functions / Classes

| Symbol | Purpose |
|--------|---------|
| `parse_object_dir(object_dir)` | Parse an object directory (e.g. `objects/Account/`) — returns SFObject/PlatformEvent/CustomSetting/CustomMetadataType node + all field nodes/edges |
| `parse_field_xml(field_path, object_api_name)` | Parse a single `.field-meta.xml` — SFField node + picklist values + formula edges |
| `parse_labels_xml(labels_path)` | Parse `.labels-meta.xml` (multi-label) or `.label-meta.xml` (single-label) |
| `ObjectParser.parse_objects_dir(objects_dir)` | High-level entrypoint: iterates all subdirectories + picks up labels/ directory |

### Requirements Coverage

| Requirement | Status |
|-------------|--------|
| OBJ-01: SFObject NodeFact from Account.object-meta.xml | DONE |
| OBJ-02: SFField + SFPicklistValue NodeFacts from Status__c | DONE |
| OBJ-03: FIELD_HAS_VALUE EdgeFacts with edgeCategory=STRUCTURAL | DONE |
| OBJ-04: FIELD_USES_GLOBAL_SET edge for valueSetName fields | DONE |
| OBJ-05: PlatformEvent detection for __e directories | DONE |
| OBJ-05b: CustomSetting detection via customSettingsType element | DONE |
| OBJ-05c: CustomMetadataType detection for __mdt directories | DONE |
| OBJ-06: Formula field isFormula=True + FORMULA_DEPENDS_ON DATA_FLOW edges | DONE |
| OBJ-07: CustomLabel NodeFacts from .labels-meta.xml and .label-meta.xml | DONE |
| INGEST-04: sourceFile, lineNumber, parserType, lastIngestedAt on all NodeFacts | DONE |

## Test Results

**15/15 tests pass.** No regressions in full suite (100 passed, 6 integration skipped).

```
tests/parser/test_object_parser.py::test_sfobject_node_created PASSED
tests/parser/test_object_parser.py::test_sfobject_api_label PASSED
tests/parser/test_object_parser.py::test_sfobject_sharing_model PASSED
tests/parser/test_object_parser.py::test_sfobject_source_attribution PASSED
tests/parser/test_object_parser.py::test_status_field_node_created PASSED
tests/parser/test_object_parser.py::test_status_picklist_values_created PASSED
tests/parser/test_object_parser.py::test_field_has_value_edges PASSED
tests/parser/test_object_parser.py::test_global_value_set_edge PASSED
tests/parser/test_object_parser.py::test_platform_event_detection PASSED
tests/parser/test_object_parser.py::test_custom_setting_detection PASSED
tests/parser/test_object_parser.py::test_custom_metadata_type_detection PASSED
tests/parser/test_object_parser.py::test_formula_field_is_formula_true PASSED
tests/parser/test_object_parser.py::test_formula_depends_on_edge PASSED
tests/parser/test_object_parser.py::test_labels_xml_parse PASSED
tests/parser/test_object_parser.py::test_all_edge_categories_valid PASSED
```

## Deviations from Plan

None — plan executed exactly as written. Fixture files created by plan 03-01 were already present (`Account.object-meta.xml`, `Status__c.field-meta.xml`, `DaysOnMarket__c.field-meta.xml`), so no stubs were needed.

## Decisions Made

1. `_tag()` helper is critical — bare element names silently fail with Salesforce's namespaced XML. All find/findtext calls use it.
2. Object node type detection order: directory name suffix (`__e`, `__mdt`) checked first, then XML content (`customSettingsType`). This avoids an XML parse just to detect the common cases.
3. Formula regex skip list filters out uppercase Salesforce function tokens (`TODAY`, `NOW`, `IF`, etc.) that match the `[A-Z]` pattern but are not field references.
4. Both inline `<fields>` children in object-meta.xml AND separate `fields/*.field-meta.xml` files are parsed. This matches real Salesforce metadata layouts.

## Self-Check: PASSED

- `src/sfgraph/parser/object_parser.py` — FOUND
- `tests/parser/test_object_parser.py` — FOUND
- Commit a35f7ba — FOUND
