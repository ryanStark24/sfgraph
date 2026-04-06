"""Schema constants for the Salesforce Org Graph.

These are the canonical node type names, edge type names, and category values
used throughout the ingestion pipeline. Every parser and the IngestionService
import from this module — never hardcode strings elsewhere.
"""
from __future__ import annotations

# GRAPH-01: All 23 node types from design doc §7.1
NODE_TYPES: list[str] = [
    "SFObject",
    "SFField",
    "ApexClass",
    "ApexMethod",
    "ApexTrigger",
    "LWCComponent",
    "LWCProperty",
    "Flow",
    "FlowElement",
    "IntegrationProcedure",
    "IPElement",
    "IPVariable",
    "OmniScript",
    "DataRaptor",
    "CustomLabel",
    "CustomSetting",
    "CustomMetadataType",
    "CustomMetadataRecord",
    "CustomMetadataField",
    "SFPicklistValue",
    "GlobalValueSet",
    "PlatformEvent",
    "ExternalNamespace",
]

# INGEST-02: Phase 1 node write order
NODE_WRITE_ORDER: list[str] = [
    "SFObject",
    "SFField",
    "CustomLabel",
    "CustomSetting",
    "CustomMetadataType",
    "CustomMetadataRecord",
    "CustomMetadataField",
    "ApexClass",
    "ApexMethod",
    "ApexTrigger",
    "LWCComponent",
    "LWCProperty",
    "Flow",
    "FlowElement",
    "IntegrationProcedure",
    "IPElement",
    "IPVariable",
    "OmniScript",
    "DataRaptor",
    "SFPicklistValue",
    "GlobalValueSet",
    "PlatformEvent",
    "ExternalNamespace",
]

# GRAPH-03: Exactly these four categories
EDGE_CATEGORIES: frozenset[str] = frozenset({"DATA_FLOW", "CONTROL_FLOW", "CONFIG", "STRUCTURAL"})

# GRAPH-02: All edge relationship type names
EDGE_TYPES: list[str] = [
    # Structural
    "EXTENDS",
    "IMPLEMENTS",
    "HAS_FIELD",
    "HAS_METHOD",
    "FIELD_HAS_VALUE",
    "GLOBAL_VALUE_SET_HAS_VALUE",
    "FIELD_USES_GLOBAL_SET",
    # Data flow — Apex
    "CALLS",
    "CALLS_EXTERNAL",
    "READS_FIELD",
    "WRITES_FIELD",
    "READS_CUSTOM_SETTING",
    "READS_CUSTOM_METADATA",
    "READS_LABEL",
    "READS_VALUE",
    "PUBLISHES_EVENT",
    "SUBSCRIBES_TO_EVENT",
    "QUERIES_OBJECT",
    "DML_ON",
    "FORMULA_DEPENDS_ON",
    # Flow edges
    "FLOW_READS_FIELD",
    "FLOW_WRITES_FIELD",
    "FLOW_CALLS_APEX",
    "FLOW_CALLS_SUBFLOW",
    "FLOW_RESOLVES_LABEL",
    "FLOW_READS_VALUE",
    # LWC edges (Phase 4)
    "IMPORTS_APEX",
    "WIRES_ADAPTER",
    "CONTAINS_CHILD",
    "LWC_RESOLVES_LABEL",
    # Vlocity (Phase 4)
    "DR_READS",
    "DR_WRITES",
    "DR_TRANSFORMS",
    "REFERENCES_STEP_OUTPUT",
]

# Human-readable descriptions for schema_index.json (INGEST-09)
NODE_TYPE_DESCRIPTIONS: dict[str, str] = {
    "SFObject": "A Salesforce SObject (standard or custom object)",
    "SFField": "A field on a Salesforce SObject",
    "ApexClass": "An Apex class",
    "ApexMethod": "A method within an Apex class",
    "ApexTrigger": "An Apex trigger on an SObject",
    "LWCComponent": "A Lightning Web Component",
    "LWCProperty": "A tracked/api property on an LWC",
    "Flow": "A Salesforce Flow (AutoLaunchedFlow, ScreenFlow, etc.)",
    "FlowElement": "An element within a Flow (RecordLookup, Decision, ActionCall, etc.)",
    "IntegrationProcedure": "A Vlocity IntegrationProcedure",
    "IPElement": "A step element within an IntegrationProcedure",
    "IPVariable": "A variable within an IntegrationProcedure",
    "OmniScript": "A Vlocity OmniScript",
    "DataRaptor": "A Vlocity DataRaptor (Extract, Load, or Transform)",
    "CustomLabel": "A Salesforce Custom Label",
    "CustomSetting": "A Salesforce Custom Setting object",
    "CustomMetadataType": "A Custom Metadata Type (__mdt) definition",
    "CustomMetadataRecord": "A record of a Custom Metadata Type",
    "CustomMetadataField": "A field on a Custom Metadata Type",
    "SFPicklistValue": "A picklist value on an SFField",
    "GlobalValueSet": "A globally shared picklist value set",
    "PlatformEvent": "A Salesforce Platform Event (__e object)",
    "ExternalNamespace": "A stub node representing an unresolvable external namespace reference",
}
