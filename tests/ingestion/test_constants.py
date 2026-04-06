"""Tests for schema constants and Pydantic models. GRAPH-01, GRAPH-03, INGEST-04, INGEST-06."""
import pytest
from pydantic import ValidationError

from sfgraph.ingestion.constants import (
    NODE_TYPES, NODE_WRITE_ORDER, EDGE_CATEGORIES, EDGE_TYPES, NODE_TYPE_DESCRIPTIONS
)
from sfgraph.ingestion.models import NodeFact, EdgeFact, IngestionSummary


def test_node_types_count():
    """GRAPH-01: canonical node type count."""
    assert len(NODE_TYPES) == 24

def test_node_types_contains_all_required():
    required = {
        "SFObject", "SFField", "ApexClass", "ApexMethod", "ApexTrigger",
        "LWCComponent", "LWCProperty", "Flow", "FlowElement",
        "IntegrationProcedure", "IPElement", "IPVariable", "OmniScript",
        "DataRaptor", "VlocityDataPack", "CustomLabel", "CustomSetting", "CustomMetadataType",
        "CustomMetadataRecord", "CustomMetadataField", "SFPicklistValue",
        "GlobalValueSet", "PlatformEvent", "ExternalNamespace",
    }
    assert required == set(NODE_TYPES)

def test_node_write_order_contains_all_node_types():
    """INGEST-02: write order must include all node types."""
    assert set(NODE_WRITE_ORDER) == set(NODE_TYPES)
    assert len(NODE_WRITE_ORDER) == 24

def test_node_write_order_sfobject_first():
    """SFObject must be first so fields can reference it."""
    assert NODE_WRITE_ORDER[0] == "SFObject"

def test_edge_categories_exactly_four():
    """GRAPH-03: exactly four categories."""
    assert EDGE_CATEGORIES == frozenset({"DATA_FLOW", "CONTROL_FLOW", "CONFIG", "STRUCTURAL"})

def test_node_type_descriptions_covers_all():
    assert set(NODE_TYPE_DESCRIPTIONS.keys()) == set(NODE_TYPES)

# NodeFact model tests
def test_node_fact_requires_source_file():
    with pytest.raises(ValidationError):
        NodeFact(
            label="ApexClass",
            key_props={"qualifiedName": "AccountService"},
            all_props={"name": "AccountService"},
            sourceFile="",   # empty string passes Pydantic; omit entirely to test required
            parserType="apex_cst",
        )

def test_node_fact_injects_attribution_into_all_props():
    fact = NodeFact(
        label="ApexClass",
        key_props={"qualifiedName": "AccountService"},
        all_props={"name": "AccountService"},
        sourceFile="classes/AccountService.cls",
        lineNumber=1,
        parserType="apex_cst",
    )
    assert fact.all_props["sourceFile"] == "classes/AccountService.cls"
    assert fact.all_props["parserType"] == "apex_cst"
    assert "lastIngestedAt" in fact.all_props

def test_node_fact_auto_sets_last_ingested_at():
    fact = NodeFact(
        label="ApexClass",
        key_props={"qualifiedName": "Foo"},
        all_props={},
        sourceFile="classes/Foo.cls",
        parserType="apex_cst",
    )
    assert fact.lastIngestedAt != ""
    assert "T" in fact.lastIngestedAt  # ISO 8601 has T separator

# EdgeFact model tests
def test_edge_fact_rejects_invalid_category():
    with pytest.raises(ValidationError):
        EdgeFact(
            src_qualified_name="AccountService",
            src_label="ApexClass",
            rel_type="CALLS",
            dst_qualified_name="ContactService",
            dst_label="ApexClass",
            confidence=0.9,
            resolutionMethod="cst",
            edgeCategory="INVALID",
        )

def test_edge_fact_accepts_all_valid_categories():
    for cat in ["DATA_FLOW", "CONTROL_FLOW", "CONFIG", "STRUCTURAL"]:
        ef = EdgeFact(
            src_qualified_name="A", src_label="ApexClass",
            rel_type="CALLS", dst_qualified_name="B", dst_label="ApexClass",
            confidence=0.9, resolutionMethod="cst", edgeCategory=cat,
        )
        assert ef.edgeCategory == cat

def test_edge_fact_rejects_out_of_range_confidence():
    with pytest.raises(ValidationError):
        EdgeFact(
            src_qualified_name="A", src_label="ApexClass",
            rel_type="CALLS", dst_qualified_name="B", dst_label="ApexClass",
            confidence=1.5, resolutionMethod="cst", edgeCategory="DATA_FLOW",
        )

def test_ingestion_summary_total_nodes():
    summary = IngestionSummary(
        run_id="r1", export_dir="/tmp/export", duration_seconds=1.5,
        node_counts_by_type={"ApexClass": 10, "SFField": 20},
        edge_count=5, parse_failures=[], orphaned_edges=0, warnings=[],
    )
    assert summary.total_nodes == 30
