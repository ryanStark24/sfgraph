"""Tests for ObjectParser — OBJ-01 through OBJ-07."""
import pytest
from pathlib import Path
import xml.etree.ElementTree as ET

from sfgraph.parser.object_parser import parse_object_dir, parse_field_xml, parse_labels_xml, ObjectParser
from sfgraph.ingestion.models import NodeFact, EdgeFact
from sfgraph.ingestion.constants import EDGE_CATEGORIES

ACCOUNT_DIR = "tests/fixtures/metadata/objects/Account"
STATUS_FIELD = "tests/fixtures/metadata/objects/Account/fields/Status__c.field-meta.xml"
FORMULA_FIELD = "tests/fixtures/metadata/objects/Account/fields/DaysOnMarket__c.field-meta.xml"


@pytest.fixture(scope="module")
def account_parse():
    return parse_object_dir(ACCOUNT_DIR)


@pytest.fixture(scope="module")
def account_nodes(account_parse):
    nodes, _ = account_parse
    return nodes


@pytest.fixture(scope="module")
def account_edges(account_parse):
    _, edges = account_parse
    return edges


# OBJ-01: SFObject node
def test_sfobject_node_created(account_nodes):
    obj_nodes = [n for n in account_nodes if n.label == "SFObject"]
    assert len(obj_nodes) == 1
    assert obj_nodes[0].key_props["qualifiedName"] == "Account"


def test_sfobject_api_label(account_nodes):
    obj = next(n for n in account_nodes if n.label == "SFObject")
    assert obj.all_props["apiLabel"] == "Account"


def test_sfobject_sharing_model(account_nodes):
    obj = next(n for n in account_nodes if n.label == "SFObject")
    assert obj.all_props["sharingModel"] == "ReadWrite"


def test_sfobject_source_attribution(account_nodes):
    for n in account_nodes:
        assert n.sourceFile != ""
        assert n.parserType == "xml_object"
        assert "sourceFile" in n.all_props
        assert "lastIngestedAt" in n.all_props


# OBJ-02: SFField + SFPicklistValue nodes
def test_status_field_node_created(account_nodes):
    field_nodes = [n for n in account_nodes if n.label == "SFField"]
    field_names = {n.key_props["qualifiedName"] for n in field_nodes}
    assert "Account.Status__c" in field_names


def test_status_picklist_values_created(account_nodes):
    pv_nodes = [n for n in account_nodes if n.label == "SFPicklistValue"]
    pv_names = {n.key_props["qualifiedName"] for n in pv_nodes}
    assert "Account.Status__c.Active" in pv_names
    assert "Account.Status__c.Inactive" in pv_names


# OBJ-03: FIELD_HAS_VALUE edges
def test_field_has_value_edges(account_edges):
    fhv_edges = [e for e in account_edges if e.rel_type == "FIELD_HAS_VALUE"]
    assert len(fhv_edges) >= 2
    for e in fhv_edges:
        assert e.edgeCategory == "STRUCTURAL"
        assert e.confidence == 1.0


# OBJ-04: Global value set reference
def test_global_value_set_edge(tmp_path):
    """OBJ-04: field with valueSetName -> FIELD_USES_GLOBAL_SET edge."""
    field_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Priority__c</fullName>
    <label>Priority</label>
    <type>Picklist</type>
    <valueSet>
        <valueSetName>PrioritySet</valueSetName>
    </valueSet>
</CustomField>'''
    f = tmp_path / "Priority__c.field-meta.xml"
    f.write_text(field_xml)
    nodes, edges = parse_field_xml(str(f), "Case")
    gvs_edges = [e for e in edges if e.rel_type == "FIELD_USES_GLOBAL_SET"]
    assert len(gvs_edges) == 1
    assert gvs_edges[0].dst_qualified_name == "PrioritySet"
    assert gvs_edges[0].edgeCategory == "STRUCTURAL"


# OBJ-05: Platform event detection
def test_platform_event_detection(tmp_path):
    """OBJ-05: __e directory -> PlatformEvent node."""
    obj_dir = tmp_path / "Account_Updated__e"
    obj_dir.mkdir()
    xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Account Updated</label>
    <deploymentStatus>Deployed</deploymentStatus>
</CustomObject>'''
    (obj_dir / "Account_Updated__e.object-meta.xml").write_text(xml_content)
    nodes, edges = parse_object_dir(str(obj_dir))
    pe_nodes = [n for n in nodes if n.label == "PlatformEvent"]
    assert len(pe_nodes) == 1
    assert pe_nodes[0].key_props["qualifiedName"] == "Account_Updated__e"


def test_custom_setting_detection(tmp_path):
    """OBJ-05b: customSettingsType -> CustomSetting node."""
    obj_dir = tmp_path / "MySettings__c"
    obj_dir.mkdir()
    xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>My Settings</label>
    <customSettingsType>Hierarchy</customSettingsType>
</CustomObject>'''
    (obj_dir / "MySettings__c.object-meta.xml").write_text(xml_content)
    nodes, _ = parse_object_dir(str(obj_dir))
    cs_nodes = [n for n in nodes if n.label == "CustomSetting"]
    assert len(cs_nodes) == 1


def test_custom_metadata_type_detection(tmp_path):
    """OBJ-05c: __mdt directory -> CustomMetadataType node."""
    obj_dir = tmp_path / "FeatureFlag__mdt"
    obj_dir.mkdir()
    xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Feature Flag</label>
</CustomObject>'''
    (obj_dir / "FeatureFlag__mdt.object-meta.xml").write_text(xml_content)
    nodes, _ = parse_object_dir(str(obj_dir))
    cmt_nodes = [n for n in nodes if n.label == "CustomMetadataType"]
    assert len(cmt_nodes) == 1


# OBJ-06: Formula field
def test_formula_field_is_formula_true(account_nodes):
    formula_nodes = [n for n in account_nodes if n.label == "SFField" and
                     "DaysOnMarket__c" in n.key_props.get("qualifiedName", "")]
    assert len(formula_nodes) >= 1
    assert formula_nodes[0].all_props["isFormula"] is True


def test_formula_depends_on_edge(account_edges):
    formula_edges = [e for e in account_edges if e.rel_type == "FORMULA_DEPENDS_ON"]
    assert len(formula_edges) >= 1
    for e in formula_edges:
        assert e.edgeCategory == "DATA_FLOW"
        assert e.src_label == "SFField"
        assert e.dst_label == "SFField"
    # Should include Date_Listed__c reference
    dst_names = {e.dst_qualified_name for e in formula_edges}
    assert any("Date_Listed__c" in n for n in dst_names)


# OBJ-07: Custom labels
def test_labels_xml_parse(tmp_path):
    """OBJ-07: .labels-meta.xml -> multiple CustomLabel nodes."""
    xml_content = '''<?xml version="1.0" encoding="UTF-8"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
    <labels>
        <fullName>Account_Status_Label</fullName>
        <language>en_US</language>
        <protected>false</protected>
        <shortDescription>Account Status</shortDescription>
        <value>Account is Active</value>
    </labels>
    <labels>
        <fullName>Welcome_Message</fullName>
        <language>en_US</language>
        <protected>false</protected>
        <shortDescription>Welcome</shortDescription>
        <value>Welcome to Salesforce</value>
    </labels>
</CustomLabels>'''
    f = tmp_path / "CustomLabels.labels-meta.xml"
    f.write_text(xml_content)
    nodes, _ = parse_labels_xml(str(f))
    assert len(nodes) == 2
    qnames = {n.key_props["qualifiedName"] for n in nodes}
    assert "CustomLabel.Account_Status_Label" in qnames
    assert "CustomLabel.Welcome_Message" in qnames
    for n in nodes:
        assert n.label == "CustomLabel"
        assert n.parserType == "xml_object"


# Edge categories
def test_all_edge_categories_valid(account_edges):
    for e in account_edges:
        assert e.edgeCategory in EDGE_CATEGORIES
