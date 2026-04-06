"""Tests for FlowParser — FLOW-01 through FLOW-08."""
from __future__ import annotations

from pathlib import Path

import pytest

from sfgraph.ingestion.constants import EDGE_CATEGORIES
from sfgraph.parser.flow_parser import FlowParser, parse_flow_xml

FIXTURE_FLOW = Path("tests/fixtures/metadata/flows/Simple_Account_Update.flow-meta.xml")


@pytest.fixture(scope="module")
def parsed_fixture():
    return parse_flow_xml(str(FIXTURE_FLOW))


@pytest.fixture(scope="module")
def flow_nodes(parsed_fixture):
    nodes, _ = parsed_fixture
    return nodes


@pytest.fixture(scope="module")
def flow_edges(parsed_fixture):
    _, edges = parsed_fixture
    return edges


def test_flow_node_created(flow_nodes):
    flow_facts = [n for n in flow_nodes if n.label == "Flow"]
    assert len(flow_facts) == 1
    assert flow_facts[0].key_props["qualifiedName"] == "Simple_Account_Update"


def test_flow_node_process_type(flow_nodes):
    flow = next(n for n in flow_nodes if n.label == "Flow")
    assert flow.all_props["processType"] == "AutoLaunchedFlow"


def test_flow_node_is_active(flow_nodes):
    flow = next(n for n in flow_nodes if n.label == "Flow")
    assert flow.all_props["isActive"] is True


def test_flow_node_trigger_object(flow_nodes):
    flow = next(n for n in flow_nodes if n.label == "Flow")
    assert flow.all_props["triggerObject"] == "Account"


def test_record_update_element_node_created(flow_nodes):
    elem_nodes = [n for n in flow_nodes if n.label == "FlowElement"]
    elem_names = {n.all_props["name"] for n in elem_nodes}
    assert "Update_Account_Status" in elem_names


def test_record_update_element_has_op_type(flow_nodes):
    elem = next(
        n
        for n in flow_nodes
        if n.label == "FlowElement" and n.all_props.get("name") == "Update_Account_Status"
    )
    assert elem.all_props["opType"] == "recordUpdates"


def test_record_update_produces_flow_writes_field_edge(flow_edges):
    write_edges = [e for e in flow_edges if e.rel_type == "FLOW_WRITES_FIELD"]
    assert write_edges
    field_names = {e.dst_qualified_name for e in write_edges}
    assert any("Status__c" in n for n in field_names)
    for edge in write_edges:
        assert edge.edgeCategory == "DATA_FLOW"
        assert edge.confidence >= 0.9


def test_decision_condition_produces_reads_field_edge(flow_edges):
    reads_edges = [e for e in flow_edges if e.rel_type == "FLOW_READS_FIELD"]
    assert reads_edges
    field_refs = {e.dst_qualified_name for e in reads_edges}
    assert any("Status__c" in ref for ref in field_refs)


def test_decision_picklist_comparison_produces_reads_value(flow_edges):
    rv_edges = [e for e in flow_edges if e.rel_type == "FLOW_READS_VALUE"]
    assert rv_edges
    snippets = " ".join(e.contextSnippet for e in rv_edges)
    assert "Active" in snippets


def test_apex_action_call_produces_flow_calls_apex(flow_edges):
    apex_edges = [e for e in flow_edges if e.rel_type == "FLOW_CALLS_APEX"]
    assert apex_edges
    targets = {e.dst_qualified_name for e in apex_edges}
    assert "AccountService" in targets
    for edge in apex_edges:
        assert edge.edgeCategory == "CONTROL_FLOW"
        assert edge.confidence >= 0.9


def test_subflow_reference_produces_flow_calls_subflow(flow_edges):
    sub_edges = [e for e in flow_edges if e.rel_type == "FLOW_CALLS_SUBFLOW"]
    assert sub_edges
    targets = {e.dst_qualified_name for e in sub_edges}
    assert "Child_Account_Validation" in targets
    for edge in sub_edges:
        assert edge.edgeCategory == "CONTROL_FLOW"
        assert edge.confidence == 1.0


def test_label_reference_produces_flow_resolves_label(flow_edges):
    label_edges = [e for e in flow_edges if e.rel_type == "FLOW_RESOLVES_LABEL"]
    assert label_edges
    targets = {e.dst_qualified_name for e in label_edges}
    assert "CustomLabel.Account_Status_Label" in targets
    for edge in label_edges:
        assert edge.edgeCategory == "CONFIG"
        assert edge.confidence == 1.0


def test_platform_event_subscription(tmp_path):
    content = """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<Flow xmlns=\"http://soap.sforce.com/2006/04/metadata\">
    <apiVersion>60.0</apiVersion>
    <label>Account Event Listener</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Account_Updated__e</object>
        <triggerType>PlatformEvent</triggerType>
    </start>
</Flow>"""
    flow_file = tmp_path / "Account_Event_Listener.flow-meta.xml"
    flow_file.write_text(content, encoding="utf-8")
    _, edges = parse_flow_xml(str(flow_file))
    sub_edges = [e for e in edges if e.rel_type == "SUBSCRIBES_TO_EVENT"]
    assert len(sub_edges) == 1
    assert sub_edges[0].dst_qualified_name == "Account_Updated__e"
    assert sub_edges[0].dst_label == "PlatformEvent"
    assert sub_edges[0].edgeCategory == "DATA_FLOW"


def test_publish_platform_event_action(tmp_path):
    content = """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<Flow xmlns=\"http://soap.sforce.com/2006/04/metadata\">
    <apiVersion>60.0</apiVersion>
    <label>Publish Event Flow</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <actionCalls>
        <name>Publish_Account_Event</name>
        <actionName>Account_Updated__e</actionName>
        <actionType>publishPlatformEvent</actionType>
    </actionCalls>
</Flow>"""
    flow_file = tmp_path / "Publish_Event_Flow.flow-meta.xml"
    flow_file.write_text(content, encoding="utf-8")
    _, edges = parse_flow_xml(str(flow_file))
    pub_edges = [e for e in edges if e.rel_type == "PUBLISHES_EVENT"]
    assert pub_edges
    assert any("Account_Updated__e" in e.dst_qualified_name for e in pub_edges)


def test_flow_node_source_attribution(flow_nodes):
    for node in flow_nodes:
        assert node.sourceFile != ""
        assert node.parserType == "xml_flow"
        assert "sourceFile" in node.all_props
        assert "parserType" in node.all_props
        assert "lastIngestedAt" in node.all_props


def test_all_edge_categories_valid(flow_edges):
    for edge in flow_edges:
        assert edge.edgeCategory in EDGE_CATEGORIES


def test_flow_parser_scan_dir():
    parser = FlowParser()
    nodes, _ = parser.parse_flows_dir("tests/fixtures/metadata/flows")
    flow_nodes = [n for n in nodes if n.label == "Flow"]
    assert len(flow_nodes) >= 1
